import { afterEach, expect, test, vi } from 'vitest';
import { connectVehicleSocket, type SocketTransport } from './vehicleSocket';

afterEach(() => vi.restoreAllMocks());

class FakeSocket {
  readyState: SocketTransport['readyState'] = 0;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  close = vi.fn(() => { this.readyState = 2; });

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    const event = type === 'message' ? new MessageEvent(type, { data }) : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

const url = 'ws://127.0.0.1:8000/ws/vehicles';

const valid = {
  vehicle_id: 'TRUCK_001',
  timestamp: '2026-10-01T13:18:02.936773+00:00',
  longitude: 116.4254,
  latitude: 39.9177,
  height: 50,
  heading: 45,
  speed: 25,
  soc: 54.6,
  load: 65,
  status: 'running',
};

function setup(requestedUrl = url) {
  const socket = new FakeSocket();
  const createSocket = vi.fn(() => socket);
  const onTelemetry = vi.fn();
  const onConnectionState = vi.fn();
  const handle = connectVehicleSocket({
    url: requestedUrl, createSocket, onTelemetry, onConnectionState,
  });
  return { socket, createSocket, onTelemetry, onConnectionState, handle };
}

test('creates one socket with the requested URL and immediately reports CONNECTING', () => {
  const requestedUrl = 'ws://127.0.0.1:8123/custom-stream?source=test';
  const { createSocket, onConnectionState, handle } = setup(requestedUrl);
  expect(createSocket).toHaveBeenCalledExactlyOnceWith(requestedUrl);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
  expect(handle.close).toBeTypeOf('function');
});

test('reports LIVE after the transport opens', () => {
  const { socket, onConnectionState } = setup();
  socket.emit('open');
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
});

test('delivers parsed valid telemetry exactly once without changing connection state', () => {
  const { socket, onTelemetry, onConnectionState } = setup();
  socket.emit('open');
  socket.emit('message', JSON.stringify(valid));
  expect(onTelemetry).toHaveBeenCalledExactlyOnceWith(valid);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
});

test('drops malformed JSON, warns, and accepts the next valid message', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { socket, onTelemetry, onConnectionState } = setup();
  socket.emit('open');
  expect(() => socket.emit('message', '{not-json')).not.toThrow();
  expect(onTelemetry).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  socket.emit('message', JSON.stringify(valid));
  expect(onTelemetry).toHaveBeenCalledExactlyOnceWith(valid);
});

test.each([
  { label: 'missing longitude', payload: { ...valid, longitude: undefined } },
  { label: 'other vehicle', payload: { ...valid, vehicle_id: 'TRUCK_002' } },
])('drops schema-invalid JSON ($label), warns, and accepts the next valid message', ({ payload }) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { socket, onTelemetry, onConnectionState } = setup();
  socket.emit('open');
  expect(() => socket.emit('message', JSON.stringify(payload))).not.toThrow();
  expect(onTelemetry).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  socket.emit('message', JSON.stringify(valid));
  expect(onTelemetry).toHaveBeenCalledExactlyOnceWith(valid);
});

test.each([
  { label: 'number', data: 42 },
  { label: 'object with JSON-like toString', data: { toString: () => JSON.stringify(valid) } },
])('ignores non-text message data ($label) without coercing it', ({ data }) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { socket, onTelemetry, onConnectionState } = setup();
  socket.emit('open');
  expect(() => socket.emit('message', data)).not.toThrow();
  expect(onTelemetry).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  socket.emit('message', JSON.stringify(valid));
  expect(onTelemetry).toHaveBeenCalledExactlyOnceWith(valid);
});

test('reports ERROR on transport error without reconnecting or inventing a close event', () => {
  const { socket, onConnectionState, createSocket } = setup();
  socket.emit('open');
  socket.emit('error');
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE'], ['ERROR']]);
  expect(createSocket).toHaveBeenCalledTimes(1);
  expect(socket.close).not.toHaveBeenCalled();
});

test('reports CLOSED after a normal transport close', () => {
  const { socket, onConnectionState } = setup();
  socket.emit('open');
  socket.emit('close');
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE'], ['CLOSED']]);
});

test('keeps ERROR after the subsequent transport close', () => {
  const { socket, onConnectionState, createSocket } = setup();
  socket.emit('open');
  socket.emit('error');
  socket.emit('close');
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE'], ['ERROR']]);
  expect(createSocket).toHaveBeenCalledTimes(1);
});

test('reports constructor failure as ERROR and returns a safe close handle', () => {
  const onConnectionState = vi.fn();
  const onTelemetry = vi.fn();
  const createSocket = vi.fn(() => { throw new Error('invalid socket URL'); });
  let handle: ReturnType<typeof connectVehicleSocket>;
  expect(() => {
    handle = connectVehicleSocket({ url, createSocket, onTelemetry, onConnectionState });
  }).not.toThrow();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['ERROR']]);
  expect(() => { handle.close(); handle.close(); }).not.toThrow();
  expect(onTelemetry).not.toHaveBeenCalled();
  expect(createSocket).toHaveBeenCalledTimes(1);
});

test.each([
  { readyState: 0, closeCalls: 1 },
  { readyState: 1, closeCalls: 1 },
  { readyState: 2, closeCalls: 0 },
  { readyState: 3, closeCalls: 0 },
] as const)('cleanup is idempotent at readyState $readyState', ({ readyState, closeCalls }) => {
  const { socket, handle, onConnectionState } = setup();
  socket.readyState = readyState;
  expect(() => { handle.close(); handle.close(); }).not.toThrow();
  expect(socket.close).toHaveBeenCalledTimes(closeCalls);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
});

test('cleanup removes transport listeners and suppresses synchronous close notifications', () => {
  const { socket, handle, onConnectionState, onTelemetry } = setup();
  socket.emit('open');
  socket.close.mockImplementation(() => socket.emit('close'));
  handle.close();
  expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  socket.emit('message', JSON.stringify(valid));
  expect(onTelemetry).not.toHaveBeenCalled();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
});

test('ignores cached late event callbacks after cleanup', () => {
  const { socket, handle, onConnectionState, onTelemetry } = setup();
  socket.emit('open');
  const cached = [...socket.listeners.entries()].map(([type, listeners]) => (
    [type, [...listeners]] as const
  ));
  handle.close();
  for (const [type, listeners] of cached) {
    for (const listener of listeners) {
      const event = type === 'message'
        ? new MessageEvent(type, { data: JSON.stringify(valid) }) : new Event(type);
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
  expect(onTelemetry).not.toHaveBeenCalled();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
});

test('does not swallow telemetry callback errors or classify them as bad JSON', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { socket, onTelemetry, onConnectionState } = setup();
  const expected = new Error('telemetry consumer failed');
  onTelemetry.mockImplementation(() => { throw expected; });
  socket.emit('open');
  let caught: unknown;
  try { socket.emit('message', JSON.stringify(valid)); }
  catch (error) { caught = error; }
  expect(caught).toBe(expected);
  expect(onTelemetry).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
});

test('disposing an old connection does not disable a new connection', () => {
  const oldConnection = setup();
  oldConnection.handle.close();
  const current = setup();
  oldConnection.socket.emit('close');
  current.socket.emit('open');
  current.socket.emit('message', JSON.stringify(valid));
  expect(oldConnection.onConnectionState.mock.calls).toEqual([['CONNECTING']]);
  expect(oldConnection.onTelemetry).not.toHaveBeenCalled();
  expect(current.onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  expect(current.onTelemetry).toHaveBeenCalledExactlyOnceWith(valid);
});
