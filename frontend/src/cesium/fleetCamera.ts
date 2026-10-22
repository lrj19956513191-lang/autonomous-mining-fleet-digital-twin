import { Cartesian3, Matrix4, OrthographicFrustum, PerspectiveFrustum,
  PerspectiveOffCenterFrustum, type Entity, type Viewer } from 'cesium';
import type { FleetVehicleTelemetry } from '../realtime/fleetTelemetry';
import { focusVehicle } from './camera';

type Frustum = Viewer['camera']['frustum'];
interface WorldView {
  readonly positionWC: Cartesian3;
  readonly directionWC: Cartesian3;
  readonly upWC: Cartesian3;
  readonly frustum: Frustum;
}
export interface FleetCameraCheckpoint extends WorldView {
  readonly trackedVehicleId: string | null;
  readonly trackedEntity: Entity | undefined;
}
export interface FleetCameraHandle {
  track(id: string): boolean;
  release(): void;
  locate(telemetry: FleetVehicleTelemetry): boolean;
  getTrackedVehicleId(): string | null;
  capture(): FleetCameraCheckpoint;
  restore(checkpoint: FleetCameraCheckpoint): void;
  destroy(): void;
}
export class FleetCameraError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'FleetCameraError';
  }
}
function local<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof FleetCameraError) throw cause;
    throw new FleetCameraError('Fleet camera operation failed', cause);
  }
}
function cloneFrustum(frustum: Frustum): Frustum {
  if (frustum instanceof PerspectiveFrustum || frustum instanceof PerspectiveOffCenterFrustum
    || frustum instanceof OrthographicFrustum) return frustum.clone();
  throw new FleetCameraError('Unsupported public camera frustum');
}
function sameFrustum(a: Frustum, b: Frustum): boolean {
  if (a instanceof PerspectiveFrustum && b instanceof PerspectiveFrustum) return a.equals(b);
  if (a instanceof PerspectiveOffCenterFrustum && b instanceof PerspectiveOffCenterFrustum) return a.equals(b);
  return a instanceof OrthographicFrustum && b instanceof OrthographicFrustum && a.equals(b);
}
function captureView(viewer: Viewer): WorldView {
  const camera = viewer.camera;
  return { positionWC: Cartesian3.clone(camera.positionWC), directionWC: Cartesian3.clone(camera.directionWC),
    upWC: Cartesian3.clone(camera.upWC), frustum: cloneFrustum(camera.frustum) };
}
function matchesView(viewer: Viewer, view: WorldView): boolean {
  const camera = viewer.camera;
  return Cartesian3.distance(camera.positionWC, view.positionWC) <= 0.01
    && Cartesian3.angleBetween(camera.directionWC, view.directionWC) <= 1e-6
    && Cartesian3.angleBetween(camera.upWC, view.upWC) <= 1e-6
    && sameFrustum(camera.frustum, view.frustum);
}
function restoreView(viewer: Viewer, view: WorldView, canContinue: () => boolean): boolean {
  if (!canContinue()) return false;
  viewer.camera.frustum = cloneFrustum(view.frustum);
  if (!canContinue()) return false;
  viewer.camera.setView({ destination: Cartesian3.clone(view.positionWC),
    orientation: { direction: Cartesian3.clone(view.directionWC), up: Cartesian3.clone(view.upWC) },
    endTransform: Matrix4.IDENTITY });
  if (!canContinue()) return false;
  if (!matchesView(viewer, view)) throw new FleetCameraError('Camera world view could not be restored');
  return true;
}
interface Association { id: string; entity: Entity }

export function createFleetCamera(viewer: Viewer, getOwnedEntity: (id: string) => Entity | undefined,
  isActive: () => boolean): FleetCameraHandle {
  let destroyed = false;
  let revision = 0;
  let tracked: Association | undefined;
  // Checkpoint provenance prevents accepting state captured from another Viewer/handle.
  const checkpoints = new WeakMap<FleetCameraCheckpoint, Association | undefined>();
  const active = () => !destroyed && isActive() && !viewer.isDestroyed();
  function target(id: string): Entity | undefined {
    if (!active()) return undefined;
    const entity = getOwnedEntity(id);
    return active() && entity?.id === id && viewer.entities.getById(id) === entity ? entity : undefined;
  }
  function release() {
    local(() => {
      const previous = tracked;
      tracked = undefined;
      const operation = ++revision;
      if (!previous || viewer.isDestroyed() || viewer.trackedEntity !== previous.entity) return;
      // Teardown keeps the recorded object identity, independent of an inactive owned query
      // and independent of removal/replacement of the original collection member.
      let view: WorldView | undefined;
      let captureError: unknown;
      try { view = captureView(viewer); } catch (error) { captureError = error; }
      try { viewer.trackedEntity = undefined; }
      catch (error) {
        // A setter can throw before clearing its target. Retain ownership so destroy can retry.
        if (!viewer.isDestroyed() && viewer.trackedEntity === previous.entity && !tracked) tracked = previous;
        throw error;
      }
      if (captureError) throw captureError;
      const canContinue = () => operation === revision && !viewer.isDestroyed() && viewer.trackedEntity === undefined;
      // Synchronous callbacks can end this lifecycle or install a different camera owner.
      restoreView(viewer, view!, canContinue);
    });
  }
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(() => {
    if (tracked && viewer.trackedEntity !== tracked.entity) { tracked = undefined; revision++; }
  });
  const removeCollectionListener = viewer.entities.collectionChanged.addEventListener(() => {
    if (tracked && !viewer.isDestroyed() && viewer.entities.getById(tracked.id) !== tracked.entity) release();
  });
  return {
    track(id) {
      return local(() => {
        const entity = target(id);
        if (!entity) return false;
        if (tracked?.entity === entity && viewer.trackedEntity === entity) return true;
        const record = { id, entity };
        // Record before Cesium's setter raises synchronous trackedEntityChanged events.
        tracked = record;
        revision++;
        viewer.trackedEntity = entity;
        if (!active() || tracked !== record || viewer.entities.getById(id) !== entity || viewer.trackedEntity !== entity) {
          if (tracked === record) release();
          return false;
        }
        return true;
      });
    },
    getTrackedVehicleId() {
      return active() && tracked && viewer.trackedEntity === tracked.entity
        && viewer.entities.getById(tracked.id) === tracked.entity ? tracked.id : null;
    },
    locate(telemetry) {
      return local(() => {
        const entity = target(telemetry.vehicle_id);
        if (!entity || !Number.isFinite(telemetry.longitude) || !Number.isFinite(telemetry.latitude)
          || !Number.isFinite(telemetry.height) || Math.abs(telemetry.longitude) > 180 || Math.abs(telemetry.latitude) > 90) return false;
        if (viewer.trackedEntity && viewer.trackedEntity !== tracked?.entity) return false;
        release();
        if (!active() || viewer.trackedEntity || target(telemetry.vehicle_id) !== entity) return false;
        const operation = revision;
        focusVehicle(viewer, telemetry);
        return active() && operation === revision && viewer.trackedEntity === undefined
          && viewer.entities.getById(telemetry.vehicle_id) === entity;
      });
    },
    capture() {
      return local(() => {
        if (!active()) throw new FleetCameraError('Cannot capture an inactive fleet camera');
        if (viewer.trackedEntity !== tracked?.entity || (tracked && target(tracked.id) !== tracked.entity)) {
          throw new FleetCameraError('Cannot capture an unowned tracking association');
        }
        const checkpoint: FleetCameraCheckpoint = { ...captureView(viewer),
          trackedVehicleId: tracked?.id ?? null, trackedEntity: tracked?.entity };
        checkpoints.set(checkpoint, tracked);
        return checkpoint;
      });
    },
    restore(checkpoint) {
      local(() => {
        if (!active() || !checkpoints.has(checkpoint)) throw new FleetCameraError('Invalid fleet camera checkpoint lifecycle');
        const original = checkpoints.get(checkpoint);
        if (original) {
          // Public APIs expose neither pending initialization nor the original EntityView.
          // Even equal pointers and WC pose cannot certify that pending semantics survived.
          // The transaction must use its fatal path rather than claim complete restoration.
          throw new FleetCameraError('Original tracking initialization cannot be reliably restored through public APIs');
        }
        if (checkpoint.trackedEntity !== undefined || checkpoint.trackedVehicleId !== null
          || (viewer.trackedEntity && viewer.trackedEntity !== tracked?.entity)) throw new FleetCameraError('Unowned checkpoint association');
        release();
        const operation = revision;
        const canContinue = () => active() && operation === revision && viewer.trackedEntity === undefined;
        if (!restoreView(viewer, checkpoint, canContinue)) throw new FleetCameraError('Camera lifecycle changed during restoration');
      });
    },
    release,
    destroy() {
      if (destroyed && !tracked) return;
      destroyed = true;
      revision++;
      try { release(); }
      finally { removeTrackingListener(); removeCollectionListener(); }
    },
  };
}
