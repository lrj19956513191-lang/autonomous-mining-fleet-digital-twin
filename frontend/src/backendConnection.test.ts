import { expect, test } from 'vitest';
import { resolveBackendConnection } from './backendConnection';

test('resolves_default_backend_connection', () => {
  expect(resolveBackendConnection({})).toEqual({
    backendOrigin: 'http://127.0.0.1:8000', sceneUrl: '/api/scene',
    vehicleWsUrl: 'ws://127.0.0.1:8000/ws/vehicles',
    fleetWsUrl: 'ws://127.0.0.1:8000/ws/fleet',
  });
});

test.each([
  [' https://Example.test:443/ ', undefined, 'https://example.test', 'wss://example.test/ws/vehicles'],
  [' http://LOCALHOST:80 ', ' ws://localhost:80/ws/vehicles ', 'http://localhost', 'ws://localhost/ws/vehicles'],
  ['http://127.0.0.1:9000', 'ws://127.0.0.1:9000/ws/vehicles', 'http://127.0.0.1:9000', 'ws://127.0.0.1:9000/ws/vehicles'],
])('resolves_custom_origin_and_matching_override %s', (origin, override, backendOrigin, vehicleWsUrl) => {
  expect(resolveBackendConnection({ VITE_BACKEND_ORIGIN: origin, VITE_VEHICLE_WS_URL: override }))
    .toEqual({ backendOrigin, vehicleWsUrl, sceneUrl: '/api/scene', fleetWsUrl: vehicleWsUrl.replace('/ws/vehicles', '/ws/fleet') });
});

test.each([
  'file:///tmp', 'ws://example.test', 'ftp://example.test', 'http://user:pass@example.test',
  'http://example.test/path', 'http://example.test/?x=1', 'http://example.test/#x',
  '/relative', 'example.test', 'http://example.test:65536',
])('rejects_invalid_origin_or_websocket origin %s', (origin) => {
  expect(() => resolveBackendConnection({ VITE_BACKEND_ORIGIN: origin })).toThrow(Error);
});
test.each([
  'http://127.0.0.1:8000/ws/vehicles', 'ws://user:pass@127.0.0.1:8000/ws/vehicles',
  'ws://127.0.0.1:8000/wrong', 'ws://127.0.0.1:8000/ws/vehicles?x=1',
  'ws://127.0.0.1:8000/ws/vehicles#x', 'ws://localhost:8000/ws/vehicles',
  'ws://127.0.0.1:9000/ws/vehicles', 'wss://127.0.0.1:8000/ws/vehicles',
  '/ws/vehicles', 'ws://127.0.0.1:65536/ws/vehicles',
])('rejects_invalid_origin_or_websocket override %s', (override) => {
  expect(() => resolveBackendConnection({ VITE_VEHICLE_WS_URL: override })).toThrow(Error);
});

test.each([undefined, '', '  \t\n'])('treats_blank_variables_as_defaults %j', (blank) => {
  expect(resolveBackendConnection({ VITE_BACKEND_ORIGIN: blank, VITE_VEHICLE_WS_URL: blank }))
    .toEqual({ backendOrigin: 'http://127.0.0.1:8000', sceneUrl: '/api/scene', vehicleWsUrl: 'ws://127.0.0.1:8000/ws/vehicles', fleetWsUrl: 'ws://127.0.0.1:8000/ws/fleet' });
  expect(resolveBackendConnection({ VITE_BACKEND_ORIGIN: 'https://example.test', VITE_VEHICLE_WS_URL: blank }).vehicleWsUrl)
    .toBe('wss://example.test/ws/vehicles');
});

test.each(['http://127.0.0.1:8000/?','http://127.0.0.1:8000/#'])('rejects_empty_query_or_fragment origin %s',origin=>{
  expect(()=>resolveBackendConnection({VITE_BACKEND_ORIGIN:origin})).toThrow(Error);
});
test.each(['ws://127.0.0.1:8000/ws/vehicles?','ws://127.0.0.1:8000/ws/vehicles#'])('rejects_empty_query_or_fragment websocket %s',override=>{
  expect(()=>resolveBackendConnection({VITE_VEHICLE_WS_URL:override})).toThrow(Error);
});

test.each([
  ['https://example.test:443', 'wss://example.test:443/ws/vehicles', 'https://example.test', 'wss://example.test/ws/vehicles'],
  ['http://[::1]:9000', 'ws://[::1]:9000/ws/vehicles', 'http://[::1]:9000', 'ws://[::1]:9000/ws/vehicles'],
])('resolves_normalized_secure_and_ipv6_origin %s',(origin,override,backendOrigin,vehicleWsUrl)=>{
  expect(resolveBackendConnection({VITE_BACKEND_ORIGIN:origin,VITE_VEHICLE_WS_URL:override}))
    .toEqual({backendOrigin,sceneUrl:'/api/scene',vehicleWsUrl,fleetWsUrl:vehicleWsUrl.replace('/ws/vehicles','/ws/fleet')});
});

test.each([
  [{}, 'ws://127.0.0.1:8000/ws/fleet'],
  [{ VITE_BACKEND_ORIGIN: 'https://Example.test:443/' }, 'wss://example.test/ws/fleet'],
  [{ VITE_BACKEND_ORIGIN: 'http://localhost:9000', VITE_VEHICLE_WS_URL: 'ws://localhost:9000/ws/vehicles' }, 'ws://localhost:9000/ws/fleet'],
  [{ VITE_BACKEND_ORIGIN: 'https://example.test', VITE_VEHICLE_WS_URL: 'wss://example.test/ws/vehicles' }, 'wss://example.test/ws/fleet'],
  [{ VITE_BACKEND_ORIGIN: 'http://[::1]:9000' }, 'ws://[::1]:9000/ws/fleet'],
])('fleet_url_derives_from_backend_origin %j', (env, fleetWsUrl) => {
  const result = resolveBackendConnection(env);
  expect(result.fleetWsUrl).toBe(fleetWsUrl);
  expect(result.sceneUrl).toBe('/api/scene');
});

test('fleet URL cannot be supplied through the legacy vehicle override', () => {
  expect(() => resolveBackendConnection({
    VITE_BACKEND_ORIGIN: 'https://example.test', VITE_VEHICLE_WS_URL: 'wss://example.test/ws/fleet',
  })).toThrow(Error);
});
