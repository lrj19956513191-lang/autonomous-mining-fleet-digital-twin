export type BackendConnectionEnv = {
  VITE_BACKEND_ORIGIN?: string;
  VITE_VEHICLE_WS_URL?: string;
};
export type ResolvedBackendConnection = {
  backendOrigin: string;
  sceneUrl: string;
  vehicleWsUrl: string;
  fleetWsUrl: string;
};

function parseUrl(value: string, variable: string): URL {
  if (value.includes('?') || value.includes('#')) {
    throw new Error(`${variable} must not include a query or fragment`);
  }
  try {
    return new URL(value);
  } catch (cause) {
    throw new Error(`${variable} must be an absolute URL with a valid port`, { cause });
  }
}

export function resolveBackendConnection(env: BackendConnectionEnv): ResolvedBackendConnection {
  const origin = parseUrl(env.VITE_BACKEND_ORIGIN?.trim() || 'http://127.0.0.1:8000', 'VITE_BACKEND_ORIGIN');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('VITE_BACKEND_ORIGIN must be an http/https origin without credentials, path, query or fragment');
  }
  const socket = new URL('/ws/vehicles', origin);
  socket.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const fleetWsUrl = new URL('/ws/fleet', socket).href;
  const override = env.VITE_VEHICLE_WS_URL?.trim();
  if (override) {
    const explicit = parseUrl(override, 'VITE_VEHICLE_WS_URL');
    if (explicit.protocol !== socket.protocol || explicit.host !== socket.host
      || explicit.pathname !== '/ws/vehicles' || explicit.username || explicit.password
      || explicit.search || explicit.hash) {
      throw new Error('VITE_VEHICLE_WS_URL must match the backend origin and use /ws/vehicles without credentials, query or fragment');
    }
    return { backendOrigin: origin.origin, sceneUrl: '/api/scene', vehicleWsUrl: explicit.href, fleetWsUrl };
  }
  return { backendOrigin: origin.origin, sceneUrl: '/api/scene', vehicleWsUrl: socket.href, fleetWsUrl };
}
