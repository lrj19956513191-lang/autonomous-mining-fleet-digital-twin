import { Cartesian3, Cartographic, ConstantPositionProperty, Entity, EntityCollection, Event, Matrix4,
  OrthographicFrustum, PerspectiveOffCenterFrustum, PerspectiveFrustum, type Viewer } from 'cesium';
import { describe, expect, test, vi } from 'vitest';
import { createFleetCamera, FleetCameraError } from './fleetCamera';
import { createFleetEntities } from '../vehicle/fleetEntities';
import { makeFleetSnapshotFixture } from '../realtime/fleetFixtures';
import type { FleetSnapshot } from '../realtime/fleetTelemetry';

// Real Cesium data objects at the public Viewer boundary; no browser/render claim.
function fixture() {
  let active = true;
  let dead = false;
  let tracked: Entity | undefined;
  const entities = new EntityCollection();
  const changed = new Event();
  const writes: (Entity | undefined)[] = [];
  const camera = {
    position: new Cartesian3(1, 2, 3),
    positionWC: new Cartesian3(6378137, 400, 1000),
    directionWC: new Cartesian3(-1, 0, 0), upWC: new Cartesian3(0, 0, 1),
    frustum: new PerspectiveFrustum({ fov: 0.9, aspectRatio: 1.6, near: 2, far: 200000 }),
    setView: vi.fn<Viewer['camera']['setView']>(options => {
      if (options?.destination instanceof Cartesian3) Cartesian3.clone(options.destination, camera.positionWC);
      if (options?.orientation && 'direction' in options.orientation) {
        Cartesian3.clone(options.orientation.direction!, camera.directionWC);
        Cartesian3.clone(options.orientation.up!, camera.upWC);
      }
    }), cancelFlight: vi.fn(),
  };
  const viewer = {
    entities, camera, trackedEntityChanged: changed, isDestroyed: () => dead,
    get trackedEntity() { return tracked; },
    set trackedEntity(value: Entity | undefined) {
            tracked = value; writes.push(value);
      // Emulate documented release transform reset at the public boundary.
      if (!value) {
        Cartesian3.clone(new Cartesian3(3, 4, 5), camera.positionWC);
        Cartesian3.clone(Cartesian3.UNIT_Y, camera.directionWC);
        Cartesian3.clone(Cartesian3.UNIT_X, camera.upWC);
      }
      changed.raiseEvent(value);
    },
  } as unknown as Viewer;
  const owned = new Map<string, Entity>();
  for (const id of ['TRUCK_001', 'TRUCK_002']) {
    owned.set(id, entities.add(new Entity({ id,
      position: new ConstantPositionProperty(new Cartesian3(6378137, 10, 20)) })));
  }
  const query = (id: string) => active && entities.getById(id) === owned.get(id) ? owned.get(id) : undefined;
  const handle = createFleetCamera(viewer, query, () => active);
  return { viewer, camera, handle, entities, owned, writes, changed,
    deactivate: () => { active = false; }, kill: () => { dead = true; } };
}

describe('explicit', () => {
  test('tracking_is_explicit_and_target_is_owned', () => {
    const f = fixture();
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    expect(f.writes).toEqual([]);
    expect(f.handle.track('TRUCK_001')).toBe(true);
    expect(f.viewer.trackedEntity).toBe(f.owned.get('TRUCK_001'));
    expect(f.handle.getTrackedVehicleId()).toBe('TRUCK_001');
    expect(f.handle.track('MISSING')).toBe(false);
    expect(f.viewer.trackedEntity).toBe(f.owned.get('TRUCK_001'));
  });
  test('ordinary snapshots preserve explicit association including stopped vehicles', () => {
    const f = fixture();
    const fleet = createFleetEntities(f.entities, () => true);
    const hooks = { capture: () => null, beforeRemove() {}, afterReconcile() {}, restore() {}, isActive: () => true };
    const snapshot = makeFleetSnapshotFixture() as FleetSnapshot;
    // Use a separate real owned collection; ordinary entity updates never invoke tracking.
    const entities = new EntityCollection();
    const realFleet = createFleetEntities(entities, () => true);
    realFleet.apply(snapshot, hooks);
    Object.defineProperty(f.viewer, 'entities', { value: entities });
    const camera = createFleetCamera(f.viewer, realFleet.getOwnedEntity, () => true);
    expect(camera.track('TRUCK_001')).toBe(true);
    const first = f.viewer.trackedEntity;
    const stopped = { ...snapshot, vehicles: snapshot.vehicles.map(v => ({ ...v, speed: 0, status: 'stopped' as const })) };
    realFleet.apply(stopped, hooks);
    expect(f.viewer.trackedEntity).toBe(first);
    expect(f.writes).toHaveLength(1);
    expect(camera.track('TRUCK_002')).toBe(true);
    expect(camera.getTrackedVehicleId()).toBe('TRUCK_002');
    fleet.destroy();
  });
  test.each(['removed', 'replacement', 'inactive', 'destroyed', 'disposed'])('rejects %s targets', mode => {
    const f = fixture();
    if (mode === 'removed' || mode === 'replacement') f.entities.remove(f.owned.get('TRUCK_001')!);
    if (mode === 'replacement') f.entities.add(new Entity({ id: 'TRUCK_001' }));
    if (mode === 'inactive') f.deactivate();
    if (mode === 'destroyed') f.kill();
    if (mode === 'disposed') f.handle.destroy();
    expect(f.handle.track('TRUCK_001')).toBe(false);
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.writes).toHaveLength(0);
  });
});


describe('preserves', () => {
  test.each([
    ['perspective', new PerspectiveFrustum({ fov: 0.85, aspectRatio: 1.7, near: 3, far: 99999, xOffset: 2, yOffset: 4 })] as const,
    ['orthographic', new OrthographicFrustum({ width: 800, aspectRatio: 1.7, near: 3, far: 99999 })] as const,
    ['perspective off-center', new PerspectiveOffCenterFrustum({ left: -4, right: 7, top: 8, bottom: -9, near: 3, far: 99999 })] as const,
  ])('release_preserves_world_pose_and_frustum %s', (_label, frustum) => {
    const f = fixture();
    f.camera.frustum = frustum as PerspectiveFrustum;
    const expected = frustum.clone();
    expect(f.handle.track('TRUCK_001')).toBe(true);
    f.handle.release(); // Also tests the pending-initialization interval before any frame.
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    expect(Cartesian3.distance(f.camera.positionWC, new Cartesian3(6378137, 400, 1000))).toBeLessThanOrEqual(0.01);
    expect(Cartesian3.angleBetween(f.camera.directionWC, new Cartesian3(-1, 0, 0))).toBeLessThanOrEqual(1e-6);
    expect(Cartesian3.angleBetween(f.camera.upWC, Cartesian3.UNIT_Z)).toBeLessThanOrEqual(1e-6);
    expect(f.camera.frustum).toBeInstanceOf(frustum.constructor);
    expect(f.camera.frustum).not.toBe(frustum);
    expect(f.camera.frustum.equals(expected as PerspectiveFrustum)).toBe(true);
    expect(f.camera.setView.mock.calls[0][0]?.endTransform).toEqual(Matrix4.IDENTITY);
    expect(f.camera.cancelFlight).not.toHaveBeenCalled();
    // Subsequent data updates have no wrapper callback that can reinstall the association.
    for (let i = 0; i < 3; i++) f.owned.get('TRUCK_001')!.position = new ConstantPositionProperty(new Cartesian3(i, 0, 0));
    expect(f.viewer.trackedEntity).toBeUndefined();
  });
  test.each(['inactive release', 'inactive destroy'])('%s clears recorded target even when the owned query is inactive', mode => {
    const f = fixture(); f.handle.track('TRUCK_001'); f.deactivate();
    if (mode === 'inactive release') f.handle.release(); else f.handle.destroy();
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    expect(f.camera.positionWC).toEqual(new Cartesian3(6378137, 400, 1000));
  });
  test.each(['removed', 'replacement'])('immediately releases %s owned object without claiming replacement', mode => {
    const f = fixture(); f.handle.track('TRUCK_001');
    f.entities.remove(f.owned.get('TRUCK_001')!);
    if (mode === 'replacement') f.entities.add(new Entity({ id: 'TRUCK_001' }));
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    expect(f.handle.track('TRUCK_001')).toBe(false);
  });
  test('external later tracking and flight survive release and destroy', () => {
    const f = fixture(); f.handle.track('TRUCK_001');
    const external = new Entity({ id: 'EXTERNAL' });
    f.viewer.trackedEntity = external;
    f.handle.release(); f.handle.destroy(); f.handle.destroy();
    expect(f.viewer.trackedEntity).toBe(external);
    expect(f.camera.setView).not.toHaveBeenCalled();
    expect(f.camera.cancelFlight).not.toHaveBeenCalled();
  });
  test('destroyed viewer skips camera calls and drops resource record', () => {
    const f = fixture(); f.handle.track('TRUCK_001'); f.kill();
    f.handle.release(); f.handle.destroy();
    expect(f.writes).toHaveLength(1);
    expect(f.camera.setView).not.toHaveBeenCalled();
    expect(f.handle.getTrackedVehicleId()).toBeNull();
  });
});


function telemetry(id = 'TRUCK_002') {
  return { vehicle_id: id, timestamp: '2026-10-14T04:00:00+00:00', longitude: 117, latitude: 40,
    height: 55, heading: 0, speed: 0, soc: 80, load: 40, status: 'stopped' as const };
}
describe('locate', () => {
  test.each(['TRUCK_001', 'TRUCK_002'])('locate_releases_before_focus_and_invalid_selection_is_noop %s', id => {
    const f = fixture(); f.handle.track('TRUCK_001');
    const observed: (Entity | undefined)[] = [];
    f.camera.setView.mockImplementation(options => {
      observed.push(f.viewer.trackedEntity);
      if (options?.destination instanceof Cartesian3) Cartesian3.clone(options.destination, f.camera.positionWC);
      if (options?.orientation && 'direction' in options.orientation) {
        Cartesian3.clone(options.orientation.direction!, f.camera.directionWC);
        Cartesian3.clone(options.orientation.up!, f.camera.upWC);
      }
    });
    expect(f.handle.locate(telemetry('INVALID'))).toBe(false);
    expect(f.viewer.trackedEntity).toBe(f.owned.get('TRUCK_001'));
    expect(f.camera.setView).not.toHaveBeenCalled();
    expect(f.handle.locate(telemetry(id))).toBe(true);
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(observed).toEqual([undefined, undefined]);
    const focused = Cartographic.fromCartesian(f.camera.positionWC);
    expect(focused.height).toBeCloseTo(1055, 3);
    expect(focused.longitude * 180 / Math.PI).toBeCloseTo(117, 8);
    expect(f.camera.setView.mock.calls[1][0]?.orientation).toEqual({ heading: 0, pitch: -Math.PI / 2, roll: 0 });
  });
  test.each(['missing', 'replacement', 'inactive', 'dead', 'disposed', 'nonfinite'])('invalid %s locate has no effect', mode => {
    const f = fixture(); f.handle.track('TRUCK_001');
    if (mode === 'replacement') { f.entities.remove(f.owned.get('TRUCK_002')!); f.entities.add(new Entity({ id: 'TRUCK_002' })); }
    if (mode === 'inactive') f.deactivate();
    if (mode === 'dead') f.kill();
    if (mode === 'disposed') f.handle.destroy();
    const before = f.writes.length; const views = f.camera.setView.mock.calls.length;
    const target = mode === 'missing' ? telemetry('MISSING') : telemetry();
    expect(f.handle.locate(mode === 'nonfinite' ? { ...target, height: NaN } : target)).toBe(false);
    expect(f.writes).toHaveLength(before);
    expect(f.camera.setView).toHaveBeenCalledTimes(views);
  });
  test.each(['destroy', 'inactive', 'dead'])('track setter synchronous %s cannot leave a live owned association', mode => {
    const f = fixture();
    f.changed.addEventListener((target: Entity | undefined) => {
      if (!target) return;
      if (mode === 'destroy') f.handle.destroy();
      if (mode === 'inactive') f.deactivate();
      if (mode === 'dead') f.kill();
    });
    expect(f.handle.track('TRUCK_001')).toBe(false);
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    if (mode !== 'dead') expect(f.viewer.trackedEntity).toBeUndefined();
    else expect(f.camera.setView).not.toHaveBeenCalled();
  });
  test.each(['destroy', 'inactive', 'dead', 'external'])('release setter synchronous %s prevents subsequent focus', mode => {
    const f = fixture(); f.handle.track('TRUCK_001');
    const external = new Entity({ id: 'EXTERNAL' });
    f.changed.addEventListener((target: Entity | undefined) => {
      if (target) return;
      if (mode === 'destroy') f.handle.destroy();
      if (mode === 'inactive') f.deactivate();
      if (mode === 'dead') f.kill();
      if (mode === 'external') f.viewer.trackedEntity = external;
    });
    expect(f.handle.locate(telemetry())).toBe(false);
    expect(f.camera.setView.mock.calls.every(([o]) => !!o?.endTransform)).toBe(true);
    if (mode === 'external') expect(f.viewer.trackedEntity).toBe(external);
  });
  test.each(['release', 'focus'])('%s errors are FleetCameraError and prevent later focus', phase => {
    const f = fixture(); if (phase === 'release') f.handle.track('TRUCK_001');
    f.camera.setView.mockImplementation(() => { throw new Error('local camera failure'); });
    expect(() => f.handle.locate(telemetry())).toThrow(FleetCameraError);
    expect(f.camera.setView).toHaveBeenCalledTimes(1);
  });
  test('checkpoint captures independent world view and owned identity', () => {
    const f = fixture(); f.handle.track('TRUCK_001');
    const checkpoint = f.handle.capture();
    expect(checkpoint.trackedVehicleId).toBe('TRUCK_001');
    expect(checkpoint.trackedEntity).toBe(f.owned.get('TRUCK_001'));
    expect(checkpoint.positionWC).not.toBe(f.camera.positionWC);
    expect(checkpoint.directionWC).not.toBe(f.camera.directionWC);
    expect(checkpoint.upWC).not.toBe(f.camera.upWC);
    expect(checkpoint.frustum).not.toBe(f.camera.frustum);
    f.camera.positionWC.x = 1; f.camera.frustum.near = 80;
    expect(checkpoint.positionWC.x).toBe(6378137);
    expect(checkpoint.frustum.near).toBe(2);
  });
  test('untracked checkpoint restores and verifies real world view and frustum', () => {
    const f = fixture(); const checkpoint = f.handle.capture();
    f.camera.positionWC.x = 99; f.camera.directionWC.y = 3; f.camera.frustum.near = 80;
    f.handle.restore(checkpoint);
    expect(f.camera.positionWC).toEqual(new Cartesian3(6378137, 400, 1000));
    expect(f.camera.directionWC).toEqual(new Cartesian3(-1, 0, 0));
    expect(f.camera.frustum.near).toBe(2);
  });
  test.each(['released', 'retracked', 'removed', 'pose changed'])('cannot certify %s tracked checkpoint through the public API', mode => {
    const f = fixture(); f.handle.track('TRUCK_001'); const checkpoint = f.handle.capture();
    if (mode === 'released' || mode === 'retracked') f.handle.release();
    if (mode === 'retracked') f.handle.track('TRUCK_001');
    if (mode === 'removed') f.entities.remove(f.owned.get('TRUCK_001')!);
    if (mode === 'pose changed') f.camera.positionWC.x = 19;
    expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
    expect(f.handle.getTrackedVehicleId()).toBe(mode === 'retracked' || mode === 'pose changed' ? 'TRUCK_001' : null);
  });
  test('even unchanged tracked checkpoint cannot certify pending initialization through public APIs', () => {
    const f = fixture(); f.handle.track('TRUCK_001'); const checkpoint = f.handle.capture();
    expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
    expect(f.writes).toHaveLength(1);
    expect(f.camera.setView).not.toHaveBeenCalled();
    expect(f.handle.getTrackedVehicleId()).toBe('TRUCK_001');
  });
  test('restoration verifies setView outcome and wraps local errors', () => {
    const f = fixture(); const checkpoint = f.handle.capture(); f.camera.positionWC.x = 1;
    f.camera.setView.mockImplementation(() => {});
    expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
    f.camera.setView.mockImplementation(() => { throw new Error('restore failed'); });
    expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
  });
  test('external checkpoint ownership is rejected without disturbing later owner', () => {
    const f = fixture(); const checkpoint = f.handle.capture();
    const external = new Entity({ id: 'EXTERNAL' }); f.viewer.trackedEntity = external;
    expect(() => f.handle.capture()).toThrow(FleetCameraError);
    expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
    expect(f.viewer.trackedEntity).toBe(external);
    expect(f.camera.setView).not.toHaveBeenCalled();
  });
  test.each(['inactive', 'dead', 'disposed'])('%s checkpoint operations fail locally without camera access', mode => {
    const f = fixture(); const checkpoint = f.handle.capture();
    if (mode === 'inactive') f.deactivate(); if (mode === 'dead') f.kill(); if (mode === 'disposed') f.handle.destroy();
    expect(() => f.handle.capture()).toThrow(FleetCameraError);
    expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
    expect(f.camera.setView).not.toHaveBeenCalled();
  });
});


describe('locate ownership and error boundaries', () => {
  test('release with the real Task8 inactive query still clears its recorded entity', () => {
    const f = fixture(); let live = true;
    const entities = new EntityCollection();
    const fleet = createFleetEntities(entities, () => live);
    fleet.apply(makeFleetSnapshotFixture() as FleetSnapshot, { capture: () => null, beforeRemove() {},
      afterReconcile() {}, restore() {}, isActive: () => live });
    Object.defineProperty(f.viewer, 'entities', { value: entities });
    const camera = createFleetCamera(f.viewer, fleet.getOwnedEntity, () => live);
    expect(camera.track('TRUCK_001')).toBe(true); live = false;
    expect(fleet.getOwnedEntity('TRUCK_001')).toBeUndefined();
    camera.release(); expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.camera.positionWC).toEqual(new Cartesian3(6378137, 400, 1000));
    camera.destroy(); fleet.destroy();
  });
  test('track setter failure after assignment is local and cleanup still owns the attempted target', () => {
    const f = fixture();
    const remove = f.changed.addEventListener((target: Entity | undefined) => { if (target) throw new Error('event failed'); });
    expect(() => f.handle.track('TRUCK_001')).toThrow(FleetCameraError);
    remove(); f.handle.destroy();
    expect(f.viewer.trackedEntity).toBeUndefined();
  });
  test('failed teardown retains ownership and repeated destroy retries its own target', () => {
    const f = fixture(); f.handle.track('TRUCK_001');
    const descriptor = Object.getOwnPropertyDescriptor(f.viewer, 'trackedEntity')!;
    let reject = true;
    Object.defineProperty(f.viewer, 'trackedEntity', { ...descriptor, set(value) {
      if (!value && reject) throw new Error('setter rejected before clearing');
      descriptor.set!.call(f.viewer, value);
    } });
    expect(() => f.handle.destroy()).toThrow(FleetCameraError);
    expect(f.viewer.trackedEntity === f.owned.get('TRUCK_001')).toBe(true);
    reject = false; f.handle.destroy();
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.handle.track('TRUCK_002')).toBe(false);
  });
  test('release capture failure still tears down its target and reports a local error', () => {
    const f = fixture(); f.handle.track('TRUCK_001');
    Object.defineProperty(f.camera, 'positionWC', { get() { throw new Error('camera read failed'); } });
    expect(() => f.handle.release()).toThrow(FleetCameraError);
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.camera.setView).not.toHaveBeenCalled();
  });
  test.each(['focus', 'restore'])('synchronous %s camera callback ending lifecycle is checked after setView', phase => {
    const f = fixture(); const checkpoint = f.handle.capture();
    f.camera.setView.mockImplementation(() => { f.kill(); });
    if (phase === 'focus') expect(f.handle.locate(telemetry())).toBe(false);
    else expect(() => f.handle.restore(checkpoint)).toThrow(FleetCameraError);
    expect(f.camera.setView).toHaveBeenCalledTimes(1);
  });
  test('untracked checkpoint releases newly started tracking before restoring its original view', () => {
    const f = fixture(); const checkpoint = f.handle.capture();
    f.handle.track('TRUCK_002'); f.camera.positionWC.x = 6000000;
    f.handle.restore(checkpoint);
    expect(f.viewer.trackedEntity).toBeUndefined();
    expect(f.handle.getTrackedVehicleId()).toBeNull();
    expect(f.camera.positionWC).toEqual(new Cartesian3(6378137, 400, 1000));
    expect(f.camera.setView).toHaveBeenCalledTimes(2);
  });
  test('checkpoints from another camera handle cannot be restored', () => {
    const first = fixture(); const second = fixture();
    expect(() => second.handle.restore(first.handle.capture())).toThrow(FleetCameraError);
    expect(second.camera.setView).not.toHaveBeenCalled();
  });
});
