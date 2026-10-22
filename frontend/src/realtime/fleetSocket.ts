import { createFleetSnapshotGate, parseFleetSnapshot, type FleetSnapshot } from './fleetTelemetry';
import type { ConnectionState, SocketTransport } from './vehicleSocket';

export type FleetSocketOptions = {
  url: string;
  onSnapshot(snapshot: FleetSnapshot): void;
  onConnectionState(state: ConnectionState): void;
  createSocket?: (url: string) => SocketTransport;
};
export type FleetSocketHandle = { close(): void };

export function connectFleetSocket(options: FleetSocketOptions): FleetSocketHandle {
  const gate = createFleetSnapshotGate();
  let disposed = false;
  let hasError = false;
  let cleanupStarted = false;
  let cleanupFailure: { error: unknown } | undefined;

  options.onConnectionState('CONNECTING');
  let socket: SocketTransport;
  try {
    socket = (options.createSocket ?? ((url) => new WebSocket(url)))(options.url);
  } catch {
    options.onConnectionState('ERROR');
    return { close() {} };
  }

  function onOpen() {
    if (!disposed && !hasError) options.onConnectionState('LIVE');
  }

  function onError() {
    if (disposed || hasError) return;
    hasError = true;
    options.onConnectionState('ERROR');
  }

  function onClose() {
    if (disposed) return;
    dispose(false);
    if (!hasError) options.onConnectionState('CLOSED');
  }

  function onMessage(event: Event) {
    if (disposed || hasError) return;
    const data: unknown = (event as MessageEvent).data;
    if (typeof data !== 'string') return;
    let input: unknown;
    try { input = JSON.parse(data); }
    catch { return; }
    const snapshot = parseFleetSnapshot(input);
    // Acceptance precedes delivery: a local consumer failure must not replay this sequence.
    if (snapshot && gate.accept(snapshot)) options.onSnapshot(snapshot);
  }

  const listeners: readonly (readonly [string, EventListener])[] = [
    ['open', onOpen], ['error', onError], ['close', onClose], ['message', onMessage],
  ];

  function dispose(closeTransport: boolean) {
    if (cleanupStarted) {
      if (cleanupFailure) throw cleanupFailure.error;
      return;
    }
    cleanupStarted = true;
    // Invalidate callbacks before any resource operation can synchronously reenter.
    disposed = true;
    const errors: unknown[] = [];
    for (const [type, listener] of listeners) {
      try { socket.removeEventListener(type, listener); }
      catch (error) { errors.push(error); }
    }
    if (closeTransport) {
      try {
        if (socket.readyState === 0 || socket.readyState === 1) socket.close();
      } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      // Disposed means callbacks are invalid, not that resource release succeeded.
      cleanupFailure = { error: errors.length === 1 ? errors[0]
        : new AggregateError(errors, 'Fleet socket cleanup failed') };
      throw cleanupFailure.error;
    }
  }

  try {
    for (const [type, listener] of listeners) {
      if (disposed) break;
      socket.addEventListener(type, listener);
    }
  } catch (error) {
    if (!cleanupStarted) {
      try { dispose(true); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Fleet socket setup and cleanup failed');
      }
    }
    throw error;
  }
  return { close() { dispose(true); } };
}
