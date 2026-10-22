import type { FleetSnapshot } from './realtime/fleetTelemetry';
import type { ConnectionState } from './realtime/vehicleSocket';
import type { SceneLoadState } from './App';
import { resolveBackendConnection } from './backendConnection';
import { connectFleetSocket } from './realtime/fleetSocket';
import { loadMineScene } from './scene/sceneClient';
import { createFleetPresentation, FleetPresentationError,
  type FleetPresentationHandle, type FleetPresentationModel } from './fleetPresentation';

export interface FleetViewModel {
  readonly snapshot: FleetSnapshot | null;
  readonly selectedVehicleId: string | null;
  readonly trackedVehicleId: string | null;
  readonly sceneState: SceneLoadState;
  readonly connectionState: ConnectionState;
  readonly sceneError: string | null;
  readonly renderError: string | null;
  readonly dataStale: boolean;
  readonly currentConnectionConfirmed: boolean;
}
export interface FleetSceneHandle {
  select(id: string | null): void;
  locateSelected(): void;
  trackSelected(): void;
  stopTracking(): void;
  destroy(): void;
}
export interface FleetSceneCallbacks {
  onModel(model: FleetViewModel): void;
  onCleanupError(error: Error): void;
}
function describeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); current = current instanceof Error ? current.cause : undefined) {
    seen.add(current); messages.push(current instanceof Error ? current.message : String(current));
  }
  return messages.join(': ');
}

/** Live source only: presentation owns all Cesium operations and render-fatal decisions. */
export function startFleetScene(container: HTMLElement, callbacks: FleetSceneCallbacks): FleetSceneHandle {
  let model: FleetViewModel = Object.freeze({snapshot:null,selectedVehicleId:null,trackedVehicleId:null,
    sceneState:'LOADING',connectionState:'CONNECTING',sceneError:null,renderError:null,
    dataStale:false,currentConnectionConfirmed:false});
  let disposed = false;
  let terminating = false;
  let cleaning = false;
  let primaryError: Error | undefined;
  let connectionState: ConnectionState = 'CONNECTING';
  let confirmed = false;
  let stale = false;
  let sceneRequestError: string | undefined;
  let presentation: FleetPresentationHandle | undefined;
  let abort: AbortController | undefined;
  let socket: ReturnType<typeof connectFleetSocket> | undefined;
  let presentationReleased = false;
  let presentationCleanupFailed = false;
  const released = new Set<string>();
  let cleanupErrors: Error[] | undefined;
  const active = () => !disposed && !terminating;
  const sourceIsLive = () => connectionState === 'LIVE';
  function publish(change: Partial<FleetViewModel> = {}) {
    if (!active()) return;
    model = Object.freeze({...model,...change,connectionState,
      currentConnectionConfirmed:confirmed,dataStale:stale});
    callbacks.onModel(model);
  }
  function receiveModel(value: FleetPresentationModel) {
    if (disposed || (terminating && !value.fatal)) return;
    const disconnected = connectionState === 'CLOSED' || connectionState === 'ERROR';
    if (value.snapshot && value.snapshot !== model.snapshot) { confirmed = !disconnected; stale = disconnected; }
    if (value.fatal) { confirmed = false; stale = value.snapshot !== null; }
    const {fatal,...shared} = value;
    model = Object.freeze({...model,...shared,connectionState,currentConnectionConfirmed:confirmed,dataStale:stale,
      ...(sceneRequestError === undefined ? {} : {sceneState:'ERROR' as const,sceneError:sceneRequestError})});
    try { callbacks.onModel(model); }
    finally { if (fatal) handle.destroy(); }
  }
  const handle: FleetSceneHandle = {
    select(id) { if (active()) presentation?.select(id); },
    locateSelected() { if (active()) presentation?.locateSelected(); },
    trackSelected() {
      if (active() && confirmed && connectionState === 'LIVE') presentation?.trackSelected();
    },
    stopTracking() { if (active()) presentation?.stopTracking(); },
    destroy() {
      disposed = true;
      if (cleaning) return;
      cleaning = true;
      const errors: Error[] = [];
      cleanupErrors = errors;
      const release = (name:string, operation:(()=>void)|undefined) => {
        if (!operation || released.has(name)) return;
        try { operation(); released.add(name); }
        catch(cause) { errors.push(new Error(`${name} release unconfirmed`,{cause})); }
      };
      try {
        release('abort',abort ? ()=>abort!.abort() : undefined);
        release('socket',socket ? ()=>socket!.close() : undefined);
        if (presentation && !presentationReleased) {
          presentationCleanupFailed = false;
          try { presentation.destroy(); }
          catch(cause) { presentationCleanupFailed = true; errors.push(new Error('Presentation release unconfirmed',{cause})); }
          if (!presentationCleanupFailed) presentationReleased = true;
        }
      } finally { cleaning = false; cleanupErrors = undefined; }
      if (errors.length) callbacks.onCleanupError(new AggregateError(errors,
        'Fleet cleanup failed; resource release unconfirmed',{cause:primaryError}));
    },
  };
  function continueSetup() {
    if (active()) return true;
    handle.destroy(); return false;
  }
  function sceneFailed(error: unknown) {
    if (!active()) return;
    // Render failures already published the precise shared-layer diagnosis.
    if (error instanceof FleetPresentationError) return;
    sceneRequestError = describeError(error) || 'Unable to load mine scene';
    publish({sceneState:'ERROR',sceneError:sceneRequestError});
  }
  try {
    const connection = resolveBackendConnection({VITE_BACKEND_ORIGIN:import.meta.env.VITE_BACKEND_ORIGIN,
      VITE_VEHICLE_WS_URL:import.meta.env.VITE_VEHICLE_WS_URL});
    presentation = createFleetPresentation(container,{
      onModel:receiveModel,
      onFatal(error) {
        // This callback precedes terminal UI publication and closes every network entry.
        terminating = true; primaryError = error;
        if (!abort) connectionState = 'CLOSED';
      },
      onCleanupError(error) {
        presentationCleanupFailed = true;
        if (cleanupErrors) {
          if (error instanceof AggregateError) cleanupErrors.push(...error.errors);
          else cleanupErrors.push(error);
        } else callbacks.onCleanupError(error);
      },
    });
    if (!continueSetup()) return handle;
    abort = new AbortController();
    if (!continueSetup()) return handle;
    try {
      const request = loadMineScene({url:connection.sceneUrl,signal:abort.signal});
      void request.then(scene=>{
        if (!active()) return;
        presentation!.renderScene(scene);
      }).catch(sceneFailed);
    } catch(error) { sceneFailed(error); }
    if (!continueSetup()) return handle;
    socket = connectFleetSocket({url:connection.fleetWsUrl,
      onConnectionState(state) {
        if (!active()) return;
        // Retain real transport state even while presentation defers its batch notification (R1).
        connectionState = state;
        if (state === 'CLOSED' || state === 'ERROR') { confirmed = false; stale = model.snapshot !== null; }
        presentation!.setSourceAvailable(state === 'LIVE');
      },
      onSnapshot(snapshot) { if (active()) presentation!.applySnapshot(snapshot); },
    });
    if (!continueSetup()) return handle;
    // The constructor may return after synchronous external Viewer destruction.
    presentation.setSourceAvailable(sourceIsLive());
    continueSetup();
  } catch(error) {
    if (active()) {
      connectionState = 'CLOSED';
      try { publish({sceneState:'ERROR',sceneError:describeError(error) || 'Unable to initialize Cesium scene',
        connectionState:'CLOSED'}); }
      finally { handle.destroy(); }
    } else handle.destroy();
  }
  return handle;
}