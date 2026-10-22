import type { EntityCollection, Viewer } from 'cesium';
import type { FleetSnapshot } from './realtime/fleetTelemetry';
import type { SceneLoadState } from './App';
import { createViewer, type ViewerHandle } from './cesium/viewer';
import { createFleetCamera } from './cesium/fleetCamera';
import { createFleetEntities, FleetRenderError } from './vehicle/fleetEntities';
import { createFleetInteraction } from './vehicle/fleetInteraction';
import type { MineScene } from './scene/sceneClient';
import { renderMineScene, type SceneRenderHandle } from './scene/sceneRenderer';

export interface FleetPresentationModel {
  readonly snapshot: FleetSnapshot | null;
  readonly selectedVehicleId: string | null;
  readonly trackedVehicleId: string | null;
  readonly sceneState: SceneLoadState;
  readonly sceneError: string | null;
  readonly renderError: string | null;
  readonly fatal: boolean;
}
export interface FleetPresentationHandle {
  renderScene(scene: MineScene): void;
  applySnapshot(snapshot: FleetSnapshot): boolean;
  setSourceAvailable(available: boolean): void;
  select(id: string | null): void;
  locateSelected(): void;
  trackSelected(): void;
  stopTracking(): void;
  destroy(): void;
}
export interface FleetPresentationCallbacks {
  onModel(model: FleetPresentationModel): void;
  onFatal(error: Error): void;
  onCleanupError(error: Error): void;
}
export class FleetPresentationError extends Error {
  constructor(message: string, readonly fatal: boolean, cause?: unknown) {
    super(message, { cause }); this.name = 'FleetPresentationError';
  }
}
function describeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); current = current instanceof Error ? current.cause : undefined) {
    seen.add(current); messages.push(current instanceof Error ? current.message : String(current));
  }
  return messages.join(': ');
}

export function createFleetPresentation(container: HTMLElement,
  callbacks: FleetPresentationCallbacks): FleetPresentationHandle {
  let model: FleetPresentationModel = Object.freeze({snapshot:null, selectedVehicleId:null,
    trackedVehicleId:null, sceneState:'LOADING', sceneError:null, renderError:null, fatal:false});
  const lifecycle = {};
  let token: object | null = lifecycle;
  let disposed = false;
  let terminating = false;
  let cleaning = false;
  let primaryError: Error | undefined;
  const released = new Set<string>();
  let viewerHandle: ViewerHandle | undefined;
  let viewer: Viewer | undefined;
  let sceneHandle: SceneRenderHandle | undefined;
  let fleet: ReturnType<typeof createFleetEntities> | undefined;
  let camera: ReturnType<typeof createFleetCamera> | undefined;
  let input: ReturnType<typeof createFleetInteraction> | undefined;
  let removeTrackingObserver: (() => void) | undefined;
  let cameraLocated = false;
  let selectionInitialized = false;
  let inBatch = false;
  let selectedVehicleId: string | null = null;
  let trackedVehicleId: string | null = null;
  let sourceAvailable = false;
  let pendingSource: boolean | undefined;
  const active = () => {
    if (disposed || terminating || token !== lifecycle || !viewer || viewerHandle?.viewer !== viewer) return false;
    const dead = viewer.isDestroyed();
    return !dead && !disposed && !terminating && token === lifecycle && viewerHandle?.viewer === viewer;
  };
  function publish(change: Partial<FleetPresentationModel>): boolean {
    if (!active() || inBatch) return false;
    let committed = false;
    try {
      if (camera) trackedVehicleId = camera.getTrackedVehicleId();
      if (!active()) return false;
      model = Object.freeze({...model, ...change, selectedVehicleId, trackedVehicleId});
      committed = true;
      callbacks.onModel(model);
    } catch (error) { fail(error, 'Fleet model publication failed'); }
    return committed;
  }
  function fail(error: unknown, context: string, fatal = true,
    change: Partial<FleetPresentationModel> = {}) {
    if (!active()) return;
    primaryError = new Error(`${context}: ${describeError(error)}`, {cause:error});
    if (!fatal) { publish({...change, renderError:primaryError.message}); return; }
    // Invalidate first, including before onFatal/onModel can synchronously reenter.
    terminating = true;
    model = Object.freeze({...model, ...change, selectedVehicleId, trackedVehicleId,
      renderError:primaryError.message, fatal:true});
    const errors: unknown[] = [];
    try { callbacks.onFatal(primaryError); } catch (cause) { errors.push(cause); }
    try { callbacks.onModel(model); } catch (cause) { errors.push(cause); }
    try { handle.destroy(); } finally {
      if (errors.length) callbacks.onCleanupError(new AggregateError(errors,
        'Fleet fatal notification failed', {cause:primaryError}));
    }
  }
  // The gate covers both reconciliation and endBatch's synchronous invalid-target callbacks.
  function batch(operation: () => void) {
    inBatch = true;
    let end: (() => void) | undefined;
    try {
      end = input!.beginBatch();
      if (active()) operation();
    } finally {
      try { end?.(); } finally { inBatch = false; }
    }
  }
  function act(operation: () => void, context: string) {
    if (!active() || inBatch) return;
    try { batch(operation); }
    catch (error) { flushSource(); fail(error, context); return; }
    flushSource();
    if (active()) publish({});
  }
  function select(id: string | null) {
    if (!active() || inBatch || (id !== null && !fleet!.getOwnedEntity(id))) return;
    act(() => {
      fleet!.setSelected(id);
      if (active()) selectedVehicleId = id;
    }, 'Fleet selection failed');
  }
  function synchronizeTargets() {
    if (!active()) return;
    const oldSelected = selectedVehicleId;
    const oldTracked = trackedVehicleId;
    if (selectedVehicleId && !fleet!.getOwnedEntity(selectedVehicleId)) {
      fleet!.setSelected(null);
      if (!active()) return;
      selectedVehicleId = null;
    }
    trackedVehicleId = camera!.getTrackedVehicleId();
    if (active() && (oldSelected !== selectedVehicleId || oldTracked !== trackedVehicleId)) publish({});
  }
  function changeSource(available: boolean, notify = true, onFailure?: (error: unknown) => void) {
    if (!active()) return;
    if (inBatch) { pendingSource = available; return; }
    sourceAvailable = available;
    try { batch(() => { if (!available) camera!.release(); }); }
    catch (error) {
      if (onFailure) onFailure(error);
      else fail(error, 'Fleet disconnect camera release failed');
      return;
    }
    if (!active()) return;
    flushSource(onFailure);
    if (notify && active()) publish({});
  }
  function flushSource(onFailure?: (error: unknown) => void) {
    const pending = pendingSource; pendingSource = undefined;
    if (pending !== undefined) changeSource(pending, false, onFailure);
  }
  const handle: FleetPresentationHandle = {
    renderScene,
    applySnapshot,
    setSourceAvailable(available) { if (continueSetup()) changeSource(available); },
    select(id) { if (active() && !inBatch) input?.select(id); },
    locateSelected() {
      const vehicle = model.snapshot?.vehicles.find(value => value.vehicle_id === selectedVehicleId);
      if (!vehicle) return;
      act(() => { camera!.locate(vehicle); }, 'Fleet locate failed');
    },
    trackSelected() {
      if (!selectedVehicleId || !sourceAvailable) return;
      act(() => { camera!.track(selectedVehicleId!); }, 'Fleet tracking failed');
    },
    stopTracking() { act(() => { camera!.release(); }, 'Fleet stop tracking failed'); },
    destroy() {
      disposed = true; token = null;
      if (cleaning) return;
      cleaning = true;
      const errors: Error[] = [];
      const release = (name: string, operation: (() => void) | undefined) => {
        if (!operation || released.has(name)) return;
        try { operation(); released.add(name); }
        catch (cause) { errors.push(new Error(`${name} release unconfirmed`, { cause })); }
      };
      try {
        release('input', input ? () => input!.destroy() : undefined);
        release('tracking observer', removeTrackingObserver);
        release('camera', camera ? () => camera!.destroy() : undefined);
        release('fleet', fleet ? () => fleet!.destroy() : undefined);
        release('scene', sceneHandle ? () => sceneHandle!.destroy() : undefined);
      } finally {
        release('Viewer', viewerHandle ? () => viewerHandle!.destroy() : undefined);
        cleaning = false;
      }
      if (errors.length) callbacks.onCleanupError(new AggregateError(errors,
        'Fleet cleanup failed; resource release unconfirmed', { cause: primaryError }));
    },
  };
  // Constructors may return after synchronous callbacks ended the lifecycle. Adopt first, then release.
  function continueSetup() {
    if (active()) return true;
    if (!disposed && !terminating) {
      terminating = true; primaryError = new Error('Fleet presentation lifecycle ended during setup');
      try { callbacks.onFatal(primaryError); } finally { handle.destroy(); }
    } else handle.destroy();
    return false;
  }
  function applySnapshot(snapshot: FleetSnapshot): boolean {
    if (!active() || inBatch) return false;
    try {
      batch(() => {
        if (!active()) return;
        fleet!.apply(snapshot, {
          isActive: active,
          capture() { return { selectedVehicleId, trackedVehicleId, selectionInitialized, cameraLocated,
            camera: camera!.capture() }; },
          beforeRemove(id) {
            if (selectedVehicleId === id) selectedVehicleId = null;
            if (trackedVehicleId === id) {
              camera!.release();
              if (active()) trackedVehicleId = null;
            }
          },
          afterReconcile(value) {
            if (!active()) return;
            const first = value.vehicles.find(vehicle => vehicle.vehicle_id === 'TRUCK_001');
            if (!selectionInitialized) {
              const selected = first ? first.vehicle_id : null;
              fleet!.setSelected(selected);
              if (!active()) return;
              selectedVehicleId = selected; selectionInitialized = true;
            }
            if (!active()) return;
            if (first && !cameraLocated && camera!.locate(first) && active()) cameraLocated = true;
          },
          restore(saved) {
            if (!active()) return;
            selectedVehicleId = saved.selectedVehicleId; trackedVehicleId = saved.trackedVehicleId;
            selectionInitialized = saved.selectionInitialized; cameraLocated = saved.cameraLocated;
            // Task9 intentionally throws for a checkpoint containing tracking; that is fatal.
            camera!.restore(saved.camera);
          },
        });
      });
    } catch (error) {
      flushSource();
      fail(error, `Fleet rendering failed at sequence ${snapshot.sequence}`,
        !(error instanceof FleetRenderError) || !error.restored);
      return false;
    }
    if (!active()) return false;
    flushSource();
    if (!active()) return false;
    primaryError = undefined;
    return publish({snapshot, renderError:null});
  }
  function renderScene(scene: MineScene): void {
    if (!active() || inBatch) return;
    try { renderSceneBatch(scene); }
    catch (error) {
      if (error instanceof FleetPresentationError) throw error;
      let failure = error;
      if (active()) {
        try { fail(error, 'Scene presentation failed', true,
          {sceneState:'ERROR', sceneError:describeError(error)}); }
        catch (cleanupError) { failure = new AggregateError([error,cleanupError],
          'Scene failure and diagnostic delivery failed', {cause:error}); }
      }
      // Secondary diagnostic consumers cannot erase the primary render failure
      // or escape the synchronous typed contract after teardown has run.
      const cause = primaryError ? new AggregateError([primaryError,failure],
        'Scene presentation and diagnostic failure', {cause:primaryError}) : failure;
      throw new FleetPresentationError(describeError(failure), model.fatal, cause);
    }
  }
  function renderSceneBatch(scene: MineScene): void {
    if (!active() || inBatch) return;
    // A static mutation shares Cesium's notification chain with fleet Visualizers.
    // Member rollback cannot certify recovery after a public listener interrupted dispatch.
    let sceneMutationFailed = false;
    const mutateScene = <T,>(operation: () => T): T => {
      try { return operation(); }
      catch (error) { sceneMutationFailed = true; throw error; }
    };
    const entities: EntityCollection = new Proxy(viewer!.entities, { get(target, key) {
      if (key === 'add') return (...args: Parameters<EntityCollection['add']>) => {
        if (!active()) throw new Error('Scene lifecycle ended before insertion');
        const entity = mutateScene(() => target.add(...args));
        if (!active()) throw new Error('Scene lifecycle ended during insertion');
        return entity;
      };
      if (key === 'remove') return (...args: Parameters<EntityCollection['remove']>) =>
        mutateScene(() => target.remove(...args));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let renderFailure: {error:unknown} | undefined;
    try {
      batch(() => {
        try { sceneHandle = renderMineScene(entities, scene); }
        catch (error) { renderFailure = {error}; throw error; }
      });
    } catch (error) {
      if (!active()) { handle.destroy(); return; }
      const rendererFailed = renderFailure && renderFailure.error === error;
      const cause = rendererFailed || !renderFailure ? error : new AggregateError([renderFailure.error,error],
        'Scene rendering and interaction failed', {cause:renderFailure.error});
      const change: Partial<FleetPresentationModel> = {sceneState:'ERROR', sceneError:describeError(cause)};
      if (sceneMutationFailed || !rendererFailed) {
        fail(cause, rendererFailed ? 'Scene rendering failed; Cesium notification recovery unconfirmed'
          : 'Scene interaction failed', true, change);
      } else {
        flushSource(releaseError => fail(new AggregateError([cause,releaseError],
          `Scene failure followed by connection release failure: ${describeError(releaseError)}`, {cause}),
          'Scene and connection handling failed', true, change));
        if (active()) publish(change);
      }
      throw new FleetPresentationError(describeError(cause), model.fatal, cause);
    }
    if (!continueSetup()) return;
    flushSource();
    if (active()) publish({sceneState:'READY',sceneError:null});
    if (model.fatal) throw new FleetPresentationError(model.renderError || 'Scene presentation failed', true, primaryError);
  }
  try {
    viewerHandle = createViewer(container); viewer = viewerHandle.viewer;
    if (!continueSetup()) return handle;
    fleet = createFleetEntities(viewer.entities, active);
    if (!continueSetup()) return handle;
    camera = createFleetCamera(viewer, fleet.getOwnedEntity, active);
    if (!continueSetup()) return handle;
    input = createFleetInteraction(viewer, fleet, { onSelect: select, onInvalidTarget() {
      if (!active()) return;
      try { synchronizeTargets(); } catch (error) {
        if (inBatch) throw error;
        fail(error, 'Fleet target invalidation failed');
      }
    }, isActive: active });
    if (!continueSetup()) return handle;
    removeTrackingObserver = viewer.trackedEntityChanged.addEventListener(() => {
      if (!active() || inBatch) return;
      try { synchronizeTargets(); } catch (error) { fail(error, 'Fleet camera association failed'); }
    });
    if (!continueSetup()) return handle;
    publish({});
    if (!continueSetup()) return handle;
  } catch (error) {
    if (!viewer) {
      primaryError = new Error(`Fleet initialization failed: ${describeError(error)}`, {cause:error});
      terminating = true;
      model = Object.freeze({...model,sceneState:'ERROR',sceneError:describeError(error),
        renderError:primaryError.message,fatal:true});
      try { callbacks.onFatal(primaryError); }
      finally { try { callbacks.onModel(model); } finally { handle.destroy(); } }
    } else { fail(error, 'Fleet initialization failed'); handle.destroy(); }
  }
  return handle;
}
