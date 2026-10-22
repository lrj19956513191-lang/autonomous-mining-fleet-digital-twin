import { parseVehicleTelemetry, type VehicleTelemetry } from './vehicleTelemetry';

export type ConnectionState = 'CONNECTING' | 'LIVE' | 'CLOSED' | 'ERROR';
export type SocketTransport = Pick<WebSocket,
  'readyState' | 'addEventListener' | 'removeEventListener' | 'close'>;
export type VehicleSocketOptions = {
  url: string;
  onTelemetry: (telemetry: VehicleTelemetry) => void;
  onConnectionState: (state: ConnectionState) => void;
  createSocket?: (url: string) => SocketTransport;
};
export type VehicleSocketHandle = { close(): void };

export function connectVehicleSocket(options: VehicleSocketOptions): VehicleSocketHandle {
  let hasError = false;
  let disposed = false;
  function reportState(state: ConnectionState) {
    if (!disposed) options.onConnectionState(state);
  }
  reportState('CONNECTING');
  let socket: SocketTransport;
  try {
    socket = (options.createSocket ?? ((url) => new WebSocket(url)))(options.url);
  } catch {
    reportState('ERROR');
    return { close() {} };
  }
  function onOpen() {
    reportState('LIVE');
  }
  function onError() {
    if (disposed) return;
    hasError = true;
    reportState('ERROR');
  }
  function onClose() {
    if (!hasError) reportState('CLOSED');
  }
  function onMessage(event: MessageEvent) {
    if (disposed) return;
    if (typeof event.data !== 'string') {
      console.warn('Dropped non-text telemetry message');
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(event.data);
    } catch {
      console.warn('Dropped invalid telemetry JSON');
      return;
    }
    const telemetry = parseVehicleTelemetry(input);
    if (!telemetry) {
      console.warn('Dropped invalid vehicle telemetry');
      return;
    }
    options.onTelemetry(telemetry);
  }
  socket.addEventListener('open', onOpen);
  socket.addEventListener('error', onError);
  socket.addEventListener('close', onClose);
  socket.addEventListener('message', onMessage);
  return {
    close() {
      if (disposed) return;
      disposed = true;
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('message', onMessage);
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    },
  };
}
