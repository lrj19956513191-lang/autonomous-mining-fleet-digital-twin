import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Cartesian3, Color, Entity, EntityCollection, Event as CesiumEvent, JulianDate,
  PerspectiveFrustum, PointVisualizer, ScreenSpaceEventType, type Viewer } from 'cesium';
import { startFleetScene, type FleetViewModel } from './fleetScene';
import { createViewer, type ViewerHandle } from './cesium/viewer';
import { focusVehicle } from './cesium/camera';
import { connectFleetSocket, type FleetSocketOptions } from './realtime/fleetSocket';
import { connectVehicleSocket } from './realtime/vehicleSocket';
import { makeFleetSnapshotFixture } from './realtime/fleetFixtures';
import { parseFleetSnapshot } from './realtime/fleetTelemetry';
import { loadMineScene, parseMineScene, type MineScene } from './scene/sceneClient';
import { renderMineScene } from './scene/sceneRenderer';
import { makeSceneInput } from './scene/sceneFixtures';

vi.mock('./cesium/viewer', () => ({ createViewer: vi.fn() }));
vi.mock('./cesium/camera', () => ({ focusVehicle: vi.fn() }));
vi.mock('./realtime/fleetSocket', () => ({ connectFleetSocket: vi.fn() }));
vi.mock('./realtime/vehicleSocket', () => ({ connectVehicleSocket: vi.fn() }));
vi.mock('./scene/sceneClient', async original => ({
  ...await original<typeof import('./scene/sceneClient')>(), loadMineScene: vi.fn(),
}));
vi.mock('./scene/sceneRenderer', async original => ({
  ...await original<typeof import('./scene/sceneRenderer')>(), renderMineScene: vi.fn(),
}));
const realRenderer = (await vi.importActual<typeof import('./scene/sceneRenderer')>('./scene/sceneRenderer')).renderMineScene;
const container = {} as HTMLElement;
const time = JulianDate.fromIso8601('2026-10-14T04:00:00Z');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function packet(sequence = 0, ids = ['TRUCK_001', 'TRUCK_002', 'TRUCK_003']) {
  const wire = makeFleetSnapshotFixture();
  wire.sequence = sequence; wire.simulation_time_seconds = sequence;
  wire.vehicles = wire.vehicles.filter(vehicle => ids.includes(vehicle.vehicle_id));
  wire.vehicles.forEach(vehicle => { vehicle.longitude += sequence * 0.0001; });
  const parsed = parseFleetSnapshot(wire);
  if (!parsed) throw new Error('Invalid test DTO');
  return parsed;
}
function makeViewer() {
  let dead = false;
  let tracked: Entity | undefined;
  const actions = new Map<number, unknown>();
  const trackedEntityChanged = new CesiumEvent();
  const camera = {
    positionWC: new Cartesian3(6378137, 400, 1000),
    directionWC: new Cartesian3(-1, 0, 0), upWC: new Cartesian3(0, 0, 1),
    frustum: new PerspectiveFrustum({ fov: 0.9, aspectRatio: 1.6, near: 2, far: 200000 }),
    setView: vi.fn<Viewer['camera']['setView']>(options => {
      if (options?.destination instanceof Cartesian3) Cartesian3.clone(options.destination, camera.positionWC);
      if (options?.orientation && 'direction' in options.orientation) {
        Cartesian3.clone(options.orientation.direction!, camera.directionWC);
        Cartesian3.clone(options.orientation.up!, camera.upWC);
      }
    }),
  };
  const input = { getInputAction: vi.fn((type: number) => actions.get(type)),
    setInputAction: vi.fn((action: unknown, type: number) => { actions.set(type, action); }),
    removeInputAction: vi.fn((type: number) => { actions.delete(type); }) };
  const viewer = { entities: new EntityCollection(), camera, trackedEntityChanged,
    screenSpaceEventHandler: input, scene: { pick: vi.fn() }, isDestroyed: () => dead,
    get trackedEntity() { return tracked; },
    set trackedEntity(value: Entity | undefined) { tracked = value; trackedEntityChanged.raiseEvent(value); },
  } as unknown as Viewer;
  const handle: ViewerHandle = { viewer, destroy: vi.fn(() => { dead = true; }) };
  return { viewer, handle, camera, input, actions };
}
let f: ReturnType<typeof makeViewer>;
let requests: ReturnType<typeof deferred<MineScene>>[];
let sockets: FleetSocketOptions[];
let close: ReturnType<typeof vi.fn<() => void>>;
let models: FleetViewModel[];
let diagnostics: Error[];
const latest = () => models.at(-1)!;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function start(onModel?: (model: FleetViewModel) => void) {
  return startFleetScene(container, { onModel(model) { models.push(model); onModel?.(model); },
    onCleanupError(error) { diagnostics.push(error); } });
}
function resolveScene(index = 0) {
  const scene = parseMineScene(makeSceneInput());
  if (!scene) throw new Error('Invalid actual mine fixture');
  requests[index].resolve(scene);
}
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined); vi.stubEnv('VITE_VEHICLE_WS_URL', undefined);
  f = makeViewer(); requests = []; sockets = []; models = []; diagnostics = [];
  close = vi.fn();
  vi.mocked(createViewer).mockReturnValue(f.handle);
  vi.mocked(loadMineScene).mockImplementation(() => {
    const request = deferred<MineScene>(); requests.push(request); return request.promise;
  });
  vi.mocked(connectFleetSocket).mockImplementation(options => {
    sockets.push(options); options.onConnectionState('CONNECTING'); return { close };
  });
  vi.mocked(renderMineScene).mockImplementation(realRenderer);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Catches serial network startup, duplicate old WS, recreated vehicles and refocus on scene load.
test('parallel_starts_scene_and_fleet_and_preserves_vehicle_identity', async () => {
  const handle = start();
  expect(latest()?.sceneState).toBe('LOADING');
  expect(requests).toHaveLength(1); expect(sockets).toHaveLength(1);
  expect(sockets[0].url).toBe('ws://127.0.0.1:8000/ws/fleet');
  expect(connectVehicleSocket).not.toHaveBeenCalled();
  sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  expect(f.viewer.entities.values).toHaveLength(3);
  const original = f.viewer.entities.getById('TRUCK_001');
  expect(original?.position?.getValue(time)).toEqual(Cartesian3.fromDegrees(116, 39, 50));
  expect(focusVehicle).toHaveBeenCalledExactlyOnceWith(f.viewer, packet().vehicles[0]);
  resolveScene(); await settle();
  expect(latest().sceneState).toBe('READY'); expect(f.viewer.entities.values).toHaveLength(16);
  expect(f.viewer.entities.getById('TRUCK_001')).toBe(original);
  expect(focusVehicle).toHaveBeenCalledTimes(1);
  handle.destroy();
});
test.each(['config', 'viewer'])('parallel_%s_failure_starts_no_network', kind => {
  if (kind === 'config') vi.stubEnv('VITE_BACKEND_ORIGIN', 'invalid');
  else vi.mocked(createViewer).mockImplementationOnce(() => { throw new Error('Viewer unavailable'); });
  const handle = start();
  expect(latest()?.sceneState).toBe('ERROR');
  expect(latest()?.connectionState).toBe('CLOSED');
  if (kind === 'config') expect(createViewer).not.toHaveBeenCalled();
  expect(loadMineScene).not.toHaveBeenCalled(); expect(connectFleetSocket).not.toHaveBeenCalled();
  handle.destroy();
});
test.each(['http', 'renderer'])('parallel_scene_%s_error_keeps_live_fleet', async kind => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  if (kind === 'http') requests[0].reject(new Error('HTTP 503'));
  else { vi.mocked(renderMineScene).mockImplementationOnce(() => { throw new Error('Scene render failed'); }); resolveScene(); }
  await settle();
  expect(latest().sceneState).toBe('ERROR'); expect(latest().sceneError).toBeTruthy();
  expect(latest().connectionState).toBe('LIVE'); expect(latest().renderError).toBeNull();
  sockets[0].onSnapshot(packet(1)); expect(latest().snapshot?.sequence).toBe(1);
  expect(f.viewer.entities.values).toHaveLength(3); expect(close).not.toHaveBeenCalled();
  handle.destroy();
});

// Catches initialization outside the entity transaction, fallback selection and consumed failed initialization.
test.each([
  { ids: ['TRUCK_001', 'TRUCK_002'], selected: 'TRUCK_001' },
  { ids: ['TRUCK_002'], selected: null },
  { ids: [] as string[], selected: null },
])('initializes_selection_once_from_first_committed_snapshot $ids', ({ ids, selected }) => {
  const handle = start(); sockets[0].onSnapshot(packet(0, ids));
  expect(latest().selectedVehicleId).toBe(selected);
  const entity = f.viewer.entities.getById('TRUCK_001');
  if (entity) {
    expect(entity.point?.outlineColor?.getValue(time)).toEqual(Color.CYAN);
    expect(entity.point?.outlineWidth?.getValue(time)).toBe(3);
  }
  sockets[0].onSnapshot(packet(1));
  expect(latest().selectedVehicleId).toBe(selected);
  expect(focusVehicle).toHaveBeenCalledTimes(1);
  handle.select(null); sockets[0].onSnapshot(packet(2));
  expect(latest().selectedVehicleId).toBeNull();
  handle.destroy();
});
test('initializes_selection_removed_target_has_no_fallback', () => {
  const handle = start(); sockets[0].onSnapshot(packet());
  expect(latest().selectedVehicleId).toBe('TRUCK_001');
  sockets[0].onSnapshot(packet(1, ['TRUCK_002', 'TRUCK_003']));
  expect(latest().selectedVehicleId).toBeNull();
  sockets[0].onSnapshot(packet(2)); expect(latest().selectedVehicleId).toBeNull();
  expect(f.viewer.entities.getById('TRUCK_001')?.point?.outlineWidth?.getValue(time)).toBe(2);
  handle.destroy();
});
test('initializes_selection_rollback_preserves_camera_and_next_packet_initializes', () => {
  const original = Cartesian3.clone(f.camera.positionWC);
  vi.mocked(focusVehicle).mockImplementationOnce(() => {
    Cartesian3.clone(new Cartesian3(2, 3, 4), f.camera.positionWC); throw new Error('focus failed');
  });
  const handle = start();
  expect(() => sockets[0].onSnapshot(packet())).not.toThrow();
  expect(latest().snapshot).toBeNull(); expect(latest().selectedVehicleId).toBeNull();
  expect(latest().renderError).toContain('sequence 0');
  expect(f.viewer.entities.values).toHaveLength(0);
  expect(f.camera.positionWC).toEqual(original);
  sockets[0].onSnapshot(packet(1));
  expect(latest().snapshot?.sequence).toBe(1); expect(latest().selectedVehicleId).toBe('TRUCK_001');
  expect(latest().renderError).toBeNull();
  expect(f.viewer.entities.getById('TRUCK_001')?.point?.outlineWidth?.getValue(time)).toBe(3);
  expect(focusVehicle).toHaveBeenCalledTimes(2); handle.destroy();
});
test('initializes_selection_resets_for_a_new_viewer_lifecycle', () => {
  const first = start(); sockets[0].onSnapshot(packet()); first.select(null); first.destroy();
  f = makeViewer(); vi.mocked(createViewer).mockReturnValue(f.handle);
  const second = start(); sockets[1].onSnapshot(packet());
  expect(latest().selectedVehicleId).toBe('TRUCK_001'); expect(focusVehicle).toHaveBeenCalledTimes(2);
  second.destroy();
});

// Catches publication before apply/endBatch and conflating selected identity with tracked identity.
test('application_commits_one_immutable_model_per_snapshot_and_keeps_tracking_independent', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE');
  expect(latest().currentConnectionConfirmed).toBe(false);
  let before = models.length; sockets[0].onSnapshot(packet());
  expect(models.length - before).toBe(1);
  expect(Object.isFrozen(latest())).toBe(true); expect(Object.isFrozen(latest().snapshot)).toBe(true);
  const first = latest(); handle.trackSelected();
  expect(latest().trackedVehicleId).toBe('TRUCK_001');
  expect(f.viewer.trackedEntity).toBe(f.viewer.entities.getById('TRUCK_001'));
  const views = f.camera.setView.mock.calls.length;
  handle.select('TRUCK_002');
  expect(latest().selectedVehicleId).toBe('TRUCK_002'); expect(latest().trackedVehicleId).toBe('TRUCK_001');
  expect(f.camera.setView).toHaveBeenCalledTimes(views); expect(focusVehicle).toHaveBeenCalledTimes(1);
  before = models.length; sockets[0].onSnapshot(packet(1));
  expect(models.length - before).toBe(1);
  expect(latest().snapshot?.sequence).toBe(1); expect(first.snapshot?.sequence).toBe(0);
  expect(latest().selectedVehicleId).toBe('TRUCK_002'); expect(latest().trackedVehicleId).toBe('TRUCK_001');
  expect(focusVehicle).toHaveBeenCalledTimes(1);
  handle.trackSelected(); expect(latest().trackedVehicleId).toBe('TRUCK_002');
  handle.select('TRUCK_003'); handle.locateSelected();
  expect(latest().selectedVehicleId).toBe('TRUCK_003'); expect(latest().trackedVehicleId).toBeNull();
  expect(f.viewer.trackedEntity).toBeUndefined(); expect(focusVehicle).toHaveBeenCalledTimes(2);
  expect(vi.mocked(focusVehicle).mock.calls.at(-1)?.[1]).toEqual(packet(1).vehicles[2]);
  handle.stopTracking(); handle.destroy();
});
test('application_removals_and_empty_snapshot_publish_only_the_final_batch', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  handle.trackSelected(); handle.select('TRUCK_002');
  const before = models.length; sockets[0].onSnapshot(packet(1, ['TRUCK_003']));
  expect(models.length - before).toBe(1);
  expect(latest().selectedVehicleId).toBeNull(); expect(latest().trackedVehicleId).toBeNull();
  expect(f.viewer.trackedEntity).toBeUndefined(); expect(f.viewer.entities.values.map(e => e.id)).toEqual(['TRUCK_003']);
  sockets[0].onSnapshot(packet(2, []));
  expect(latest().snapshot?.vehicles).toEqual([]); expect(f.viewer.entities.values).toEqual([]);
  expect(latest().currentConnectionConfirmed).toBe(true); handle.destroy();
});
test.each(['CLOSED', 'ERROR'] as const)('application_disconnect_%s_keeps_last_picture_and_disables_new_follow', async state => {
  const handle = start(); resolveScene(); await settle();
  sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet()); handle.trackSelected();
  const entities = [...f.viewer.entities.values]; const previous = latest().snapshot;
  sockets[0].onConnectionState(state);
  expect(latest().connectionState).toBe(state); expect(latest().sceneState).toBe('READY');
  expect(latest().currentConnectionConfirmed).toBe(false); expect(latest().dataStale).toBe(true);
  expect(latest().selectedVehicleId).toBe('TRUCK_001'); expect(latest().trackedVehicleId).toBeNull();
  expect(latest().snapshot).toBe(previous); expect(f.viewer.entities.values).toEqual(entities);
  expect(f.viewer.trackedEntity).toBeUndefined(); handle.trackSelected();
  expect(latest().trackedVehicleId).toBeNull(); handle.select('TRUCK_002'); handle.locateSelected();
  expect(focusVehicle).toHaveBeenCalledTimes(2); expect(connectFleetSocket).toHaveBeenCalledTimes(1);
  handle.destroy();
});
test('application_selection_uses_actual_input_and_external_identity_loss', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  const click = f.actions.get(ScreenSpaceEventType.LEFT_CLICK) as (event: unknown) => void;
  vi.mocked(f.viewer.scene.pick).mockReturnValue({ id: f.viewer.entities.getById('TRUCK_002') });
  click({ position: { x: 1, y: 2 } }); expect(latest().selectedVehicleId).toBe('TRUCK_002');
  handle.trackSelected(); const selected = f.viewer.entities.getById('TRUCK_002')!;
  f.viewer.entities.remove(selected);
  const external = f.viewer.entities.add(new Entity({ id: 'TRUCK_002' }));
  expect(latest().selectedVehicleId).toBeNull(); expect(latest().trackedVehicleId).toBeNull();
  handle.select('TRUCK_002'); expect(latest().selectedVehicleId).toBeNull();
  handle.destroy(); expect(f.viewer.entities.getById('TRUCK_002')).toBe(external);
});

// Catches accepting failed transactions into React, misclassifying local faults and abandoned cleanup steps.
test('fatal_mutation_throw_keeps_old_snapshot_and_coordinates_but_ends_lifecycle', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  const previous = latest().snapshot; const entity = f.viewer.entities.getById('TRUCK_002')!;
  const position = entity.position as import('cesium').ConstantPositionProperty;
  const before = position.getValue(time); const actual = position.setValue.bind(position);
  vi.spyOn(position, 'setValue').mockImplementationOnce(value => { actual(value); throw new Error('setValue failed after write'); });
  expect(() => sockets[0].onSnapshot(packet(1))).not.toThrow();
  expect(latest().snapshot).toBe(previous); expect(latest().renderError).toContain('sequence 1');
  expect(position.getValue(time)).toEqual(before); expect(latest().selectedVehicleId).toBe('TRUCK_001');
  // A wrapper throw is indistinguishable from a Cesium listener throw via the public API.
  expect(latest().connectionState).toBe('LIVE'); expect(close).toHaveBeenCalledTimes(1);
  expect(f.viewer.isDestroyed()).toBe(true); expect(f.viewer.entities.values).toEqual([]);
  const count = models.length;
  sockets[0].onSnapshot(packet(2)); expect(models).toHaveLength(count);
  expect(latest().snapshot).toBe(previous); expect(latest().renderError).toContain('sequence 1');
  handle.destroy();
});
test('fatal_tracked_checkpoint_cannot_claim_complete_recovery_and_terminates', () => {
  const handle = start(model => { if (model.renderError) expect(f.viewer.isDestroyed()).toBe(false); });
  sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet()); handle.trackSelected();
  const previous = latest().snapshot; const position = f.viewer.entities.getById('TRUCK_002')!.position as import('cesium').ConstantPositionProperty;
  const actual = position.setValue.bind(position);
  vi.spyOn(position, 'setValue').mockImplementationOnce(value => { actual(value); throw new Error('tracked transaction failed'); });
  expect(() => sockets[0].onSnapshot(packet(1))).not.toThrow();
  expect(latest().snapshot).toBe(previous); expect(latest().renderError).toContain('sequence 1');
  expect(latest().connectionState).toBe('LIVE'); expect(close).toHaveBeenCalledTimes(1);
  expect(latest().currentConnectionConfirmed).toBe(false); expect(latest().dataStale).toBe(true);
  expect(f.handle.destroy).toHaveBeenCalledTimes(1); expect(f.viewer.entities.values).toEqual([]);
  const count = models.length; sockets[0].onSnapshot(packet(2)); expect(models).toHaveLength(count);
  handle.destroy();
});
test('fatal_cleanup_attempts_every_resource_keeps_primary_cause_and_retries_only_unreleased', async () => {
  const entitiesModule = await import('./vehicle/fleetEntities');
  const cameraModule = await import('./cesium/fleetCamera');
  const inputModule = await import('./vehicle/fleetInteraction');
  const order: string[] = [];
  function failOnce(label: string, release: () => void) {
    let first = true;
    return vi.fn(() => { order.push(label); if (first) { first = false; throw new Error(label); } release(); });
  }
  const realEntities = entitiesModule.createFleetEntities;
  vi.spyOn(entitiesModule, 'createFleetEntities').mockImplementation((...args) => {
    const value = realEntities(...args); return { ...value, destroy: failOnce('fleet', value.destroy) };
  });
  const realCamera = cameraModule.createFleetCamera;
  vi.spyOn(cameraModule, 'createFleetCamera').mockImplementation((...args) => {
    const value = realCamera(...args); return { ...value, destroy: failOnce('camera', value.destroy) };
  });
  const realInput = inputModule.createFleetInteraction;
  vi.spyOn(inputModule, 'createFleetInteraction').mockImplementation((...args) => {
    const value = realInput(...args); return { ...value, destroy: failOnce('input', value.destroy) };
  });
  close = failOnce('close', () => {});
  const destroyViewer = f.handle.destroy;
  f.handle.destroy = failOnce('viewer', destroyViewer);
  vi.mocked(renderMineScene).mockImplementation((...args) => {
    const value = realRenderer(...args); return { destroy: failOnce('scene', value.destroy) };
  });
  const handle = start(); resolveScene(); await settle(); sockets[0].onSnapshot(packet());
  vi.mocked(loadMineScene).mock.calls[0][0].signal.addEventListener('abort', () => { order.push('abort'); handle.destroy(); });
  const count = models.length;
  expect(() => handle.destroy()).not.toThrow();
  expect(order).toEqual(['abort', 'close', 'input', 'camera', 'fleet', 'scene', 'viewer']);
  expect(models).toHaveLength(count); expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toBeInstanceOf(AggregateError);
  expect((diagnostics[0] as AggregateError).errors).toHaveLength(6);
  handle.destroy(); expect(f.viewer.isDestroyed()).toBe(true); expect(f.viewer.entities.values).toEqual([]);
  const done = [...order]; handle.destroy(); expect(order).toEqual(done);
});

test('fatal_primary_render_error_is_the_cause_of_cleanup_diagnostics', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet()); handle.trackSelected();
  close.mockImplementation(() => { throw new Error('socket release unconfirmed'); });
  const position = f.viewer.entities.getById('TRUCK_002')!.position as import('cesium').ConstantPositionProperty;
  vi.spyOn(position, 'setValue').mockImplementationOnce(() => { throw new Error('original update fault'); });
  expect(() => sockets[0].onSnapshot(packet(1))).not.toThrow();
  expect(diagnostics).toHaveLength(1);
  expect((diagnostics[0].cause as Error)?.message).toContain('sequence 1');
  expect(((diagnostics[0].cause as Error).cause as Error)?.name).toBe('FleetRenderError');
  expect(f.handle.destroy).toHaveBeenCalledTimes(1);
  handle.destroy();
});

// Catches cleanup resurrection, operations after synchronous disposal and old callbacks affecting a remount.
test.each(['resolve', 'reject'] as const)('reentry_strictmode_setup_cleanup_setup_ignores_late_%s', async outcome => {
  const first = start(); const old = f; const oldClose = close; const oldClick = old.actions.get(ScreenSpaceEventType.LEFT_CLICK) as (event: unknown) => void;
  sockets[0].onSnapshot(packet()); first.destroy();
  expect(old.viewer.entities.values).toEqual([]); expect(oldClose).toHaveBeenCalledTimes(1);
  f = makeViewer(); close = vi.fn(); vi.mocked(createViewer).mockReturnValue(f.handle);
  const second = start(); sockets[1].onSnapshot(packet()); resolveScene(1); await settle();
  const current = [...f.viewer.entities.values]; const count = models.length;
  if (outcome === 'resolve') resolveScene(0); else requests[0].reject(new Error('late failure'));
  sockets[0].onSnapshot(packet(1)); sockets[0].onConnectionState('ERROR'); oldClick({ position: { x: 0, y: 0 } }); first.destroy();
  await settle(); expect(models).toHaveLength(count); expect(f.viewer.entities.values).toEqual(current);
  expect(f.viewer.entities.values).toHaveLength(16); expect(close).not.toHaveBeenCalled();
  expect(focusVehicle).toHaveBeenCalledTimes(2); second.destroy();
});
test.each(['collection', 'definition', 'tracking'] as const)('reentry_sync_%s_cleanup_prevents_publication_and_resurrection', kind => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  const count = models.length; const focusCount = vi.mocked(focusVehicle).mock.calls.length;
  let once = true;
  const stop = () => { if (once) { once = false; handle.destroy(); } };
  if (kind === 'collection') {
    f.viewer.entities.collectionChanged.addEventListener(stop); sockets[0].onSnapshot(packet(1, ['TRUCK_002']));
  } else if (kind === 'definition') {
    f.viewer.entities.getById('TRUCK_001')!.definitionChanged.addEventListener(stop); sockets[0].onSnapshot(packet(1));
  } else { f.viewer.trackedEntityChanged.addEventListener(stop); handle.trackSelected(); }
  expect(models).toHaveLength(count); expect(f.viewer.entities.values).toEqual([]);
  expect(f.viewer.trackedEntity).toBeUndefined(); expect(focusVehicle).toHaveBeenCalledTimes(focusCount);
  expect(f.handle.destroy).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});
test('reentry_abort_callbacks_are_inert_and_cleanup_does_not_publish', async () => {
  const handle = start(); sockets[0].onSnapshot(packet()); const count = models.length;
  const signal = vi.mocked(loadMineScene).mock.calls[0][0].signal;
  signal.addEventListener('abort', () => {
    handle.destroy(); sockets[0].onSnapshot(packet(1)); sockets[0].onConnectionState('ERROR');
    requests[0].reject(new DOMException('Aborted', 'AbortError'));
  });
  handle.destroy(); await settle(); expect(models).toHaveLength(count);
  expect(close).toHaveBeenCalledTimes(1); expect(f.handle.destroy).toHaveBeenCalledTimes(1);
});
test('reentry_scene_add_cleanup_stops_the_renderer_before_the_next_add', async () => {
  const handle = start(); sockets[0].onSnapshot(packet()); const count = models.length;
  let staticAdds = 0;
  f.viewer.entities.collectionChanged.addEventListener((_entities, added: Entity[]) => {
    if (added.some(entity => entity.id.startsWith('scene:'))) { staticAdds++; handle.destroy(); }
  });
  resolveScene(); await settle(); expect(staticAdds).toBe(1);
  expect(f.viewer.entities.values).toEqual([]); expect(models).toHaveLength(count);
});
test('reentry_render_returns_a_late_handle_and_immediately_releases_it', async () => {
  const handle = start(); const release = vi.fn();
  vi.mocked(renderMineScene).mockImplementationOnce(() => { handle.destroy(); return { destroy: release }; });
  const count = models.length; resolveScene(); await settle();
  expect(release).toHaveBeenCalledTimes(1); expect(models).toHaveLength(count);
  handle.destroy(); expect(release).toHaveBeenCalledTimes(1);
});
test('reentry_beginBatch_cleanup_does_not_enter_apply_and_endBatch_cleanup_does_not_publish', async () => {
  const module = await import('./vehicle/fleetInteraction'); const actual = module.createFleetInteraction;
  let handle: ReturnType<typeof start>;
  let endMode = false;
  const entitiesModule = await import('./vehicle/fleetEntities');
  const create = entitiesModule.createFleetEntities;
  const applies = vi.fn();
  vi.spyOn(entitiesModule, 'createFleetEntities').mockImplementation((...args) => {
    const value = create(...args); return { ...value, apply(...parameters) { applies(); return value.apply(...parameters); } };
  });
  vi.spyOn(module, 'createFleetInteraction').mockImplementation((...args) => {
    const value = actual(...args); return { ...value, beginBatch() {
      const end = value.beginBatch();
      if (!endMode) handle.destroy();
      return () => { end(); if (endMode) handle.destroy(); };
    } };
  });
  handle = start(); const count = models.length;
  sockets[0].onSnapshot(packet()); expect(models).toHaveLength(count); expect(focusVehicle).not.toHaveBeenCalled(); expect(applies).not.toHaveBeenCalled();
  f = makeViewer(); vi.mocked(createViewer).mockReturnValue(f.handle); endMode = true;
  handle = start(); const nextCount = models.length; sockets[1].onSnapshot(packet());
  expect(models).toHaveLength(nextCount); expect(f.viewer.entities.values).toEqual([]);
});
test('reentry_initial_model_destroys_viewer_before_network_and_sync_socket_return_is_released', () => {
  start(model => { if (!model.snapshot) f.handle.destroy(); });
  expect(loadMineScene).not.toHaveBeenCalled(); expect(connectFleetSocket).not.toHaveBeenCalled();
  f = makeViewer(); vi.mocked(createViewer).mockReturnValue(f.handle);
  vi.mocked(connectFleetSocket).mockImplementationOnce(options => {
    sockets.push(options); f.handle.destroy(); return { close };
  });
  const handle = start(); expect(close).toHaveBeenCalledTimes(1);
  handle.destroy(); expect(close).toHaveBeenCalledTimes(1);
});
test('reentry_model_callback_ends_lifecycle_and_no_later_scene_or_snapshot_changes_it', async () => {
  let handle: ReturnType<typeof start>;
  handle = start(model => { if (model.snapshot) handle.destroy(); });
  sockets[0].onSnapshot(packet()); const count = models.length;
  resolveScene(); sockets[0].onSnapshot(packet(1)); await settle();
  expect(models).toHaveLength(count); expect(f.viewer.entities.values).toEqual([]);
});

test('reentry_nested_snapshot_and_user_action_cannot_publish_during_an_entity_batch', () => {
  const handle = start(); sockets[0].onSnapshot(packet()); const before = models.length;
  let once = true;
  f.viewer.entities.getById('TRUCK_001')!.definitionChanged.addEventListener(() => {
    if (!once) return; once = false; handle.select('TRUCK_003'); sockets[0].onSnapshot(packet(2));
  });
  sockets[0].onSnapshot(packet(1)); expect(models.length - before).toBe(1);
  expect(latest().snapshot?.sequence).toBe(1); expect(latest().selectedVehicleId).toBe('TRUCK_001');
  expect(latest().renderError).toBeNull(); handle.destroy();
});
test('reentry_external_tracking_change_is_reflected_without_adopting_external_camera_owner', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet()); handle.trackSelected();
  const external = f.viewer.entities.add(new Entity({ id: 'external' })); f.viewer.trackedEntity = external;
  expect(latest().trackedVehicleId).toBeNull(); expect(latest().selectedVehicleId).toBe('TRUCK_001');
  handle.stopTracking(); expect(f.viewer.trackedEntity).toBe(external); handle.destroy();
});
test('reentry_camera_action_fault_is_a_local_fatal_error_and_does_not_escape_input', () => {
  const handle = start(); sockets[0].onSnapshot(packet());
  vi.mocked(focusVehicle).mockImplementationOnce(() => { throw new Error('locate failed'); });
  expect(() => handle.locateSelected()).not.toThrow(); expect(latest().renderError).toContain('locate failed');
  expect(f.handle.destroy).toHaveBeenCalledTimes(1); expect(latest().connectionState).toBe('CONNECTING');
});


test('reentry_disconnect_from_tracking_setter_is_flushed_before_the_action_model', () => {
  const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  let once = true;
  f.viewer.trackedEntityChanged.addEventListener(() => {
    if (once && f.viewer.trackedEntity) { once = false; sockets[0].onConnectionState('CLOSED'); }
  });
  handle.trackSelected();
  expect(latest().connectionState).toBe('CLOSED'); expect(latest().currentConnectionConfirmed).toBe(false);
  expect(latest().dataStale).toBe(true); expect(latest().trackedVehicleId).toBeNull();
  expect(f.viewer.trackedEntity).toBeUndefined(); handle.destroy();
});
test('parallel_synchronous_scene_request_failure_does_not_block_fleet_start', () => {
  vi.mocked(loadMineScene).mockImplementationOnce(() => { throw new Error('request setup failed'); });
  const handle = start(); expect(latest().sceneState).toBe('ERROR'); expect(sockets).toHaveLength(1);
  sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  expect(latest().snapshot?.vehicles).toHaveLength(3); expect(latest().connectionState).toBe('LIVE'); handle.destroy();
});
test('reentry_input_constructor_returns_after_viewer_disposal_and_releases_its_owned_actions', async () => {
  const module = await import('./vehicle/fleetInteraction'); const actual = module.createFleetInteraction;
  const release = vi.fn();
  vi.spyOn(module, 'createFleetInteraction').mockImplementationOnce((...args) => {
    const value = actual(...args); f.handle.destroy();
    return { ...value, destroy() { release(); value.destroy(); } };
  });
  const handle = start(); expect(release).toHaveBeenCalledTimes(1);
  expect(loadMineScene).not.toHaveBeenCalled(); expect(connectFleetSocket).not.toHaveBeenCalled();
  handle.destroy(); expect(release).toHaveBeenCalledTimes(1);
});

test('reentry_endBatch_callback_fault_is_published_before_fatal_cleanup', async () => {
  const cameraModule = await import('./cesium/fleetCamera'); const realCamera = cameraModule.createFleetCamera;
  const inputModule = await import('./vehicle/fleetInteraction'); const realInput = inputModule.createFleetInteraction;
  let failing = false;
  vi.spyOn(cameraModule, 'createFleetCamera').mockImplementationOnce((...args) => {
    const value = realCamera(...args); return { ...value, getTrackedVehicleId() {
      if (failing) throw new Error('endBatch target check failed'); return value.getTrackedVehicleId();
    } };
  });
  vi.spyOn(inputModule, 'createFleetInteraction').mockImplementationOnce((...args) => {
    const value = realInput(...args); return { ...value, beginBatch() {
      const end = value.beginBatch(); return () => { failing = true; try { end(); } finally { failing = false; } };
    } };
  });
  const handle = start(model => { if (model.renderError) expect(f.viewer.isDestroyed()).toBe(false); });
  sockets[0].onSnapshot(packet()); const previous = latest().snapshot;
  expect(() => sockets[0].onSnapshot(packet(1, ['TRUCK_001', 'TRUCK_002']))).not.toThrow();
  expect(latest().renderError).toContain('endBatch target check failed'); expect(latest().snapshot).toBe(previous);
  expect(f.handle.destroy).toHaveBeenCalledTimes(1); handle.destroy();
});

// C-I1: public notification failure must terminate before another callback can revive publication.
test.each([
  { order: 'before', mutation: 'add' }, { order: 'after', mutation: 'add' },
  { order: 'before', mutation: 'remove' }, { order: 'after', mutation: 'remove' },
] as const)('notification_fatal_blocks_next_late_and_sync_reentry_with_visualizer $order / $mutation', async ({ order, mutation }) => {
  let armed = false;
  let failed = false;
  const cause = new Error(`public ${mutation} listener failed`);
  const listen = () => f.viewer.entities.collectionChanged.addEventListener((_collection, added, removed) => {
    const affected = mutation === 'add' ? added : removed;
    if (armed && !failed && affected.some(entity => entity.id === 'TRUCK_001')) {
      failed = true;
      sockets[0].onSnapshot(packet(3)); // A synchronous callback during the transaction is also inert.
      throw cause;
    }
  });
  let removeThrower = order === 'before' ? listen() : () => {};
  const points = new Map<Entity, { id: Entity }>();
  const visualizer = new PointVisualizer({
    getPoint(entity: Entity) { const point = { id: entity }; points.set(entity, point); return point; },
    removePoint(entity: Entity) { points.delete(entity); }, removeBillboard() {},
  } as unknown as ConstructorParameters<typeof PointVisualizer>[0], f.viewer.entities);
  if (order === 'after') removeThrower = listen();
  const handle = start(model => {
    if (!model.renderError) return;
    sockets[0].onSnapshot(packet(4)); // Fatal error notification cannot open a new transaction.
    sockets[0].onConnectionState('ERROR');
  });
  resolveScene(); await settle(); sockets[0].onConnectionState('LIVE');
  if (mutation === 'remove') sockets[0].onSnapshot(packet());
  visualizer.update(time); expect(points.size).toBe(mutation === 'remove' ? 3 : 0);
  const previous = latest().snapshot;
  const old = [...f.viewer.entities.values];
  close.mockImplementationOnce(() => { throw new Error('socket close failed'); });
  armed = true;
  sockets[0].onSnapshot(packet(1, mutation === 'remove' ? ['TRUCK_002', 'TRUCK_003'] : undefined));
  expect(failed).toBe(true);
  expect(latest().snapshot).toBe(previous);
  expect(latest().renderError).toContain('sequence 1');
  expect(latest().connectionState).toBe('LIVE');
  expect(latest().currentConnectionConfirmed).toBe(false);
  expect(f.viewer.isDestroyed()).toBe(true);
  expect(f.viewer.entities.values).toEqual([]); // Both fleet and all 13 real scene resources released.
  expect(old).toHaveLength(mutation === 'remove' ? 16 : 13);
  expect(vi.mocked(loadMineScene).mock.calls[0][0].signal.aborted).toBe(true);
  expect(f.actions.has(ScreenSpaceEventType.LEFT_CLICK)).toBe(false);
  expect(f.viewer.trackedEntity).toBeUndefined();
  expect(diagnostics).toHaveLength(1);
  expect((diagnostics[0] as AggregateError).errors.some((error: Error) => error.message.includes('socket'))).toBe(true);
  expect((diagnostics[0].cause as Error).message).toContain('sequence 1');
  const count = models.length;
  removeThrower(); sockets[0].onSnapshot(packet(5)); sockets[0].onConnectionState('LIVE');
  handle.select('TRUCK_003'); handle.locateSelected(); handle.trackSelected(); handle.destroy();
  await settle();
  expect(models).toHaveLength(count); expect(f.viewer.entities.values).toEqual([]);
  expect(close).toHaveBeenCalledTimes(2); // Explicit cleanup retries the unconfirmed release only.
  expect(f.handle.destroy).toHaveBeenCalledTimes(1);
  visualizer.destroy();
});

// F-I2: a static notification throw poisons the same collection used by the fleet.
test.each([false, true].flatMap(inject => ['before', 'after'].flatMap(order =>
  ['scene-first', 'fleet-first'].map(arrival => ({ inject, order, arrival })))))(
  'static_notification_lifecycle inject=$inject / $order visualizer / $arrival', async ({ inject, order, arrival }) => {
    const points = new Map<Entity, { id: Entity; position: Cartesian3 }>();
    let failed = false;
    let reentryKeptModel = false;
    const cause = new Error('STATIC_COLLECTION_CHANGED_ONCE');
    let handle: ReturnType<typeof start>;
    const listen = () => f.viewer.entities.collectionChanged.addEventListener((_collection, added) => {
      if (!inject || failed || !added.some(entity => entity.id.startsWith('scene:'))) return;
      failed = true;
      const previous = latest();
      sockets[0].onSnapshot(packet(3));
      handle.select('TRUCK_003'); handle.locateSelected(); handle.trackSelected();
      reentryKeptModel = latest() === previous;
      throw cause;
    });
    let removeThrower = order === 'before' ? listen() : () => {};
    const cluster = {
      getPoint(entity: Entity) {
        const position = new Cartesian3();
        const point = { id: entity, get position() { return position; },
          set position(value: Cartesian3) { Cartesian3.clone(value, position); } };
        points.set(entity, point); return point;
      },
      removePoint(entity: Entity) { points.delete(entity); }, removeBillboard() {},
      destroy() { points.clear(); },
    };
    const visualizer = new PointVisualizer(cluster as unknown as ConstructorParameters<typeof PointVisualizer>[0], f.viewer.entities);
    if (order === 'after') removeThrower = listen();
    const destroyViewer = f.handle.destroy;
    f.handle.destroy = vi.fn(() => { visualizer.destroy(); cluster.destroy(); destroyViewer(); });
    handle = start(model => {
      if (!model.renderError) return;
      sockets[0].onSnapshot(packet(4)); sockets[0].onConnectionState('ERROR');
      handle.select('TRUCK_002'); handle.locateSelected(); handle.trackSelected();
    });
    sockets[0].onConnectionState('LIVE');
    if (arrival === 'fleet-first') sockets[0].onSnapshot(packet());
    visualizer.update(time);
    expect(points.size).toBe(arrival === 'fleet-first' ? 3 : 0);
    const previous = latest().snapshot;
    const originals = [...f.viewer.entities.values];
    const positions = originals.map(entity => entity.position);
    if (inject) close.mockImplementationOnce(() => { throw new Error('socket close unconfirmed'); });
    resolveScene(); await settle();
    if (!inject) {
      expect(failed).toBe(false); expect(latest().sceneState).toBe('READY');
      for (let sequence = 1; sequence <= 3; sequence++) {
        sockets[0].onSnapshot(packet(sequence)); visualizer.update(time);
        expect(f.viewer.entities.values).toHaveLength(16); expect(points.size).toBe(3);
        expect(latest().snapshot?.sequence).toBe(sequence);
        for (const [entity, point] of points) {
          expect(f.viewer.entities.getById(entity.id)).toBe(entity);
          expect(point.id).toBe(entity); expect(point.position).toEqual(entity.position!.getValue(time));
        }
        originals.forEach((entity, index) => {
          expect(f.viewer.entities.getById(entity.id)).toBe(entity); expect(entity.position).toBe(positions[index]);
        });
      }
      expect(latest().currentConnectionConfirmed).toBe(true); expect(latest().renderError).toBeNull();
      expect(close).not.toHaveBeenCalled(); handle.destroy(); removeThrower(); return;
    }
    expect(failed).toBe(true); expect(reentryKeptModel).toBe(true);
    expect(latest().snapshot).toBe(previous);
    expect(latest().sceneState).toBe('ERROR'); expect(latest().sceneError).toContain(cause.message);
    expect(latest().renderError).toContain(cause.message);
    expect(latest().connectionState).toBe('LIVE'); expect(latest().currentConnectionConfirmed).toBe(false);
    expect(latest().dataStale).toBe(previous !== null);
    expect(f.viewer.isDestroyed()).toBe(true); expect(f.viewer.entities.values).toEqual([]); expect(points.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1); expect(f.handle.destroy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadMineScene).mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.actions.has(ScreenSpaceEventType.LEFT_CLICK)).toBe(false); expect(f.viewer.trackedEntity).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect((diagnostics[0].cause as Error).message).toContain(cause.message);
    expect((diagnostics[0] as AggregateError).errors.some((error: Error) => error.message.includes('socket'))).toBe(true);
    const count = models.length;
    removeThrower(); sockets[0].onSnapshot(packet(5)); sockets[0].onConnectionState('LIVE');
    handle.select('TRUCK_003'); handle.locateSelected(); handle.trackSelected(); handle.stopTracking();
    handle.destroy(); handle.destroy(); await settle();
    expect(models).toHaveLength(count); expect(f.viewer.entities.values).toEqual([]); expect(points.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(2); expect(f.handle.destroy).toHaveBeenCalledTimes(1);
  },
);

test.each(['HTTP', 'NETWORK', 'JSON', 'SCHEMA', 'preflight'])(
  'static_safe_%s_failure_keeps_fleet_independent', async kind => {
    const handle = start(); sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
    const vehicle = f.viewer.entities.getById('TRUCK_001')!; const position = vehicle.position;
    const external = kind === 'preflight' ? f.viewer.entities.add(new Entity({ id: 'scene:DEMO_MINE:ROAD_009' })) : undefined;
    if (kind === 'preflight') resolveScene(); else requests[0].reject(new Error(`${kind} scene failure`));
    await settle();
    expect(latest().sceneState).toBe('ERROR'); expect(latest().renderError).toBeNull();
    sockets[0].onSnapshot(packet(1));
    expect(latest().snapshot?.sequence).toBe(1); expect(latest().currentConnectionConfirmed).toBe(true);
    expect(f.viewer.entities.getById('TRUCK_001')).toBe(vehicle); expect(vehicle.position).toBe(position);
    expect(vehicle.position!.getValue(time)).toEqual(Cartesian3.fromDegrees(116.0001, 39, 50));
    expect(f.viewer.entities.values).toHaveLength(external ? 4 : 3);
    expect(close).not.toHaveBeenCalled(); expect(f.viewer.isDestroyed()).toBe(false);
    handle.destroy(); if (external) expect(f.viewer.entities.values).toEqual([external]);
  },
);

test('static_batch_end_resource_failure_is_fatal_and_releases_adopted_scene', async () => {
  const handle = start(model => {
    if (model.renderError) sockets[0].onSnapshot(packet(4));
  });
  sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet());
  const previous = latest().snapshot;
  const cause = new Error('STATIC_END_BATCH_TARGET_READ_FAILED');
  let additions = 0;
  const remove = f.viewer.entities.collectionChanged.addEventListener((_collection, added) => {
    additions += added.filter(entity => entity.id.startsWith('scene:')).length;
    if (additions === 13 && added.length) {
      vi.spyOn(f.viewer, 'trackedEntity', 'get').mockImplementationOnce(() => { throw cause; });
    }
  });
  resolveScene(); await settle();
  expect(additions).toBe(13);
  expect(latest().renderError).toContain(cause.message);
  expect(latest().snapshot).toBe(previous); expect(latest().currentConnectionConfirmed).toBe(false);
  expect(latest().connectionState).toBe('LIVE'); expect(latest().dataStale).toBe(true);
  expect(f.viewer.isDestroyed()).toBe(true); expect(f.viewer.entities.values).toEqual([]);
  expect(close).toHaveBeenCalledTimes(1); expect(f.handle.destroy).toHaveBeenCalledTimes(1);
  const count = models.length;
  sockets[0].onSnapshot(packet(5)); sockets[0].onConnectionState('LIVE');
  handle.destroy(); handle.destroy(); remove();
  expect(models).toHaveLength(count); expect(f.viewer.entities.values).toEqual([]);
});

test.each(['healthy', 'safe-prepare', 'notification-fatal', 'end-batch-fatal'])(
  'static_pending_connection_is_committed_on_%s_exit', async kind => {
    const cause = new Error(`STATIC_PENDING_${kind}`);
    const fatal = kind.endsWith('fatal');
    const handle = start(model => {
      if (model.renderError) {
        sockets[0].onSnapshot(packet(4)); sockets[0].onConnectionState('LIVE');
      }
    });
    sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet()); handle.trackSelected();
    const previous = latest().snapshot; const count = models.length;
    let additions = 0;
    const remove = f.viewer.entities.collectionChanged.addEventListener((_collection, added) => {
      const statics = added.filter(entity => entity.id.startsWith('scene:'));
      additions += statics.length;
      if (additions === 1 && statics.length) {
        sockets[0].onConnectionState('CLOSED');
        if (kind === 'notification-fatal') throw cause;
        if (kind === 'safe-prepare') vi.spyOn(Cartesian3, 'fromDegrees').mockImplementationOnce(() => { throw cause; });
      }
      if (kind === 'end-batch-fatal' && additions === 13 && statics.length) {
        vi.spyOn(f.viewer, 'trackedEntity', 'get').mockImplementationOnce(() => { throw cause; });
      }
    });
    resolveScene(); await settle();
    expect(models).toHaveLength(count + 1);
    expect(latest().connectionState).toBe('CLOSED'); expect(latest().currentConnectionConfirmed).toBe(false);
    expect(latest().dataStale).toBe(true); expect(latest().snapshot).toBe(previous);
    expect(latest().sceneState).toBe(kind === 'healthy' ? 'READY' : 'ERROR');
    if (kind !== 'healthy') expect(latest().sceneError).toContain(cause.message);
    expect(f.viewer.trackedEntity).toBeUndefined(); expect(f.viewer.isDestroyed()).toBe(fatal);
    expect(f.viewer.entities.values).toHaveLength(fatal ? 0 : kind === 'healthy' ? 16 : 3);
    if (fatal) {
      expect(latest().renderError).toContain(cause.message); expect(close).toHaveBeenCalledTimes(1);
      sockets[0].onSnapshot(packet(5)); sockets[0].onConnectionState('LIVE');
      expect(models).toHaveLength(count + 1); expect(latest().snapshot).toBe(previous);
    } else {
      expect(latest().renderError).toBeNull(); expect(close).not.toHaveBeenCalled();
      sockets[0].onSnapshot(packet(1));
      expect(latest().snapshot?.sequence).toBe(1); expect(latest().currentConnectionConfirmed).toBe(false);
      expect(latest().connectionState).toBe('CLOSED');
    }
    handle.destroy(); remove();
  },
);

test.each(['safe-prepare', 'notification-fatal'])(
  'static_pending_connection_release_failure_preserves_%s_cause', async kind => {
    const sceneCause = new Error(`STATIC_ORIGINAL_${kind}`);
    const releaseCause = new Error('STATIC_PENDING_CAMERA_RELEASE_FAILED');
    const handle = start(model => {
      if (model.renderError) { sockets[0].onSnapshot(packet(4)); sockets[0].onConnectionState('LIVE'); }
    });
    sockets[0].onConnectionState('LIVE'); sockets[0].onSnapshot(packet()); handle.trackSelected();
    const previous = latest().snapshot; const count = models.length;
    let injected = false;
    const remove = f.viewer.entities.collectionChanged.addEventListener((_collection, added) => {
      if (injected || !added.some(entity => entity.id.startsWith('scene:'))) return;
      injected = true; sockets[0].onConnectionState('CLOSED');
      f.camera.setView.mockImplementationOnce(() => {
        sockets[0].onSnapshot(packet(3)); sockets[0].onConnectionState('ERROR');
        throw releaseCause;
      });
      if (kind === 'notification-fatal') throw sceneCause;
      vi.spyOn(Cartesian3, 'fromDegrees').mockImplementationOnce(() => { throw sceneCause; });
    });
    resolveScene(); await settle();
    expect(injected).toBe(true); expect(models).toHaveLength(count + 1);
    expect(latest().snapshot).toBe(previous); expect(latest().sceneState).toBe('ERROR');
    expect(latest().sceneError).toContain(sceneCause.message); expect(latest().renderError).toContain(sceneCause.message);
    expect(latest().connectionState).toBe(kind === 'safe-prepare' ? 'ERROR' : 'CLOSED');
    expect(latest().currentConnectionConfirmed).toBe(false); expect(latest().dataStale).toBe(true);
    expect(f.viewer.isDestroyed()).toBe(true); expect(f.viewer.entities.values).toEqual([]);
    if (kind === 'safe-prepare') expect(latest().renderError).toContain(releaseCause.message);
    else {
      expect(diagnostics).toHaveLength(1);
      expect((diagnostics[0].cause as Error).message).toContain(sceneCause.message);
      const errors = (diagnostics[0] as AggregateError).errors as Error[];
      expect(errors.some(error => error.message.includes('camera') &&
        ((error.cause as Error).cause as Error).message === releaseCause.message)).toBe(true);
    }
    sockets[0].onSnapshot(packet(5)); handle.destroy(); remove();
    expect(models).toHaveLength(count + 1);
  },
);
