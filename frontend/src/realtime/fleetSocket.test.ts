import { expect, test, vi } from 'vitest';
import { connectFleetSocket } from './fleetSocket';
import { makeFleetSnapshotFixture } from './fleetFixtures';
import type { SocketTransport } from './vehicleSocket';

class FakeSocket implements SocketTransport {
  readyState: SocketTransport['readyState'] = 0;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly close = vi.fn(() => { this.readyState = 2; });

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    const event = type === 'message' ? new MessageEvent(type, { data }) : new Event(type);
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

const url = 'ws://127.0.0.1:8123/ws/fleet?test=one';
function setup() {
  const socket = new FakeSocket();
  const createSocket = vi.fn(() => socket);
  const onSnapshot = vi.fn();
  const onConnectionState = vi.fn();
  const handle = connectFleetSocket({ url, createSocket, onSnapshot, onConnectionState });
  return { socket, createSocket, onSnapshot, onConnectionState, handle };
}

// Missing initial state, parser or actual event registration must break this test.
test('immediately_reports_connecting_then_live_and_accepts_first_snapshot', () => {
  const { socket, createSocket, onSnapshot, onConnectionState } = setup();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
  expect(createSocket).toHaveBeenCalledExactlyOnceWith(url);
  expect(socket.listenerCount).toBe(4);
  socket.emit('open');
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  socket.emit('message', '{bad-json');
  socket.emit('message', JSON.stringify({ ...makeFleetSnapshotFixture(), schema_version: 2 }));
  expect(onSnapshot).not.toHaveBeenCalled();
  const first = makeFleetSnapshotFixture();
  first.session_id = '22222222-2222-4222-a222-222222222222';
  socket.emit('message', JSON.stringify(first));
  expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(first);
  expect(Object.isFrozen(onSnapshot.mock.calls[0][0])).toBe(true);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  expect(createSocket).toHaveBeenCalledTimes(1);
});

function packet(sequence: number, time: number, session = '11111111-1111-4111-8111-111111111111') {
  return { ...makeFleetSnapshotFixture(), sequence, simulation_time_seconds: time, session_id: session };
}

const duplicateIds = packet(100, 100);
duplicateIds.vehicles[2].vehicle_id = duplicateIds.vehicles[0].vehicle_id;

// Bypassing the gate or updating its baseline on rejection must break these cases.
test.each([
  { label: 'invalid JSON', data: '{not-json' },
  { label: 'non-text object', data: { toString: () => JSON.stringify(packet(100, 100)) } },
  { label: 'non-text number', data: 42 },
  { label: 'extra schema field', data: JSON.stringify({ ...packet(100, 100), extra: true }) },
  { label: 'invalid vehicle', data: JSON.stringify({ ...packet(100, 100), vehicles: [{ bad: true }] }) },
  { label: 'duplicate ID', data: JSON.stringify(duplicateIds) },
  { label: 'duplicate sequence', data: JSON.stringify(packet(5, 6)) },
  { label: 'backward sequence', data: JSON.stringify(packet(4, 6)) },
  { label: 'unchanged time', data: JSON.stringify(packet(100, 5)) },
  { label: 'backward time', data: JSON.stringify(packet(100, 4)) },
  { label: 'invalid zero clock', data: JSON.stringify(packet(0, 100)) },
  { label: 'invalid positive clock', data: JSON.stringify(packet(100, 0)) },
  { label: 'invalid UUID', data: JSON.stringify(packet(100, 100, 'invalid')) },
  { label: 'different session', data: JSON.stringify(packet(100, 100, '22222222-2222-4222-a222-222222222222')) },
])('drops_invalid_stale_session_without_callbacks: $label', ({ data }) => {
  const { socket, onSnapshot, onConnectionState, createSocket } = setup();
  socket.emit('open');
  socket.emit('message', JSON.stringify(packet(5, 5)));
  expect(onSnapshot).toHaveBeenCalledTimes(1);
  onSnapshot.mockClear();
  socket.emit('message', data);
  expect(onSnapshot).not.toHaveBeenCalled();
  socket.emit('message', JSON.stringify(packet(6, 6)));
  expect(onSnapshot).toHaveBeenCalledTimes(1);
  expect(onSnapshot.mock.calls[0][0].sequence).toBe(6);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  expect(createSocket).toHaveBeenCalledTimes(1);
});

test('drops keeps gates independent across two live handles and a restarted session', () => {
  const first = setup();
  const second = setup();
  const restarted = packet(0, 0, '22222222-2222-4222-a222-222222222222');
  first.socket.emit('message', JSON.stringify(packet(100, 100)));
  second.socket.emit('message', JSON.stringify(restarted));
  first.socket.emit('message', JSON.stringify(restarted));
  expect(first.onSnapshot).toHaveBeenCalledTimes(1);
  expect(second.onSnapshot).toHaveBeenCalledExactlyOnceWith(restarted);
  first.handle.close();
  second.socket.emit('message', JSON.stringify({ ...restarted, sequence: 1, simulation_time_seconds: 1 }));
  expect(second.onSnapshot).toHaveBeenCalledTimes(2);
  expect(second.onSnapshot.mock.calls[1][0].sequence).toBe(1);
});

test('drops does not classify snapshot consumer failure and retains protocol acceptance', () => {
  const { socket, onSnapshot, onConnectionState } = setup();
  const expected = new Error('local snapshot consumer failed');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onSnapshot.mockImplementationOnce(() => { throw expected; });
  try {
    expect(() => socket.emit('message', JSON.stringify(packet(5, 5)))).toThrow(expected);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    socket.emit('message', JSON.stringify(packet(5, 5)));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    socket.emit('message', JSON.stringify(packet(6, 6)));
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls[1][0].sequence).toBe(6);
    expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test.each(['CONNECTING', 'LIVE', 'ERROR', 'CLOSED'] as const)(
  'drops keeps %s state consumer exceptions outside transport and JSON classification', (state) => {
    const socket = new FakeSocket();
    const expected = new Error('local state consumer failed');
    const createSocket = vi.fn(() => socket);
    const onConnectionState = vi.fn((next: string) => { if (next === state) throw expected; });
    const options = { url, createSocket, onConnectionState, onSnapshot: vi.fn() };
    if (state === 'CONNECTING') {
      expect(() => connectFleetSocket(options)).toThrow(expected);
      expect(createSocket).not.toHaveBeenCalled();
    } else {
      const handle = connectFleetSocket(options);
      const event = state === 'LIVE' ? 'open' : state === 'ERROR' ? 'error' : 'close';
      expect(() => socket.emit(event)).toThrow(expected);
      expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], [state]]);
      handle.close();
    }
  },
);

function cachedEvents(socket: FakeSocket) {
  return [...socket.listeners].flatMap(([type, listeners]) =>
    [...listeners].map((listener) => () => {
      const event = type === 'message'
        ? new MessageEvent(type, { data: JSON.stringify(packet(200, 200)) }) : new Event(type);
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }));
}

// Missing disposal, incorrect terminal-state transitions or lost cleanup errors must fail.
test.each([0, 1, 2, 3] as const)(
  'closes_connecting_and_live_idempotently_and_isolates_late_events at readyState %s', (readyState) => {
    const { socket, handle, onSnapshot, onConnectionState, createSocket } = setup();
    const external = vi.fn();
    socket.addEventListener('message', external);
    const late = cachedEvents(socket);
    socket.readyState = readyState;
    if (readyState === 1) socket.emit('open');
    const states = onConnectionState.mock.calls.slice();
    socket.close.mockImplementation(() => { socket.emit('close'); });
    handle.close(); handle.close();
    expect(socket.close).toHaveBeenCalledTimes(readyState < 2 ? 1 : 0);
    expect(socket.listenerCount).toBe(1);
    expect(socket.listeners.get('message')?.has(external)).toBe(true);
    late.forEach((fire) => fire());
    socket.emit('message', JSON.stringify(packet(201, 201)));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onConnectionState.mock.calls).toEqual(states);
    expect(createSocket).toHaveBeenCalledTimes(1);
  },
);

test('closes reports constructor ERROR once and returns an idempotent handle', () => {
  const onConnectionState = vi.fn();
  const onSnapshot = vi.fn();
  const createSocket = vi.fn(() => { throw new Error('constructor failed'); });
  const handle = connectFleetSocket({ url, createSocket, onConnectionState, onSnapshot });
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['ERROR']]);
  expect(() => { handle.close(); handle.close(); }).not.toThrow();
  expect(createSocket).toHaveBeenCalledTimes(1);
  expect(onSnapshot).not.toHaveBeenCalled();
});

test('closes preserves constructor ERROR consumer exception identity', () => {
  const expected = new Error('local ERROR consumer');
  const onConnectionState = vi.fn((state: string) => { if (state === 'ERROR') throw expected; });
  expect(() => connectFleetSocket({
    url, onConnectionState, onSnapshot: vi.fn(),
    createSocket: () => { throw new Error('constructor failed'); },
  })).toThrow(expected);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['ERROR']]);
});

test('closes normal server close releases listeners before callback and invalidates cached events', () => {
  const { socket, handle, onSnapshot, onConnectionState, createSocket } = setup();
  const late = cachedEvents(socket);
  socket.emit('open');
  onConnectionState.mockImplementation((state) => {
    if (state === 'CLOSED') {
      expect(socket.listenerCount).toBe(0);
      handle.close();
    }
  });
  socket.emit('close');
  late.forEach((fire) => fire());
  handle.close();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE'], ['CLOSED']]);
  expect(onSnapshot).not.toHaveBeenCalled();
  expect(socket.close).not.toHaveBeenCalled();
  expect(createSocket).toHaveBeenCalledTimes(1);
});

test('closes preserves ERROR after error then close and ignores intervening messages or open', () => {
  const { socket, handle, onSnapshot, onConnectionState, createSocket } = setup();
  socket.emit('open');
  socket.emit('error');
  socket.emit('message', JSON.stringify(packet(1, 1)));
  socket.emit('open');
  socket.emit('error');
  socket.emit('close');
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE'], ['ERROR']]);
  expect(socket.listenerCount).toBe(0);
  expect(socket.close).not.toHaveBeenCalled();
  handle.close();
  expect(onSnapshot).not.toHaveBeenCalled();
  expect(createSocket).toHaveBeenCalledTimes(1);
});

test.each(['LIVE', 'ERROR', 'snapshot'] as const)(
  'closes from synchronous %s consumer and leaves no owned listeners', (source) => {
    const { socket, handle, onSnapshot, onConnectionState, createSocket } = setup();
    const late = cachedEvents(socket);
    onConnectionState.mockImplementation((state) => { if (state === source) handle.close(); });
    onSnapshot.mockImplementation(() => { if (source === 'snapshot') handle.close(); });
    if (source === 'LIVE') socket.emit('open');
    else if (source === 'ERROR') socket.emit('error');
    else socket.emit('message', JSON.stringify(packet(1, 1)));
    expect(socket.listenerCount).toBe(0);
    expect(socket.close).toHaveBeenCalledTimes(1);
    const states = onConnectionState.mock.calls.slice();
    const snapshots = onSnapshot.mock.calls.length;
    late.forEach((fire) => fire());
    expect(onConnectionState.mock.calls).toEqual(states);
    expect(onSnapshot).toHaveBeenCalledTimes(snapshots);
    expect(createSocket).toHaveBeenCalledTimes(1);
  },
);

test('closes does not leak listeners when a LIVE consumer closes then throws', () => {
  const { socket, handle, onConnectionState } = setup();
  const expected = new Error('local consumer after cleanup');
  onConnectionState.mockImplementation(() => { handle.close(); throw expected; });
  expect(() => socket.emit('open')).toThrow(expected);
  expect(socket.listenerCount).toBe(0);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
});

test('closes failure remains diagnostic on repeated cleanup and never revives callbacks', () => {
  const { socket, handle, onSnapshot, onConnectionState } = setup();
  const late = cachedEvents(socket);
  const expected = new Error('transport close failed');
  socket.close.mockImplementation(() => {
    socket.emit('message', JSON.stringify(packet(1, 1)));
    throw expected;
  });
  expect(() => handle.close()).toThrow(expected);
  expect(socket.listenerCount).toBe(0);
  expect(socket.readyState).toBe(0);
  late.forEach((fire) => fire());
  expect(() => handle.close()).toThrow(expected);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(onSnapshot).not.toHaveBeenCalled();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
});

test('closes old handle does not disable or contaminate a replacement connection', () => {
  const old = setup();
  const late = cachedEvents(old.socket);
  old.socket.emit('message', JSON.stringify(packet(100, 100)));
  old.handle.close();
  const current = setup();
  late.forEach((fire) => fire());
  current.socket.emit('open');
  current.socket.emit('message', JSON.stringify(packet(0, 0, '22222222-2222-4222-a222-222222222222')));
  expect(old.onSnapshot).toHaveBeenCalledTimes(1);
  expect(old.onConnectionState.mock.calls).toEqual([['CONNECTING']]);
  expect(current.onConnectionState.mock.calls).toEqual([['CONNECTING'], ['LIVE']]);
  expect(current.onSnapshot).toHaveBeenCalledTimes(1);
});

test('closes attempts remaining listeners and transport after listener removal failure', () => {
  const { socket, handle, onSnapshot, onConnectionState } = setup();
  const expected = new Error('listener removal failed');
  const remove = socket.removeEventListener.bind(socket);
  const removal = vi.spyOn(socket, 'removeEventListener').mockImplementation((type, listener) => {
    if (type === 'open') throw expected;
    remove(type, listener);
  });
  expect(() => handle.close()).toThrow(expected);
  expect(removal).toHaveBeenCalledTimes(4);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(socket.listenerCount).toBe(1);
  socket.emit('open');
  socket.emit('message', JSON.stringify(packet(1, 1)));
  expect(onSnapshot).not.toHaveBeenCalled();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
  expect(() => handle.close()).toThrow(expected);
});

test('closes during synchronous listener registration without adding later listeners', () => {
  const socket = new FakeSocket();
  const add = socket.addEventListener.bind(socket);
  vi.spyOn(socket, 'addEventListener').mockImplementation((type, listener) => {
    add(type, listener);
    if (type === 'close') socket.emit('close');
  });
  const onConnectionState = vi.fn();
  const onSnapshot = vi.fn();
  const handle = connectFleetSocket({ url, createSocket: () => socket, onConnectionState, onSnapshot });
  expect(socket.listenerCount).toBe(0);
  socket.emit('message', JSON.stringify(packet(1, 1)));
  handle.close();
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING'], ['CLOSED']]);
  expect(onSnapshot).not.toHaveBeenCalled();
  expect(socket.close).not.toHaveBeenCalled();
});

test('closes partially registered transport when registration inserts then throws', () => {
  const socket = new FakeSocket();
  const expected = new Error('listener registration failed');
  const add = socket.addEventListener.bind(socket);
  vi.spyOn(socket, 'addEventListener').mockImplementation((type, listener) => {
    add(type, listener);
    if (type === 'close') throw expected;
  });
  const onConnectionState = vi.fn();
  expect(() => connectFleetSocket({ url, createSocket: () => socket,
    onConnectionState, onSnapshot: vi.fn() })).toThrow(expected);
  expect(socket.listenerCount).toBe(0);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(onConnectionState.mock.calls).toEqual([['CONNECTING']]);
});
