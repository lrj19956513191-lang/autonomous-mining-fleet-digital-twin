import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Cartesian3, ConstantPositionProperty, Entity, EntityCollection, JulianDate, type Viewer } from 'cesium';
import App, { startVehicleScene } from './App';
import { createViewer, type ViewerHandle } from './cesium/viewer';
import { connectVehicleSocket, type VehicleSocketOptions } from './realtime/vehicleSocket';
import { upsertVehicleEntity } from './vehicle/vehicleEntity';
import { focusVehicle } from './cesium/camera';
import type { VehicleTelemetry } from './realtime/vehicleTelemetry';
import { loadMineScene, parseMineScene, SceneLoadError, type MineScene } from './scene/sceneClient';
import { renderMineScene, SceneRenderError } from './scene/sceneRenderer';
import { makeSceneInput } from './scene/sceneFixtures';
import * as backendConnection from './backendConnection';

vi.mock('react', { spy: true });
vi.mock('./cesium/viewer', () => ({ createViewer: vi.fn() }));
vi.mock('./realtime/vehicleSocket', () => ({ connectVehicleSocket: vi.fn() }));
vi.mock('./vehicle/vehicleEntity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vehicle/vehicleEntity')>();
  return { ...actual, upsertVehicleEntity: vi.fn(actual.upsertVehicleEntity) };
});
vi.mock('./scene/sceneClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scene/sceneClient')>();
  return { ...actual, loadMineScene: vi.fn() };
});
vi.mock('./scene/sceneRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scene/sceneRenderer')>();
  return { ...actual, renderMineScene: vi.fn(actual.renderMineScene) };
});
vi.mock('./cesium/camera', () => ({ focusVehicle: vi.fn() }));

const container = {} as HTMLElement; // Forwarded opaque DOM boundary; no Node DOM/WebGL renderer.
let handle: ViewerHandle;
let socketClose: ReturnType<typeof vi.fn<() => void>>;
let socketOptions: VehicleSocketOptions[];
let destroyed: boolean;
let order: string[];
let sceneRequests: ReturnType<typeof deferred<MineScene>>[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function sceneFixture(): MineScene {
  const scene = parseMineScene(makeSceneInput());
  if (!scene) throw new Error('Invalid test scene');
  return scene;
}
async function settleScene() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeCallbacks() {
  return {
    onConnectionState: vi.fn<(state: import('./realtime/vehicleSocket').ConnectionState) => void>(),
    onVehicleReceived: vi.fn<(received: boolean) => void>(),
    onSceneError: vi.fn<(message: string | null) => void>(),
    onSceneLoadState: vi.fn<(state: import('./App').SceneLoadState) => void>(),
  };
}

function makeTelemetry(): VehicleTelemetry {
  return {
    vehicle_id: 'TRUCK_001', timestamp: '2026-10-01T13:18:02.936773+00:00',
    longitude: 116.4254, latitude: 39.9177, height: 50,
    heading: 45, speed: 25, soc: 54.6, load: 65, status: 'running',
  };
}

const { upsertVehicleEntity: realUpsert } = await vi.importActual<typeof import('./vehicle/vehicleEntity')>('./vehicle/vehicleEntity');
const { renderMineScene: realRender } = await vi.importActual<typeof import('./scene/sceneRenderer')>('./scene/sceneRenderer');

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_VEHICLE_WS_URL', undefined);
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);
  destroyed = false;
  order = [];
  socketOptions = [];
  sceneRequests = [];
  vi.mocked(loadMineScene).mockImplementation(() => {
    const request = deferred<MineScene>();
    sceneRequests.push(request);
    return request.promise;
  });
  const viewer = {
    entities: new EntityCollection(), isDestroyed: () => destroyed,
  } as unknown as Viewer;
  handle = { viewer, destroy: vi.fn(() => { destroyed = true; order.push('destroy'); }) };
  socketClose = vi.fn(() => { order.push('close'); });
  vi.mocked(createViewer).mockReturnValue(handle);
  vi.mocked(connectVehicleSocket).mockImplementation((options) => {
    order.push('socket');
    socketOptions.push(options);
    options.onConnectionState('CONNECTING');
    return { close: socketClose };
  });
  vi.mocked(upsertVehicleEntity).mockImplementation((entities, telemetry) => {
    order.push('entity');
    return realUpsert(entities, telemetry);
  });
  vi.mocked(focusVehicle).mockImplementation(() => { order.push('focus'); });
  vi.mocked(renderMineScene).mockImplementation((entities, scene) => {
    const sceneHandle = realRender(entities, scene);
    return { destroy: vi.fn(() => { order.push('scene.destroy'); sceneHandle.destroy(); }) };
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('renders_scene_loading_status', () => {
  const markup = renderToStaticMarkup(createElement(App));
  expect(markup).toContain('Autonomous Mining Fleet Digital Twin');
  expect(markup).toContain('Connection:');
  expect(markup).toContain('CONNECTING');
  expect(markup).toContain('Vehicle:');
  expect(markup).toContain('waiting for TRUCK_001');
  expect(markup).toContain('Scene: LOADING');
  expect(markup).toContain('id="cesium-container"');
});

test('creates the viewer with the supplied container during setup', () => {
  startVehicleScene(container, makeCallbacks());
  expect(createViewer).toHaveBeenCalledExactlyOnceWith(container);
});

test('connects one socket after creating the viewer with the default URL and callbacks', () => {
  startVehicleScene(container, makeCallbacks());
  expect(connectVehicleSocket).toHaveBeenCalledTimes(1);
  expect(vi.mocked(createViewer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(connectVehicleSocket).mock.invocationCallOrder[0]);
  expect(socketOptions[0].url).toBe('ws://127.0.0.1:8000/ws/vehicles');
  expect(socketOptions[0].onTelemetry).toBeTypeOf('function');
  expect(socketOptions[0].onConnectionState).toBeTypeOf('function');
});

test.each(['CONNECTING', 'LIVE', 'ERROR', 'CLOSED'] as const)(
  'forwards %s to the page state callback without destroying the scene', (state) => {
    const callbacks = makeCallbacks();
    startVehicleScene(container, callbacks);
    socketOptions[0].onConnectionState(state);
    expect(callbacks.onConnectionState).toHaveBeenLastCalledWith(state);
    expect(handle.destroy).not.toHaveBeenCalled();
    expect(socketClose).not.toHaveBeenCalled();
  },
);

test('passes telemetry unchanged to the viewer entity collection and reports receipt', () => {
  const callbacks = makeCallbacks();
  startVehicleScene(container, callbacks);
  const telemetry = makeTelemetry();
  socketOptions[0].onTelemetry(telemetry);
  expect(upsertVehicleEntity).toHaveBeenCalledExactlyOnceWith(handle.viewer.entities, telemetry);
  expect(vi.mocked(upsertVehicleEntity).mock.calls[0][1]).toBe(telemetry);
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(true);
});

test('focuses once after the first successful entity update while processing three messages', () => {
  const callbacks = makeCallbacks();
  startVehicleScene(container, callbacks);
  order = [];
  const telemetry = makeTelemetry();
  for (let index = 0; index < 3; index++) {
    socketOptions[0].onTelemetry({ ...telemetry, longitude: telemetry.longitude + index * 0.0001 });
  }
  expect(upsertVehicleEntity).toHaveBeenCalledTimes(3);
  expect(focusVehicle).toHaveBeenCalledExactlyOnceWith(handle.viewer, telemetry);
  expect(order).toEqual(['entity', 'focus', 'entity', 'entity']);
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(true);
});

test('closes the socket before destroying the viewer and releases each only once', () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const stateCallsBeforeCleanup = callbacks.onConnectionState.mock.calls.length;
  order = [];
  cleanup();
  cleanup();
  expect(order).toEqual(['close', 'destroy']);
  expect(socketClose).toHaveBeenCalledTimes(1);
  expect(handle.destroy).toHaveBeenCalledTimes(1);
  expect(callbacks.onConnectionState).toHaveBeenCalledTimes(stateCallsBeforeCleanup);
});

test('ignores cached telemetry and state callbacks after cleanup', () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  cleanup();
  const stateCalls = callbacks.onConnectionState.mock.calls.length;
  const receivedCalls = callbacks.onVehicleReceived.mock.calls.length;
  socketOptions[0].onTelemetry(makeTelemetry());
  socketOptions[0].onConnectionState('CLOSED');
  expect(upsertVehicleEntity).not.toHaveBeenCalled();
  expect(focusVehicle).not.toHaveBeenCalled();
  expect(callbacks.onConnectionState).toHaveBeenCalledTimes(stateCalls);
  expect(callbacks.onVehicleReceived).toHaveBeenCalledTimes(receivedCalls);
});

test('ignores telemetry when the viewer has already been destroyed externally', () => {
  const callbacks = makeCallbacks();
  startVehicleScene(container, callbacks);
  destroyed = true;
  socketOptions[0].onTelemetry(makeTelemetry());
  expect(upsertVehicleEntity).not.toHaveBeenCalled();
  expect(focusVehicle).not.toHaveBeenCalled();
  expect(callbacks.onVehicleReceived).not.toHaveBeenCalledWith(true);
});

test('resets waiting and scene error on every setup before allocating resources', () => {
  const callbacks = makeCallbacks();
  startVehicleScene(container, callbacks);
  expect(callbacks.onVehicleReceived).toHaveBeenCalledExactlyOnceWith(false);
  expect(callbacks.onSceneError).toHaveBeenCalledExactlyOnceWith(null);
  expect(callbacks.onSceneLoadState).toHaveBeenCalledExactlyOnceWith('LOADING');
  expect(callbacks.onSceneLoadState.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(createViewer).mock.invocationCallOrder[0]);
  expect(callbacks.onVehicleReceived.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createViewer).mock.invocationCallOrder[0]);
  expect(callbacks.onSceneError.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createViewer).mock.invocationCallOrder[0]);
});

test.each([
  { env: undefined, expected: 'ws://127.0.0.1:8000/ws/vehicles', name: 'unset' },
  { env: '   ', expected: 'ws://127.0.0.1:8000/ws/vehicles', name: 'blank' },
  { env: '  ws://127.0.0.1:9000/ws/vehicles  ', expected: 'ws://127.0.0.1:9000/ws/vehicles', name: 'explicit trimmed' },
])('uses $name environment URL or fallback', ({ env, expected }) => {
  vi.stubEnv('VITE_VEHICLE_WS_URL', env);
  if (expected.includes(':9000')) vi.stubEnv('VITE_BACKEND_ORIGIN', 'http://127.0.0.1:9000');
  const cleanup = startVehicleScene(container, makeCallbacks());
  expect(socketOptions[0].url).toBe(expected);
  cleanup();
});

test('surfaces viewer initialization failure without opening a socket', () => {
  vi.mocked(createViewer).mockImplementationOnce(() => { throw new Error('Scene initialization failed'); });
  const callbacks = makeCallbacks();
  let cleanup: (() => void) | undefined;
  expect(() => { cleanup = startVehicleScene(container, callbacks); }).not.toThrow();
  expect(callbacks.onSceneError).toHaveBeenLastCalledWith('Scene initialization failed');
  expect(callbacks.onConnectionState).toHaveBeenLastCalledWith('CLOSED');
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(false);
  expect(connectVehicleSocket).not.toHaveBeenCalled();
  expect(loadMineScene).not.toHaveBeenCalled();
  expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('ERROR');
  expect(() => { cleanup?.(); cleanup?.(); }).not.toThrow();
});

test('supports StrictMode setup cleanup setup with independent first focus and stale event guards', () => {
  const callbacks = makeCallbacks();
  const firstHandle = handle;
  const firstClose = socketClose;
  const cleanupFirst = startVehicleScene(container, callbacks);
  socketOptions[0].onTelemetry(makeTelemetry());
  cleanupFirst();

  let secondDestroyed = false;
  const secondViewer = {
    entities: new EntityCollection(), isDestroyed: () => secondDestroyed,
  } as unknown as Viewer;
  const secondHandle: ViewerHandle = {
    viewer: secondViewer, destroy: vi.fn(() => { secondDestroyed = true; }),
  };
  const secondClose = vi.fn<() => void>();
  vi.mocked(createViewer).mockReturnValueOnce(secondHandle);
  socketClose = secondClose;
  const cleanupSecond = startVehicleScene(container, callbacks);
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(false);
  expect(callbacks.onSceneError).toHaveBeenLastCalledWith(null);
  socketOptions[1].onConnectionState('LIVE');
  const stateCalls = callbacks.onConnectionState.mock.calls.length;
  socketOptions[0].onConnectionState('CLOSED');
  socketOptions[0].onTelemetry(makeTelemetry());
  expect(callbacks.onConnectionState).toHaveBeenCalledTimes(stateCalls);
  expect(callbacks.onConnectionState).toHaveBeenLastCalledWith('LIVE');
  expect(upsertVehicleEntity).toHaveBeenCalledTimes(1);
  socketOptions[1].onTelemetry(makeTelemetry());
  expect(upsertVehicleEntity).toHaveBeenCalledTimes(2);
  expect(vi.mocked(upsertVehicleEntity).mock.calls[1][0]).toBe(secondViewer.entities);
  expect(focusVehicle).toHaveBeenCalledTimes(2);
  expect(vi.mocked(focusVehicle).mock.calls[0][0]).toBe(firstHandle.viewer);
  expect(vi.mocked(focusVehicle).mock.calls[1][0]).toBe(secondViewer);
  cleanupFirst();
  expect(firstClose).toHaveBeenCalledTimes(1);
  expect(firstHandle.destroy).toHaveBeenCalledTimes(1);
  expect(secondHandle.destroy).not.toHaveBeenCalled();
  expect(secondClose).not.toHaveBeenCalled();
  cleanupSecond();
  expect(secondClose).toHaveBeenCalledTimes(1);
  expect(secondHandle.destroy).toHaveBeenCalledTimes(1);
  expect(callbacks.onVehicleReceived.mock.calls.filter(([received]) => !received)).toHaveLength(2);
  expect(callbacks.onSceneError).toHaveBeenCalledTimes(2);
});

test('does not consume first focus when an entity update fails', () => {
  const callbacks = makeCallbacks();
  startVehicleScene(container, callbacks);
  vi.mocked(upsertVehicleEntity).mockImplementationOnce(() => { throw new Error('Entity update failed'); });
  expect(() => socketOptions[0].onTelemetry(makeTelemetry())).toThrow('Entity update failed');
  expect(focusVehicle).not.toHaveBeenCalled();
  expect(callbacks.onVehicleReceived).not.toHaveBeenCalledWith(true);
  socketOptions[0].onTelemetry(makeTelemetry());
  expect(focusVehicle).toHaveBeenCalledTimes(1);
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(true);
});

test('blocks reentrant callbacks while closing the socket before viewer destruction', () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const statesBeforeCleanup = callbacks.onConnectionState.mock.calls.length;
  const receivedBeforeCleanup = callbacks.onVehicleReceived.mock.calls.length;
  const errorsBeforeCleanup = callbacks.onSceneError.mock.calls.length;
  socketClose.mockImplementationOnce(() => {
    expect(destroyed).toBe(false);
    socketOptions[0].onTelemetry(makeTelemetry());
    socketOptions[0].onConnectionState('CLOSED');
  });
  cleanup();
  expect(upsertVehicleEntity).not.toHaveBeenCalled();
  expect(focusVehicle).not.toHaveBeenCalled();
  expect(callbacks.onConnectionState).toHaveBeenCalledTimes(statesBeforeCleanup);
  expect(callbacks.onVehicleReceived).toHaveBeenCalledTimes(receivedBeforeCleanup);
  expect(callbacks.onSceneError).toHaveBeenCalledTimes(errorsBeforeCleanup);
  expect(handle.destroy).toHaveBeenCalledTimes(1);
});

test.each(['CLOSED', 'ERROR'] as const)('preserves the last entity and received state on %s until cleanup', (state) => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const position = new ConstantPositionProperty(new Cartesian3(1, 2, 3));
  const entity = new Entity({ id: 'TRUCK_001', position });
  vi.mocked(upsertVehicleEntity).mockImplementationOnce((entities) => entities.add(entity));
  socketOptions[0].onTelemetry(makeTelemetry());
  const time = JulianDate.fromIso8601('2026-10-01T13:18:02Z');
  const lastPosition = entity.position?.getValue(time);
  const receivedCalls = callbacks.onVehicleReceived.mock.calls.length;

  socketOptions[0].onConnectionState(state);
  expect(callbacks.onConnectionState).toHaveBeenLastCalledWith(state);
  expect(callbacks.onVehicleReceived).toHaveBeenCalledTimes(receivedCalls);
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(true);
  expect(handle.viewer.entities.getById('TRUCK_001')).toBe(entity);
  expect(handle.viewer.entities.values).toHaveLength(1);
  expect(entity.position).toBe(position);
  expect(entity.position?.getValue(time)).toEqual(lastPosition);
  expect(handle.destroy).not.toHaveBeenCalled();
  expect(socketClose).not.toHaveBeenCalled();
  cleanup();
  expect(handle.destroy).toHaveBeenCalledTimes(1);
});

test('starts_scene_fetch_and_socket_in_parallel', () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://mine.example:9443');
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  expect(createViewer).toHaveBeenCalledExactlyOnceWith(container);
  expect(loadMineScene).toHaveBeenCalledTimes(1);
  const request = vi.mocked(loadMineScene).mock.calls[0][0];
  expect(request.url).toBe('/api/scene');
  expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(request.signal.aborted).toBe(false);
  // The HTTP promise is still pending when a live socket can deliver telemetry.
  expect(sceneRequests).toHaveLength(1);
  expect(socketOptions).toHaveLength(1);
  expect(socketOptions[0].url).toBe('wss://mine.example:9443/ws/vehicles');
  expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('LOADING');
  expect(callbacks.onSceneError).toHaveBeenLastCalledWith(null);
  expect(renderMineScene).not.toHaveBeenCalled();
  cleanup();
});
test.each([
  { origin: 'ftp://mine.example', legacy: undefined, message: /VITE_BACKEND_ORIGIN/ },
  { origin: 'http://127.0.0.1:8000', legacy: 'ws://127.0.0.1:9000/ws/vehicles', message: /VITE_VEHICLE_WS_URL/ },
])('rejects_runtime_config_before_resources: $origin / $legacy', ({ origin, legacy, message }) => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', origin);
  vi.stubEnv('VITE_VEHICLE_WS_URL', legacy);
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('ERROR');
  expect(callbacks.onConnectionState).toHaveBeenLastCalledWith('CLOSED');
  expect(callbacks.onSceneError.mock.lastCall?.[0]).toMatch(message);
  expect(callbacks.onSceneLoadState.mock.calls).toEqual([['ERROR']]);
  expect(createViewer).not.toHaveBeenCalled();
  expect(loadMineScene).not.toHaveBeenCalled();
  expect(connectVehicleSocket).not.toHaveBeenCalled();
  expect(() => { cleanup(); cleanup(); }).not.toThrow();
});

test('early_telemetry_updates_vehicle_before_scene', () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const first = makeTelemetry();
  socketOptions[0].onTelemetry(first);
  const vehicle = handle.viewer.entities.getById('TRUCK_001');
  expect(vehicle).toBeInstanceOf(Entity);
  expect(handle.viewer.entities.values).toEqual([vehicle]);
  expect(upsertVehicleEntity).toHaveBeenCalledExactlyOnceWith(handle.viewer.entities, first);
  expect(vi.mocked(upsertVehicleEntity).mock.calls[0][1]).toBe(first);
  expect(focusVehicle).toHaveBeenCalledExactlyOnceWith(handle.viewer, first);
  socketOptions[0].onTelemetry({ ...first, longitude: first.longitude + 0.0001 });
  expect(handle.viewer.entities.getById('TRUCK_001')).toBe(vehicle);
  expect(handle.viewer.entities.values).toHaveLength(1);
  expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('LOADING');
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(true);
  cleanup();
});

test('late_scene_sets_ready_without_camera_reset', async () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const telemetry = makeTelemetry();
  socketOptions[0].onTelemetry(telemetry);
  const vehicle = handle.viewer.entities.getById('TRUCK_001');
  const scene = sceneFixture();
  sceneRequests[0].resolve(scene);
  await settleScene();
  expect(renderMineScene).toHaveBeenCalledExactlyOnceWith(handle.viewer.entities, scene);
  expect(callbacks.onSceneLoadState.mock.calls).toEqual([['LOADING'], ['READY']]);
  expect(handle.viewer.entities.values.filter(entity => entity.id.startsWith('scene:DEMO_MINE:'))).toHaveLength(13);
  expect(handle.viewer.entities.values).toHaveLength(14);
  expect(handle.viewer.entities.getById('TRUCK_001')).toBe(vehicle);
  socketOptions[0].onTelemetry({ ...telemetry, longitude: telemetry.longitude + 0.0001 });
  socketOptions[0].onTelemetry({ ...telemetry, height: telemetry.height + 1 });
  expect(upsertVehicleEntity).toHaveBeenCalledTimes(3);
  expect(handle.viewer.entities.getById('TRUCK_001')).toBe(vehicle);
  expect(focusVehicle).toHaveBeenCalledExactlyOnceWith(handle.viewer, telemetry);
  cleanup();
});

test.each([
  { kind: 'NETWORK', failure: new SceneLoadError('NETWORK', 'Unable to fetch mine scene'), message: 'Unable to fetch mine scene' },
  { kind: 'HTTP', failure: new SceneLoadError('HTTP', 'Mine scene request failed: HTTP 503', { status: 503 }), message: 'Mine scene request failed: HTTP 503' },
  { kind: 'JSON', failure: new SceneLoadError('JSON', 'Unable to decode mine scene JSON'), message: 'Unable to decode mine scene JSON' },
  { kind: 'SCHEMA', failure: new SceneLoadError('SCHEMA', 'Invalid mine scene schema'), message: 'Invalid mine scene schema' },
  { kind: 'renderer', failure: new SceneRenderError('Unable to render mine scene'), message: 'Unable to render mine scene' },
  { kind: 'active AbortError', failure: new DOMException('Unexpected abort', 'AbortError'), message: 'Unexpected abort' },
  { kind: 'unknown failure', failure: 'unexpected', message: 'Unable to load mine scene' },
])('scene_failure_does_not_change_live_connection: $kind', async ({ kind, failure, message }) => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  socketOptions[0].onConnectionState('LIVE');
  const telemetry = makeTelemetry();
  socketOptions[0].onTelemetry(telemetry);
  const vehicle = handle.viewer.entities.getById('TRUCK_001');
  const connectionCalls = callbacks.onConnectionState.mock.calls.length;
  if (kind === 'renderer') {
    vi.mocked(renderMineScene).mockImplementationOnce(() => { throw failure; });
    sceneRequests[0].resolve(sceneFixture());
  } else sceneRequests[0].reject(failure);
  await settleScene();
  expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('ERROR');
  expect(callbacks.onSceneError).toHaveBeenLastCalledWith(message);
  expect(callbacks.onConnectionState).toHaveBeenCalledTimes(connectionCalls);
  expect(callbacks.onConnectionState).toHaveBeenLastCalledWith('LIVE');
  expect(socketClose).not.toHaveBeenCalled();
  socketOptions[0].onTelemetry({ ...telemetry, longitude: telemetry.longitude + 0.0001 });
  expect(handle.viewer.entities.getById('TRUCK_001')).toBe(vehicle);
  expect(handle.viewer.entities.values).toHaveLength(1);
  expect(vehicle?.position?.getValue(JulianDate.now())).toEqual(Cartesian3.fromDegrees(116.4255, 39.9177, 50));
  expect(focusVehicle).toHaveBeenCalledTimes(1);
  cleanup();
});

test.each(['ERROR', 'CLOSED'] as const)('websocket_disconnect_keeps_scene_and_last_vehicle: %s', async state => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  sceneRequests[0].resolve(sceneFixture());
  await settleScene();
  socketOptions[0].onTelemetry(makeTelemetry());
  const vehicle = handle.viewer.entities.getById('TRUCK_001');
  const position = vehicle?.position;
  const lastPosition = position?.getValue(JulianDate.now());
  const staticEntities = handle.viewer.entities.values.filter(entity => entity.id.startsWith('scene:'));
  const receivedCalls = callbacks.onVehicleReceived.mock.calls.length;
  socketOptions[0].onConnectionState('LIVE');
  socketOptions[0].onConnectionState(state);
  expect(callbacks.onConnectionState).toHaveBeenLastCalledWith(state);
  expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('READY');
  expect(handle.viewer.entities.values).toHaveLength(14);
  expect(handle.viewer.entities.values.filter(entity => entity.id.startsWith('scene:'))).toEqual(staticEntities);
  expect(handle.viewer.entities.getById('TRUCK_001')).toBe(vehicle);
  expect(vehicle?.position).toBe(position);
  expect(position?.getValue(JulianDate.now())).toEqual(lastPosition);
  expect(callbacks.onVehicleReceived).toHaveBeenCalledTimes(receivedCalls);
  expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(true);
  expect(connectVehicleSocket).toHaveBeenCalledTimes(1);
  expect(socketClose).not.toHaveBeenCalled();
  expect(handle.destroy).not.toHaveBeenCalled();
  cleanup();
});

test('cleanup_orders_abort_close_scene_destroy_viewer', async () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  sceneRequests[0].resolve(sceneFixture());
  await settleScene();
  socketOptions[0].onTelemetry(makeTelemetry());
  const vehicle = handle.viewer.entities.getById('TRUCK_001');
  const signal = vi.mocked(loadMineScene).mock.calls[0][0].signal;
  const sceneHandle = vi.mocked(renderMineScene).mock.results[0].value;
  const abortListener = vi.fn(() => {
    order.push('abort');
    expect(destroyed).toBe(false);
  });
  signal.addEventListener('abort', abortListener);
  const states = callbacks.onConnectionState.mock.calls.length;
  const received = callbacks.onVehicleReceived.mock.calls.length;
  const errors = callbacks.onSceneError.mock.calls.length;
  const sceneStates = callbacks.onSceneLoadState.mock.calls.length;
  order = [];
  cleanup();
  cleanup();
  expect(order).toEqual(['abort', 'close', 'scene.destroy', 'destroy']);
  expect(signal.aborted).toBe(true);
  expect(abortListener).toHaveBeenCalledTimes(1);
  expect(socketClose).toHaveBeenCalledTimes(1);
  expect(sceneHandle.destroy).toHaveBeenCalledTimes(1);
  expect(handle.destroy).toHaveBeenCalledTimes(1);
  expect(handle.viewer.entities.values).toEqual([vehicle]);
  expect(callbacks.onConnectionState).toHaveBeenCalledTimes(states);
  expect(callbacks.onVehicleReceived).toHaveBeenCalledTimes(received);
  expect(callbacks.onSceneError).toHaveBeenCalledTimes(errors);
  expect(callbacks.onSceneLoadState).toHaveBeenCalledTimes(sceneStates);
});

test.each(['resolve', 'reject', 'AbortError'] as const)(
  'ignores_late_scene_and_socket_callbacks after cleanup: %s', async outcome => {
    const callbacks = makeCallbacks();
    const cleanup = startVehicleScene(container, callbacks);
    cleanup();
    const before = {
      states: callbacks.onConnectionState.mock.calls.length,
      received: callbacks.onVehicleReceived.mock.calls.length,
      errors: callbacks.onSceneError.mock.calls.length,
      scene: callbacks.onSceneLoadState.mock.calls.length,
    };
    if (outcome === 'resolve') sceneRequests[0].resolve(sceneFixture());
    else sceneRequests[0].reject(outcome === 'AbortError'
      ? new DOMException('Cancelled', 'AbortError') : new Error('Late network failure'));
    socketOptions[0].onTelemetry(makeTelemetry());
    socketOptions[0].onConnectionState('LIVE');
    await settleScene();
    expect(renderMineScene).not.toHaveBeenCalled();
    expect(upsertVehicleEntity).not.toHaveBeenCalled();
    expect(focusVehicle).not.toHaveBeenCalled();
    expect(handle.viewer.entities.values).toHaveLength(0);
    expect(callbacks.onConnectionState).toHaveBeenCalledTimes(before.states);
    expect(callbacks.onVehicleReceived).toHaveBeenCalledTimes(before.received);
    expect(callbacks.onSceneError).toHaveBeenCalledTimes(before.errors);
    expect(callbacks.onSceneLoadState).toHaveBeenCalledTimes(before.scene);
  },
);

test('ignores_late_scene_and_socket_callbacks during synchronous abort reentry', async () => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const signal = vi.mocked(loadMineScene).mock.calls[0][0].signal;
  const before = [callbacks.onConnectionState.mock.calls.length, callbacks.onVehicleReceived.mock.calls.length,
    callbacks.onSceneError.mock.calls.length, callbacks.onSceneLoadState.mock.calls.length];
  const onAbort = vi.fn(() => {
    expect(destroyed).toBe(false);
    socketOptions[0].onTelemetry(makeTelemetry());
    socketOptions[0].onConnectionState('ERROR');
    sceneRequests[0].reject(new DOMException('Cancelled', 'AbortError'));
  });
  signal.addEventListener('abort', onAbort);
  cleanup();
  await settleScene();
  expect(onAbort).toHaveBeenCalledTimes(1);
  expect(upsertVehicleEntity).not.toHaveBeenCalled();
  expect(renderMineScene).not.toHaveBeenCalled();
  expect(focusVehicle).not.toHaveBeenCalled();
  expect([callbacks.onConnectionState.mock.calls.length, callbacks.onVehicleReceived.mock.calls.length,
    callbacks.onSceneError.mock.calls.length, callbacks.onSceneLoadState.mock.calls.length]).toEqual(before);
});

test.each(['resolve', 'reject'] as const)('ignores scene %s for an externally destroyed viewer', async outcome => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  const before = [callbacks.onConnectionState.mock.calls.length, callbacks.onVehicleReceived.mock.calls.length,
    callbacks.onSceneError.mock.calls.length, callbacks.onSceneLoadState.mock.calls.length];
  destroyed = true;
  if (outcome === 'resolve') sceneRequests[0].resolve(sceneFixture());
  else sceneRequests[0].reject(new Error('Late failure for destroyed viewer'));
  socketOptions[0].onTelemetry(makeTelemetry());
  socketOptions[0].onConnectionState('LIVE');
  await settleScene();
  expect(renderMineScene).not.toHaveBeenCalled();
  expect(upsertVehicleEntity).not.toHaveBeenCalled();
  expect(handle.viewer.entities.values).toHaveLength(0);
  expect([callbacks.onConnectionState.mock.calls.length, callbacks.onVehicleReceived.mock.calls.length,
    callbacks.onSceneError.mock.calls.length, callbacks.onSceneLoadState.mock.calls.length]).toEqual(before);
  cleanup();
});

test.each(['pending resolve', 'pending reject', 'rendered'] as const)(
  'strictmode_remount_is_independent: %s', async firstOutcome => {
    const callbacks = makeCallbacks();
    const firstHandle = handle;
    const firstClose = socketClose;
    const cleanupFirst = startVehicleScene(container, callbacks);
    const firstSignal = vi.mocked(loadMineScene).mock.calls[0][0].signal;
    socketOptions[0].onTelemetry(makeTelemetry());
    let oldSceneHandle: ReturnType<typeof renderMineScene> | undefined;
    if (firstOutcome === 'rendered') {
      sceneRequests[0].resolve(sceneFixture());
      await settleScene();
      oldSceneHandle = vi.mocked(renderMineScene).mock.results[0].value;
    }
    cleanupFirst();
    expect(firstSignal.aborted).toBe(true);
    let secondDestroyed = false;
    const secondViewer = { entities: new EntityCollection(), isDestroyed: () => secondDestroyed } as unknown as Viewer;
    const secondHandle: ViewerHandle = { viewer: secondViewer, destroy: vi.fn(() => { secondDestroyed = true; }) };
    const secondClose = vi.fn<() => void>();
    vi.mocked(createViewer).mockReturnValueOnce(secondHandle);
    socketClose = secondClose;
    const cleanupSecond = startVehicleScene(container, callbacks);
    const secondSignal = vi.mocked(loadMineScene).mock.calls[1][0].signal;
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
    expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('LOADING');
    expect(callbacks.onSceneError).toHaveBeenLastCalledWith(null);
    expect(callbacks.onVehicleReceived).toHaveBeenLastCalledWith(false);
    socketOptions[1].onConnectionState('LIVE');
    socketOptions[1].onTelemetry(makeTelemetry());
    sceneRequests[1].resolve(sceneFixture());
    await settleScene();
    const secondEntities = [...secondViewer.entities.values];
    expect(secondEntities).toHaveLength(14);
    expect(secondViewer.entities.getById('TRUCK_001')).not.toBe(firstHandle.viewer.entities.getById('TRUCK_001'));
    const before = [callbacks.onConnectionState.mock.calls.length, callbacks.onVehicleReceived.mock.calls.length,
      callbacks.onSceneError.mock.calls.length, callbacks.onSceneLoadState.mock.calls.length];
    if (firstOutcome === 'pending reject') sceneRequests[0].reject(new Error('Old request failed'));
    else sceneRequests[0].resolve(sceneFixture());
    socketOptions[0].onTelemetry({ ...makeTelemetry(), height: 999 });
    socketOptions[0].onConnectionState('CLOSED');
    cleanupFirst();
    oldSceneHandle?.destroy();
    await settleScene();
    expect(secondViewer.entities.values).toEqual(secondEntities);
    expect([callbacks.onConnectionState.mock.calls.length, callbacks.onVehicleReceived.mock.calls.length,
      callbacks.onSceneError.mock.calls.length, callbacks.onSceneLoadState.mock.calls.length]).toEqual(before);
    expect(callbacks.onSceneLoadState).toHaveBeenLastCalledWith('READY');
    expect(callbacks.onConnectionState).toHaveBeenLastCalledWith('LIVE');
    expect(createViewer).toHaveBeenCalledTimes(2);
    expect(connectVehicleSocket).toHaveBeenCalledTimes(2);
    expect(upsertVehicleEntity).toHaveBeenCalledTimes(2);
    expect(focusVehicle).toHaveBeenCalledTimes(2);
    expect(vi.mocked(focusVehicle).mock.calls[0][0]).toBe(firstHandle.viewer);
    expect(vi.mocked(focusVehicle).mock.calls[1][0]).toBe(secondViewer);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(firstHandle.destroy).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(secondHandle.destroy).not.toHaveBeenCalled();
    expect(secondSignal.aborted).toBe(false);
    cleanupSecond();
    expect(secondSignal.aborted).toBe(true);
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(secondHandle.destroy).toHaveBeenCalledTimes(1);
    expect(secondViewer.entities.values).toHaveLength(1);
  },
);

test.each(['READY', 'ERROR'] as const)('scene_ready_and_ui_states_are_forwarded: %s', async sceneState => {
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  expect(callbacks.onSceneLoadState.mock.calls).toEqual([['LOADING']]);
  expect(callbacks.onConnectionState.mock.calls).toEqual([['CONNECTING'], ['CONNECTING']]);
  socketOptions[0].onConnectionState('LIVE');
  if (sceneState === 'READY') sceneRequests[0].resolve(sceneFixture());
  else sceneRequests[0].reject(new SceneLoadError('SCHEMA', 'Invalid mine scene schema'));
  await settleScene();
  expect(callbacks.onSceneLoadState.mock.calls).toEqual([['LOADING'], [sceneState]]);
  expect(callbacks.onConnectionState.mock.calls).toEqual([['CONNECTING'], ['CONNECTING'], ['LIVE']]);
  socketOptions[0].onConnectionState('ERROR');
  socketOptions[0].onConnectionState('CLOSED');
  expect(callbacks.onSceneLoadState.mock.calls).toEqual([['LOADING'], [sceneState]]);
  expect(callbacks.onConnectionState.mock.calls).toEqual([['CONNECTING'], ['CONNECTING'], ['LIVE'], ['ERROR'], ['CLOSED']]);
  expect(callbacks.onSceneError).toHaveBeenLastCalledWith(sceneState === 'READY' ? null : 'Invalid mine scene schema');
  cleanup();
});

test.each([
  { failure: new Error('Scene initialization failed'), message: 'Scene initialization failed' },
  { failure: 'unknown viewer failure', message: 'Unable to initialize Cesium scene' },
])('scene_ready_and_ui_states_are_forwarded for viewer failure: $message', ({ failure, message }) => {
  vi.mocked(createViewer).mockImplementationOnce(() => { throw failure; });
  const callbacks = makeCallbacks();
  const cleanup = startVehicleScene(container, callbacks);
  expect(callbacks.onSceneLoadState.mock.calls).toEqual([['ERROR']]);
  expect(callbacks.onSceneError.mock.calls).toEqual([[null], [message]]);
  expect(callbacks.onConnectionState.mock.calls).toEqual([['CLOSED']]);
  expect(callbacks.onVehicleReceived.mock.calls).toEqual([[false]]);
  expect(loadMineScene).not.toHaveBeenCalled();
  expect(connectVehicleSocket).not.toHaveBeenCalled();
  expect(() => { cleanup(); cleanup(); }).not.toThrow();
});

test('initializes_scene_in_the_required_order_before_parallel_network_startup', () => {
  const startup: string[] = [];
  const actualResolve = backendConnection.resolveBackendConnection;
  vi.spyOn(backendConnection, 'resolveBackendConnection').mockImplementation(env => {
    startup.push('resolve');
    return actualResolve(env);
  });
  const ActualAbortController = globalThis.AbortController;
  vi.stubGlobal('AbortController', class extends ActualAbortController {
    constructor() { super(); startup.push('controller'); }
  });
  const callbacks = makeCallbacks();
  callbacks.onVehicleReceived.mockImplementation(received => { startup.push(`received:${received}`); });
  callbacks.onSceneError.mockImplementation(message => { startup.push(`error:${message}`); });
  callbacks.onSceneLoadState.mockImplementation(state => { startup.push(`scene:${state}`); });
  callbacks.onConnectionState.mockImplementation(state => { startup.push(`connection:${state}`); });
  vi.mocked(createViewer).mockImplementationOnce(() => { startup.push('viewer'); return handle; });
  vi.mocked(loadMineScene).mockImplementationOnce(({ signal }) => {
    startup.push('load');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    const request = deferred<MineScene>();
    sceneRequests.push(request);
    return request.promise;
  });
  const transportConnect = vi.mocked(connectVehicleSocket).getMockImplementation()!;
  vi.mocked(connectVehicleSocket).mockImplementationOnce(options => {
    startup.push('socket');
    return transportConnect(options);
  });
  const cleanup = startVehicleScene(container, callbacks);
  expect(startup).toEqual([
    'resolve', 'received:false', 'error:null', 'viewer', 'controller', 'scene:LOADING',
    'connection:CONNECTING', 'load', 'socket', 'connection:CONNECTING',
  ]);
  expect(sceneRequests).toHaveLength(1);
  expect(renderMineScene).not.toHaveBeenCalled();
  expect(socketOptions).toHaveLength(1);
  cleanup();
});

test('renders_fleet_summary_unconfirmed_and_controls', () => {
  const markup = renderToStaticMarkup(createElement(App));
  expect(markup).toContain('Total: unconfirmed');
  expect(markup).toContain('Online: 0');
  expect(markup).toContain('Selected: none');
  expect(markup).toContain('Tracked: none');
  expect(markup).toMatch(/disabled=""[^>]*>Locate selected/);
  expect(markup).toMatch(/disabled=""[^>]*>Track selected/);
});

// Catches UI drift between counts/list/details and the committed model, or restoring the old WS in App.
test('fleet_summary_sorts_ids_and_renders_selected_and_tracked_independently', async () => {
  const app = await import('./App');
  expect(typeof app.FleetPanel).toBe('function');
  const { parseFleetSnapshot } = await import('./realtime/fleetTelemetry');
  const { makeFleetSnapshotFixture } = await import('./realtime/fleetFixtures');
  const wire = makeFleetSnapshotFixture(); wire.vehicles.reverse();
  const snapshot = parseFleetSnapshot(wire)!;
  const model: import('./fleetScene').FleetViewModel = Object.freeze({ snapshot,
    selectedVehicleId: 'TRUCK_002', trackedVehicleId: 'TRUCK_001', sceneState: 'READY', connectionState: 'LIVE',
    sceneError: null, renderError: null, dataStale: false, currentConnectionConfirmed: true });
  const controls = { select() {}, locateSelected() {}, trackSelected() {}, stopTracking() {}, destroy() {} };
  let markup = renderToStaticMarkup(createElement(app.FleetPanel, { model, controls }));
  expect(markup).toContain('Total: 3'); expect(markup).toContain('Online: 3');
  expect(markup.indexOf('data-vehicle-id="TRUCK_001"')).toBeLessThan(markup.indexOf('data-vehicle-id="TRUCK_002"'));
  expect(markup.indexOf('data-vehicle-id="TRUCK_002"')).toBeLessThan(markup.indexOf('data-vehicle-id="TRUCK_003"'));
  expect(markup).toContain('Selected: TRUCK_002'); expect(markup).toContain('Tracked: TRUCK_001');
  expect(markup).toContain('25 km/h'); expect(markup).toContain('80%'); expect(markup).toContain('Load: 40');
  expect(markup).not.toContain('40 t'); expect(markup).toContain('117'); expect(markup).toContain('40');
  expect(markup).toContain('55 m'); expect(markup).toContain('120°'); expect(markup).toContain(wire.timestamp);
  markup = renderToStaticMarkup(createElement(app.FleetPanel, { model: { ...model, connectionState: 'CLOSED',
    currentConnectionConfirmed: false, dataStale: true }, controls }));
  expect(markup).toContain('Total: 3'); expect(markup).toContain('Online: 0'); expect(markup).toContain('stale');
  expect(markup).toMatch(/disabled=""[^>]*>Track selected/);
  expect(markup).not.toMatch(/disabled=""[^>]*>Locate selected/);
});
test('fleet_summary_default_App_starts_only_fleet_and_cleans_its_own_handle', async () => {
  const React = await import('react'); const fleet = await import('./fleetScene');
  const controls = { select: vi.fn(), locateSelected: vi.fn(), trackSelected: vi.fn(), stopTracking: vi.fn(), destroy: vi.fn() };
  const entry = vi.spyOn(fleet, 'startFleetScene').mockReturnValue(controls);
  const effects = vi.spyOn(React, 'useEffect').mockImplementation(() => {});
  vi.spyOn(React, 'useRef').mockReturnValueOnce({ current: container }).mockReturnValueOnce({ current: null });
  renderToStaticMarkup(createElement(App));
  const cleanup = effects.mock.calls[0][0]();
  expect(entry).toHaveBeenCalledTimes(1); expect(entry.mock.calls[0][0]).toBe(container);
  expect(connectVehicleSocket).not.toHaveBeenCalled();
  expect(typeof cleanup).toBe('function'); if (typeof cleanup === 'function') cleanup();
  expect(controls.destroy).toHaveBeenCalledTimes(1);
});

test('shows_live_default_and_explicit_history_mode',()=>{
  const markup=renderToStaticMarkup(createElement(App));
  expect(markup).toContain('Autonomous Mining Fleet Digital Twin');
  expect(markup).toContain('Connection:');expect(markup).toContain('Online: 0');
  expect(markup).toContain('Enter history');expect(markup).toContain('Recording: unconfirmed');
  expect(markup).not.toContain('Historical playback');
});
// Task9 mode ownership tests mock only the already-tested source/controller boundaries.
function historySummary(state:'RECORDING'|'COMPLETED'|'FAILED'|'INTERRUPTED'='COMPLETED') {
  const incomplete=state==='FAILED'||state==='INTERRUPTED';
  return {session_id:'11111111-1111-4111-8111-111111111111',state,started_utc:'2026-10-14T04:00:00+00:00',
    ended_utc:state==='RECORDING'?null:'2026-10-14T04:02:00+00:00',snapshot_count:121,first_sequence:0,
    last_sequence:120,first_simulation_time:0,last_simulation_time:120,incomplete,
    failure_code:incomplete?'WRITE_FAILED':null,failure_message:incomplete?'Prefix only':null};
}
function recordingStatus(){return {enabled:false,state:'DISABLED_CONFIG',session_id:null,last_offered_sequence:null,
  last_persisted_sequence:null,error_code:'INVALID_CONFIG',error_message:'Explicit valid recording configuration required'};}
function historyResponse(body:unknown,status=200):Response{return {ok:status>=200&&status<300,status,json:async()=>body} as Response;}
async function flushHistory(){for(let i=0;i<30;i++)await Promise.resolve();}
async function modeHarness(onModel?:(value:import('./App').AppModeModel)=>void) {
  const app=await import('./App');const fleet=await import('./fleetScene');const replay=await import('./history/replayScene');
  const events:string[]=[];const liveCallbacks:Parameters<typeof fleet.startFleetScene>[1][]=[];
  const replayCallbacks:Parameters<typeof replay.startReplayScene>[1][]=[];
  const liveHandles:ReturnType<typeof basicControls>[]=[];const replayHandles:ReturnType<typeof playbackControls>[]=[];
  const models:import('./App').AppModeModel[]=[];const diagnostics:Error[]=[];
  function basicControls(kind:string){return {select:vi.fn(),locateSelected:vi.fn(),trackSelected:vi.fn(),stopTracking:vi.fn(),
    destroy:vi.fn(()=>{events.push(kind+':ws/raf');events.push(kind+':input/camera');events.push(kind+':entities/viewer');})};}
  function playbackControls(){return {...basicControls('REPLAY'),play:vi.fn(),pause:vi.fn(),setRate:vi.fn(),seek:vi.fn(),replay:vi.fn()};}
  const liveEntry=vi.spyOn(fleet,'startFleetScene').mockImplementation((_c,cb)=>{events.push('start:LIVE');liveCallbacks.push(cb);const h=basicControls('LIVE');liveHandles.push(h);return h;});
  const replayEntry=vi.spyOn(replay,'startReplayScene').mockImplementation((_c,cb)=>{events.push('start:REPLAY');replayCallbacks.push(cb);const h=playbackControls();replayHandles.push(h);return h;});
  const fetcher=vi.fn<typeof fetch>(async input=>historyResponse(String(input).endsWith('/status')?recordingStatus():{sessions:[historySummary()],next_cursor:null}));
  vi.stubGlobal('fetch',fetcher);
  const host=app.createAppModeHost(container,{onModel(value){models.push(value);onModel?.(value);},onCleanupError(error){diagnostics.push(error);}});
  return {host,events,liveCallbacks,replayCallbacks,liveHandles,replayHandles,models,diagnostics,liveEntry,replayEntry,fetcher,app};
}
function liveModel(sequence=0):import('./fleetScene').FleetViewModel {
  return {snapshot:null,selectedVehicleId:sequence?'TRUCK_002':null,trackedVehicleId:null,sceneState:'READY',connectionState:'LIVE',sceneError:null,renderError:null,dataStale:false,currentConnectionConfirmed:true};
}
function replayModel():import('./history/replayScene').ReplayViewModel {
  return {session:null,snapshot:null,status:'PAUSED',time_seconds:0,rate:1,selectedVehicleId:null,trackedVehicleId:null,sceneState:'READY',sceneError:null,renderError:null,incomplete:false,gap:null};
}

test('releases_old_mode_before_starting_new_and_same_mode_is_noop',async()=>{
  const f=await modeHarness();expect(f.events).toEqual(['start:LIVE']);
  const id=historySummary().session_id;f.host.enterReplay(id);
  expect(f.events).toEqual(['start:LIVE','LIVE:ws/raf','LIVE:input/camera','LIVE:entities/viewer','start:REPLAY']);
  f.host.enterReplay(id);expect(f.replayEntry).toHaveBeenCalledTimes(1);f.host.goLive();
  expect(f.events.slice(-4)).toEqual(['REPLAY:ws/raf','REPLAY:input/camera','REPLAY:entities/viewer','start:LIVE']);
  f.host.goLive();expect(f.liveEntry).toHaveBeenCalledTimes(2);f.host.destroy();
});

test('late_live_callback_cannot_update_replay_and_reverse',async()=>{
  const f=await modeHarness();f.host.enterReplay(historySummary().session_id);const before=f.models.length;
  f.liveCallbacks[0].onModel(liveModel(1));expect(f.models).toHaveLength(before);expect(f.host.getState().mode).toBe('REPLAY');
  f.replayCallbacks[0].onModel(replayModel());f.host.goLive();const count=f.models.length;
  f.replayCallbacks[0].onModel({...replayModel(),time_seconds:99});expect(f.models).toHaveLength(count);expect(f.host.getState().mode).toBe('LIVE');f.host.destroy();
});

test.each(['throw','callback'] as const)('cleanup_failure_prevents_second_viewer_%s',async kind=>{
  const f=await modeHarness();f.liveHandles[0].destroy.mockImplementation(()=>{
    if(kind==='throw')throw new Error('VIEWER_NOT_RELEASED');f.liveCallbacks[0].onCleanupError(new Error('VIEWER_NOT_RELEASED'));
  });
  f.host.enterReplay(historySummary().session_id);expect(f.host.getState().mode).toBe('ERROR');expect(f.replayEntry).not.toHaveBeenCalled();
  expect(f.host.isReleased()).toBe(false);f.host.goLive();expect(f.liveEntry).toHaveBeenCalledTimes(1);f.host.destroy();expect(f.diagnostics.length).toBeGreaterThan(0);
});

test('switch_invalidates_before_old_destroy_reentry',async()=>{
  const f=await modeHarness();f.liveHandles[0].destroy.mockImplementation(()=>{
    const n=f.models.length;f.liveCallbacks[0].onModel(liveModel(1));expect(f.models).toHaveLength(n);f.host.goLive();
  });
  f.host.enterReplay(historySummary().session_id);expect(f.replayEntry).not.toHaveBeenCalled();expect(f.liveEntry).toHaveBeenCalledTimes(2);
  expect(f.host.getState().mode).toBe('LIVE');f.host.destroy();
});

test('constructing_handle_adopted_and_released_before_reentrant_switch',async()=>{
  const f=await modeHarness();let closed=false;
  f.replayEntry.mockImplementation((_c,cb)=>{
    cb.onModel(replayModel());f.host.goLive();expect(f.liveEntry).toHaveBeenCalledTimes(1);
    return {select(){},locateSelected(){},trackSelected(){},stopTracking(){},play(){},pause(){},setRate(){},seek(){},replay(){},destroy(){closed=true;}};
  });
  f.host.enterReplay(historySummary().session_id);expect(closed).toBe(true);expect(f.liveEntry).toHaveBeenCalledTimes(2);expect(f.host.getState().mode).toBe('LIVE');f.host.destroy();
});

test('late_async_handle_blocks_new_owner_until_adopted_and_released',async()=>{
  const f=await modeHarness();const pending=deferred<import('./history/replayScene').ReplaySceneHandle>();const release=vi.fn();
  f.replayEntry.mockReturnValueOnce(pending.promise as unknown as import('./history/replayScene').ReplaySceneHandle);
  f.host.enterReplay(historySummary().session_id);f.host.goLive();expect(f.liveEntry).toHaveBeenCalledTimes(1);
  pending.resolve({select(){},locateSelected(){},trackSelected(){},stopTracking(){},play(){},pause(){},setRate(){},seek(){},replay(){},destroy:release});await flushHistory();
  expect(release).toHaveBeenCalledTimes(1);expect(f.liveEntry).toHaveBeenCalledTimes(2);f.host.destroy();
});

test('strictmode_remount_and_unmount_callbacks_are_independent',async()=>{
  const first=await modeHarness();first.host.destroy();first.host.destroy();expect(first.host.isReleased()).toBe(true);expect(first.liveHandles[0].destroy).toHaveBeenCalledTimes(1);
  const next=await modeHarness();const count=next.models.length;first.liveCallbacks[0].onModel(liveModel(1));expect(next.models).toHaveLength(count);next.host.destroy();
});

test('history_fetch_abort_and_generation',async()=>{
  const f=await modeHarness();const old=deferred<Response>();const fresh=deferred<Response>();const signals:AbortSignal[]=[];
  let request=0;f.fetcher.mockImplementation((_u,init)=>{signals.push(init!.signal as AbortSignal);return ++request<=2?old.promise:fresh.promise;});
  f.host.refreshHistory();f.host.refreshHistory();expect(signals[0].aborted).toBe(true);
  // Separate status/list responses via same resolved body must be schema-rejected independently.
  fresh.resolve(historyResponse({sessions:[],next_cursor:null}));await flushHistory();expect(f.host.getState().history.sessions).toEqual([]);
  old.resolve(historyResponse({sessions:[historySummary()],next_cursor:null}));await flushHistory();expect(f.host.getState().history.sessions).toEqual([]);
  f.host.destroy();
});

test('recording_disabled_and_failed_visible_without_live_failure',async()=>{
  const f=await modeHarness();f.liveCallbacks[0].onModel(liveModel());f.host.refreshHistory();await flushHistory();
  expect(f.host.getState().history.status?.state).toBe('DISABLED_CONFIG');expect(f.host.getState().live.connectionState).toBe('LIVE');
  f.fetcher.mockImplementation(async input=>historyResponse(String(input).endsWith('/status')?{...recordingStatus(),enabled:true,state:'FAILED',session_id:historySummary().session_id,error_code:'START_TIMEOUT',error_message:'History failed'}:{sessions:[historySummary('FAILED')],next_cursor:null}));
  f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.status?.error_code).toBe('START_TIMEOUT');expect(f.host.getState().live.connectionState).toBe('LIVE');f.host.destroy();
});

test.each(['HTTP','JSON','SCHEMA','NETWORK'] as const)('status_error_%s_is_explicit',async kind=>{
  const f=await modeHarness();f.fetcher.mockImplementation(async input=>{
    if(!String(input).endsWith('/status'))return historyResponse({sessions:[],next_cursor:null});
    if(kind==='NETWORK')throw new Error('NETWORK');if(kind==='HTTP')return historyResponse({},503);
    if(kind==='JSON')return new Response('{broken');
    return historyResponse({...recordingStatus(),enabled:'false'});
  });
  f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.status).toBeNull();expect(f.host.getState().history.statusError).toContain(kind);expect(f.host.getState().mode).toBe('LIVE');f.host.destroy();
});
test('mode_controls_dispatch_only_to_current_source',async()=>{
  const f=await modeHarness();f.host.select('TRUCK_002');f.host.locateSelected();expect(f.liveHandles[0].select).toHaveBeenCalledWith('TRUCK_002');
  f.host.play();expect(f.replayEntry).not.toHaveBeenCalled();f.host.enterReplay(historySummary().session_id);
  f.host.play();f.host.pause();f.host.setRate(0.5);f.host.seek(33);f.host.replay();f.host.select('TRUCK_003');f.host.trackSelected();f.host.stopTracking();
  const r=f.replayHandles[0];expect(r.play).toHaveBeenCalledTimes(1);expect(r.pause).toHaveBeenCalledTimes(1);expect(r.setRate).toHaveBeenCalledWith(0.5);expect(r.seek).toHaveBeenCalledWith(33);expect(r.replay).toHaveBeenCalledTimes(1);expect(r.select).toHaveBeenCalledWith('TRUCK_003');
  f.host.destroy();f.host.play();f.host.seek(10);expect(r.play).toHaveBeenCalledTimes(1);expect(r.seek).toHaveBeenCalledTimes(1);
});

test.each([
  {enabled:true}, {state:'LIVE'}, {session_id:historySummary().session_id},
  {last_offered_sequence:-1}, {last_offered_sequence:9007199254740992}, {last_persisted_sequence:true},
  {error_code:null}, {error_message:null}, {error_code:'INVALID_CONFIG\n'}, {extra:true},
])('status_strict_fields_reject_$state_$enabled_$last_offered_sequence',async mutation=>{
  const f=await modeHarness();f.fetcher.mockImplementation(async input=>historyResponse(String(input).endsWith('/status')?{...recordingStatus(),...mutation}:{sessions:[],next_cursor:null}));
  f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.status).toBeNull();expect(f.host.getState().history.statusError).toContain('SCHEMA');f.host.destroy();
});

test('status_rejects_persisted_greater_than_offered',async()=>{
  const f=await modeHarness();f.fetcher.mockImplementation(async input=>historyResponse(String(input).endsWith('/status')?{...recordingStatus(),enabled:true,state:'RECORDING',session_id:historySummary().session_id,last_offered_sequence:1,last_persisted_sequence:2,error_code:null,error_message:null}:{sessions:[],next_cursor:null}));
  f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.statusError).toContain('SCHEMA');f.host.destroy();
});

test('history_http_failure_preserves_last_list_and_is_not_empty_success',async()=>{
  const f=await modeHarness();f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.sessions).toHaveLength(1);
  f.fetcher.mockImplementation(async input=>String(input).endsWith('/status')?historyResponse(recordingStatus()):historyResponse({error:{code:'HISTORY_UNAVAILABLE',message:'Unavailable'}},503));
  f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.error).toContain('HTTP');expect(f.host.getState().history.sessions).toHaveLength(1);expect(f.host.getState().mode).toBe('LIVE');f.host.destroy();
});

test('history_status_json_after_abort_and_mode_switch_cannot_override_current',async()=>{
  const f=await modeHarness();const json=deferred<unknown>();const signals:AbortSignal[]=[];
  f.fetcher.mockImplementation(async(input,init)=>{signals.push(init!.signal as AbortSignal);return String(input).endsWith('/status')?{ok:true,status:200,json:()=>json.promise} as Response:historyResponse({sessions:[historySummary()],next_cursor:null});});
  f.host.refreshHistory();await flushHistory();f.host.enterReplay(historySummary().session_id);expect(signals[0].aborted).toBe(true);
  f.fetcher.mockImplementation(async input=>historyResponse(String(input).endsWith('/status')?recordingStatus():{sessions:[],next_cursor:null}));f.host.refreshHistory();await flushHistory();
  const before=f.host.getState();json.resolve({...recordingStatus(),error_message:'STALE_DIAGNOSTIC'});await flushHistory();expect(f.host.getState()).toBe(before);f.host.destroy();
});

test('recording_session_cannot_start_replay_and_invalid_uuid_is_atomic',async()=>{
  const f=await modeHarness();f.fetcher.mockImplementation(async input=>historyResponse(String(input).endsWith('/status')?recordingStatus():{sessions:[historySummary('RECORDING')],next_cursor:null}));
  f.host.refreshHistory();await flushHistory();const previous=f.host.getState();f.host.enterReplay(historySummary().session_id);
  expect(f.host.getState()).toBe(previous);expect(f.replayEntry).not.toHaveBeenCalled();expect(()=>f.host.enterReplay('not-uuid')).toThrow();expect(f.host.getState()).toBe(previous);f.host.destroy();
});

test('late_async_handle_after_unmount_is_destroyed_without_new_model',async()=>{
  const f=await modeHarness();const pending=deferred<import('./history/replayScene').ReplaySceneHandle>();
  f.replayEntry.mockReturnValueOnce(pending.promise as unknown as import('./history/replayScene').ReplaySceneHandle);
  f.host.enterReplay(historySummary().session_id);f.host.destroy();expect(f.host.isReleased()).toBe(false);const count=f.models.length;const destroy=vi.fn();
  pending.resolve({select(){},locateSelected(){},trackSelected(){},stopTracking(){},play(){},pause(){},setRate(){},seek(){},replay(){},destroy});await flushHistory();
  expect(destroy).toHaveBeenCalledTimes(1);expect(f.host.isReleased()).toBe(true);expect(f.models).toHaveLength(count);expect(f.liveEntry).toHaveBeenCalledTimes(1);
});

test('construction_callback_failure_blocks_revival_and_releases_late_handle',async()=>{
  const f=await modeHarness();const destroy=vi.fn();
  f.replayEntry.mockImplementation((_c,cb)=>{cb.onCleanupError(new Error('CONSTRUCTION_RELEASE_UNCONFIRMED'));cb.onModel(replayModel());
    return {select(){},locateSelected(){},trackSelected(){},stopTracking(){},play(){},pause(){},setRate(){},seek(){},replay(){},destroy};});
  f.host.enterReplay(historySummary().session_id);expect(f.host.getState().mode).toBe('ERROR');expect(destroy).toHaveBeenCalledTimes(1);f.host.goLive();expect(f.liveEntry).toHaveBeenCalledTimes(1);f.host.destroy();
});

test.each([false,true])('react_strictmode_lease_barrier_cleanup_failure_%s',async failed=>{
  const React=await import('react');const fleet=await import('./fleetScene');const refs=[{current:container},{current:null as import('./App').AppModeHost|null}];
  const effects=vi.spyOn(React,'useEffect').mockImplementation(()=>{});
  vi.spyOn(React,'useRef').mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]);
  vi.spyOn(console,'error').mockImplementation(()=>{});const callbacks:Parameters<typeof fleet.startFleetScene>[1][]=[];
  const destroy=vi.fn(()=>{if(failed)callbacks[0].onCleanupError(new Error('STILL_UNRELEASED'));});
  const entry=vi.spyOn(fleet,'startFleetScene').mockImplementation((_c,cb)=>{callbacks.push(cb);return {select(){},locateSelected(){},trackSelected(){},stopTracking(){},destroy};});
  vi.stubGlobal('fetch',vi.fn(async input=>historyResponse(String(input).endsWith('/status')?recordingStatus():{sessions:[],next_cursor:null})));
  renderToStaticMarkup(createElement(App));const setup=effects.mock.calls[0][0];const cleanup=setup();if(typeof cleanup==='function')cleanup();
  const second=setup();expect(entry).toHaveBeenCalledTimes(failed?1:2);if(typeof second==='function')second();await flushHistory();
});
test('app_replay_markup_has_no_realtime_connection_or_online_statistics',async()=>{
  const f=await modeHarness();f.host.enterReplay(historySummary().session_id);f.replayCallbacks[0].onModel(replayModel());
  const React=await import('react');vi.spyOn(React,'useState').mockReturnValueOnce([f.host.getState(),vi.fn()]).mockReturnValueOnce([true,vi.fn()]);
  const markup=renderToStaticMarkup(createElement(App));expect(markup).toContain('Historical playback');expect(markup).not.toContain('Connection:');expect(markup).not.toContain('Online:');expect(markup).not.toContain('Fleet monitoring');f.host.destroy();
});
test('history_keyset_pages_are_explicit_and_not_duplicated',async()=>{
  const f=await modeHarness();const first=historySummary();
  const many=Array.from({length:60},(_,i)=>({...first,session_id:`11111111-1111-4111-8111-${String(60-i).padStart(12,'0')}`}));
  const cursor=Buffer.from(JSON.stringify({started_utc:first.started_utc,session_id:many.at(-1)!.session_id})).toString('base64url');
  const second={...historySummary('INTERRUPTED'),session_id:'22222222-2222-4222-8222-222222222222',started_utc:'2026-10-13T00:00:00Z'};
  f.fetcher.mockImplementation(async input=>{if(String(input).endsWith('/status'))return historyResponse(recordingStatus());
    const u=new URL(String(input),'http://local');return historyResponse(u.searchParams.has('cursor')?{sessions:[second],next_cursor:null}:{sessions:many,next_cursor:cursor});});
  f.host.refreshHistory();await flushHistory();expect(f.host.getState().history.nextCursor).toBe(cursor);
  f.host.loadMore();f.host.loadMore();await flushHistory();expect(f.host.getState().history.sessions.map(s=>s.session_id)).toEqual([...many.map(s=>s.session_id),second.session_id]);
  expect(f.fetcher.mock.calls.filter(c=>String(c[0]).includes('/sessions?'))).toHaveLength(2);expect(f.host.getState().history.nextCursor).toBeNull();f.host.destroy();
});

test('history_abort_failure_still_releases_source_and_blocks_replacement',async()=>{
  const f=await modeHarness();const NativeAbort=globalThis.AbortController;
  vi.stubGlobal('AbortController',class extends NativeAbort{abort(){throw new Error('ABORT_UNCONFIRMED');}});
  const pending=deferred<Response>();f.fetcher.mockReturnValue(pending.promise);f.host.refreshHistory();f.host.refreshHistory();
  expect(f.host.getState().mode).toBe('ERROR');expect(f.liveHandles[0].destroy).toHaveBeenCalledTimes(1);
  f.host.enterReplay(historySummary().session_id);expect(f.replayEntry).not.toHaveBeenCalled();f.host.destroy();pending.resolve(historyResponse({}));await flushHistory();
});