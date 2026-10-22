import { useEffect, useRef, useState } from 'react';
import { startFleetScene, type FleetSceneHandle, type FleetViewModel } from './fleetScene';
import { connectVehicleSocket, type ConnectionState } from './realtime/vehicleSocket';
import { createViewer, type ViewerHandle } from './cesium/viewer';
import { upsertVehicleEntity } from './vehicle/vehicleEntity';
import { focusVehicle } from './cesium/camera';
import { resolveBackendConnection, type ResolvedBackendConnection } from './backendConnection';
import { loadMineScene } from './scene/sceneClient';
import { renderMineScene, type SceneRenderHandle } from './scene/sceneRenderer';
import { createHistoryClient, HistoryLoadError, type HistoryStatus, type SessionSummary } from './history/historyClient';
import { startReplayScene, type ReplaySceneHandle, type ReplayViewModel } from './history/replayScene';
import { HistoryPanel } from './history/HistoryPanel';

export type SceneLoadState = 'LOADING' | 'READY' | 'ERROR';

type SceneCallbacks = {
  onConnectionState: (state: ConnectionState) => void;
  onVehicleReceived: (received: boolean) => void;
  onSceneError: (message: string | null) => void;
  onSceneLoadState: (state: SceneLoadState) => void;
};

export function startVehicleScene(container: HTMLElement, callbacks: SceneCallbacks): () => void {
  let connection: ResolvedBackendConnection;
  let handle: ViewerHandle;
  try {
    try {
      connection = resolveBackendConnection({
        VITE_BACKEND_ORIGIN: import.meta.env.VITE_BACKEND_ORIGIN,
        VITE_VEHICLE_WS_URL: import.meta.env.VITE_VEHICLE_WS_URL,
      });
    } finally {
      callbacks.onVehicleReceived(false);
      callbacks.onSceneError(null);
    }
    handle = createViewer(container);
  } catch (error) {
    callbacks.onSceneLoadState('ERROR');
    callbacks.onSceneError(error instanceof Error ? error.message : 'Unable to initialize Cesium scene');
    callbacks.onConnectionState('CLOSED');
    return () => {};
  }
  let cameraLocated = false;
  let disposed = false;
  const sceneController = new AbortController();
  callbacks.onSceneLoadState('LOADING');
  callbacks.onConnectionState('CONNECTING');
  let sceneHandle: SceneRenderHandle | undefined;
  void loadMineScene({ url: connection.sceneUrl, signal: sceneController.signal }).then(scene => {
    if (disposed || handle.viewer.isDestroyed()) return;
    sceneHandle = renderMineScene(handle.viewer.entities, scene);
    callbacks.onSceneLoadState('READY');
  }).catch(error => {
    if (disposed || handle.viewer.isDestroyed()) return;
    callbacks.onSceneLoadState('ERROR');
    callbacks.onSceneError(error instanceof Error ? error.message : 'Unable to load mine scene');
  });
  const socketHandle = connectVehicleSocket({
    url: connection.vehicleWsUrl,
    onTelemetry(telemetry) {
      if (disposed || handle.viewer.isDestroyed()) return;
      upsertVehicleEntity(handle.viewer.entities, telemetry);
      if (!cameraLocated) {
        focusVehicle(handle.viewer, telemetry);
        cameraLocated = true;
      }
      callbacks.onVehicleReceived(true);
    },
    onConnectionState(state) {
      if (!disposed && !handle.viewer.isDestroyed()) callbacks.onConnectionState(state);
    },
  });
  return () => {
    if (disposed) return;
    disposed = true;
    sceneController.abort();
    socketHandle.close();
    sceneHandle?.destroy();
    handle.destroy();
  };
}

export function FleetPanel({ model, controls }: { model: FleetViewModel; controls: FleetSceneHandle | null }) {
  const vehicles = [...(model.snapshot?.vehicles ?? [])].sort((left, right) => left.vehicle_id.localeCompare(right.vehicle_id));
  const selected = vehicles.find(vehicle => vehicle.vehicle_id === model.selectedVehicleId);
  const online = model.currentConnectionConfirmed && model.connectionState === 'LIVE' ? vehicles.length : 0;
  return <section className="fleet-panel" aria-label="Fleet monitoring">
    <p>Total: {model.snapshot ? vehicles.length : 'unconfirmed'} · Online: {online}</p>
    <p>Selected: {model.selectedVehicleId ?? 'none'} · Tracked: {model.trackedVehicleId ?? 'none'}</p>
    {model.dataStale && <p role="status">Last received data is stale</p>}
    <div className="fleet-controls">
      <button disabled={!selected} onClick={() => controls?.locateSelected()}>Locate selected</button>
      <button disabled={!selected || !model.currentConnectionConfirmed || model.connectionState !== 'LIVE'}
        onClick={() => controls?.trackSelected()}>Track selected</button>
      <button disabled={!model.trackedVehicleId} onClick={() => controls?.stopTracking()}>Stop tracking</button>
      <button disabled={!selected} onClick={() => controls?.select(null)}>Clear selection</button>
    </div>
    <div className="fleet-information">
      <ul aria-label="Vehicles">{vehicles.map(vehicle => <li key={vehicle.vehicle_id} data-vehicle-id={vehicle.vehicle_id}>
        <button aria-pressed={vehicle.vehicle_id === model.selectedVehicleId}
          onClick={() => controls?.select(vehicle.vehicle_id)}>{vehicle.vehicle_id}</button>
        {' '}{vehicle.status} · {vehicle.speed} km/h · SOC {vehicle.soc}% · Load: {vehicle.load}
      </li>)}</ul>
      <div aria-label="Selected vehicle details">{selected ? <>
        <p>{selected.vehicle_id}: {selected.status}</p>
        <p>Speed: {selected.speed} km/h · SOC: {selected.soc}% · Load: {selected.load}</p>
        <p>Longitude: {selected.longitude} · Latitude: {selected.latitude}</p>
        <p>Ellipsoid height: {selected.height} m · Heading: {selected.heading}°</p>
        <p>UTC: {selected.timestamp}</p>
      </> : <p>No vehicle selected</p>}</div>
    </div>
  </section>;
}

export type AppMode='LIVE'|'SWITCHING'|'REPLAY'|'ERROR';
export interface HistoryBrowserModel {
  readonly status:HistoryStatus|null;readonly statusError:string|null;
  readonly sessions:readonly SessionSummary[];readonly nextCursor:string|null;
  readonly loading:boolean;readonly error:string|null;
}
export interface AppModeModel {
  readonly mode:AppMode;readonly live:FleetViewModel;readonly replay:ReplayViewModel|null;
  readonly error:string|null;readonly history:HistoryBrowserModel;
}
export interface AppModeHost extends ReplaySceneHandle {
  goLive():void;enterReplay(sessionId:string):void;refreshHistory():void;loadMore():void;
  getState():AppModeModel;isReleased():boolean;
}
function initialAppModel():AppModeModel {
  return Object.freeze({mode:'LIVE',live:Object.freeze({snapshot:null,selectedVehicleId:null,trackedVehicleId:null,
    sceneState:'LOADING',connectionState:'CONNECTING',sceneError:null,renderError:null,dataStale:false,currentConnectionConfirmed:false}),
    replay:null,error:null,history:Object.freeze({status:null,statusError:null,sessions:Object.freeze([]),nextCursor:null,loading:false,error:null})});
}
const uuidV4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const entire=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.exec(value)?.[0].length===value.length;
function parseHistoryStatus(input:unknown):HistoryStatus {
  const keys=['enabled','state','session_id','last_offered_sequence','last_persisted_sequence','error_code','error_message'];
  const bad=()=>new HistoryLoadError('SCHEMA','Invalid history status');
  if(!input||typeof input!=='object'||Array.isArray(input)||Reflect.ownKeys(input).length!==keys.length||!keys.every(k=>Object.hasOwn(input,k)))throw bad();
  const v=input as Record<string,unknown>;
  const sequence=(value:unknown)=>value===null||(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0);
  const states=['DISABLED_CONFIG','STARTING','RECORDING','STOPPING','COMPLETED','FAILED'];
  if(typeof v.enabled!=='boolean'||typeof v.state!=='string'||!states.includes(v.state)
    ||(v.enabled?(v.state==='DISABLED_CONFIG'||!entire(v.session_id,uuidV4)):(v.state!=='DISABLED_CONFIG'||v.session_id!==null))
    ||!sequence(v.last_offered_sequence)||!sequence(v.last_persisted_sequence))throw bad();
  if(v.last_persisted_sequence!==null&&(v.last_offered_sequence===null||(v.last_persisted_sequence as number)>(v.last_offered_sequence as number)))throw bad();
  const failed=v.state==='FAILED'||v.state==='DISABLED_CONFIG';
  if(failed?(!entire(v.error_code,/^[A-Z][A-Z0-9_]{0,63}$/)||typeof v.error_message!=='string'||!v.error_message.length)
    :(v.error_code!==null||v.error_message!==null))throw bad();
  if(v.state==='DISABLED_CONFIG'&&(v.last_offered_sequence!==null||v.last_persisted_sequence!==null))throw bad();
  if((v.state==='RECORDING'||v.state==='COMPLETED')&&v.last_persisted_sequence===null)throw bad();
  return Object.freeze({...v}) as unknown as HistoryStatus;
}
/** Minimal private adapter for Task4's status endpoint; the public HistoryClient stays unchanged. */
async function readHistoryStatus(signal:AbortSignal):Promise<HistoryStatus> {
  signal.throwIfAborted();let response:Response;
  try{response=await fetch('/api/history/status',{signal,cache:'no-store'});}
  catch(cause){signal.throwIfAborted();if(cause instanceof Error&&cause.name==='AbortError')throw cause;
    throw new HistoryLoadError('NETWORK','Unable to read recording status',{cause});}
  signal.throwIfAborted();
  if(!response.ok)throw new HistoryLoadError('HTTP',`Recording status HTTP ${response.status}`,{status:response.status});
  let input:unknown;
  try{input=await response.json();}catch(cause){signal.throwIfAborted();if(cause instanceof Error&&cause.name==='AbortError')throw cause;
    throw new HistoryLoadError('JSON','Unable to decode recording status',{cause});}
  signal.throwIfAborted();const value=parseHistoryStatus(input);signal.throwIfAborted();return value;
}
function historyMessage(error:unknown):string {
  return error instanceof HistoryLoadError?`${error.code}: ${error.message}`:error instanceof Error?error.message:String(error);
}
type ModeTarget={mode:'LIVE'}|{mode:'REPLAY';sessionId:string};
type SourceHandle=FleetSceneHandle|ReplaySceneHandle;
interface ModeOwner {
  target:ModeTarget;generation:number;valid:boolean;constructing:boolean;started:boolean;
  handle?:SourceHandle;released:boolean;releasing:boolean;releaseFailed:boolean;
}
function sameTarget(a:ModeTarget|undefined,b:ModeTarget|undefined):boolean {
  return a?.mode===b?.mode&&(a?.mode!=='REPLAY'||b?.mode==='REPLAY'&&a.sessionId===b.sessionId);
}

/** One source lease. Old generations are invalidated before any release or user notification. */
export function createAppModeHost(container:HTMLElement,callbacks:{onModel(value:AppModeModel):void;onCleanupError(error:Error):void}):AppModeHost {
  let model=initialAppModel();let generation=0,historyGeneration=0;
  let disposed=false,blocked=false,pumping=false;
  let desired:ModeTarget|undefined={mode:'LIVE'};let owner:ModeOwner|undefined;
  const requests=new Set<AbortController>();let pendingDiagnostics:Error[]=[];
  function report(error:Error) {
    const original=new AggregateError([...pendingDiagnostics,error],'Mode resource release unconfirmed');pendingDiagnostics=[];
    try{callbacks.onCleanupError(original);}catch(cause){pendingDiagnostics=[original,new Error('Cleanup diagnostic consumer failed',{cause})];}
  }
  function notify(change:Partial<AppModeModel>={}) {
    if(disposed)return;model=Object.freeze({...model,...change});
    try{callbacks.onModel(model);}catch(cause){
      blocked=true;generation++;desired=undefined;if(owner)owner.valid=false;
      model=Object.freeze({...model,mode:'ERROR',error:'Mode model consumer failed'});
      abortHistory();report(new Error('Mode model consumer failed',{cause}));pump();
    }
  }
  function abortHistory() {
    historyGeneration++;
    for(const controller of requests)try{controller.abort();requests.delete(controller);}
    catch(cause){blocked=true;desired=undefined;if(owner)owner.valid=false;report(new Error('History request abort unconfirmed',{cause}));}
  }
  function stopWithError(error:Error) {
    blocked=true;generation++;desired=undefined;if(owner)owner.valid=false;
    abortHistory();notify({mode:'ERROR',error:historyMessage(error)});report(error);
  }
  const valid=(record:ModeOwner)=>!disposed&&!blocked&&record===owner&&record.valid&&record.generation===generation;
  function cleanupError(record:ModeOwner,error:Error) {
    record.releaseFailed=true;
    if(record.released){report(error);return;}
    if(record.releasing){report(error);return;}
    stopWithError(error);pump();
  }
  function release(record:ModeOwner):boolean {
    record.valid=false;
    if(record.constructing)return false;
    if(record.released)return true;
    if(!record.started){record.released=true;return true;}
    if(!record.handle)return false;
    record.releasing=true;record.releaseFailed=false;
    try{record.handle.destroy();}catch(cause){record.releaseFailed=true;report(new Error('Mode source release unconfirmed',{cause}));}
    finally{record.releasing=false;}
    if(record.releaseFailed){blocked=true;desired=undefined;
      notify({mode:'ERROR',error:'Previous mode resources were not confirmed released'});return false;}
    record.released=true;return true;
  }
  function adopt(record:ModeOwner,handle:SourceHandle) {
    record.handle=handle;record.constructing=false;
    if(!handle||typeof handle.destroy!=='function'){stopWithError(new Error('Source returned no releasable handle'));return;}
    pump();
  }
  function constructionFailed(record:ModeOwner,cause:unknown) {
    record.constructing=false;
    // A constructor may have allocated resources before throwing. No second Viewer is safe.
    stopWithError(new Error('Mode source construction failed; resource ownership unconfirmed',{cause}));pump();
  }
  function pump() {
    if(pumping)return;pumping=true;
    try{
      for(;;){
        if(owner&&(!valid(owner)||!sameTarget(owner.target,desired))){
          if(!release(owner))break;owner=undefined;continue;
        }
        if(disposed||blocked||!desired||owner)break;
        const record:ModeOwner={target:desired,generation,valid:true,constructing:true,started:false,released:false,releasing:false,releaseFailed:false};
        owner=record;
        notify({mode:record.target.mode,error:null,...(record.target.mode==='LIVE'?{live:initialAppModel().live}:{replay:null})});
        if(!valid(record)){record.constructing=false;continue;}
        record.started=true;
        try{
          const sourceCallbacks={onCleanupError:(error:Error)=>cleanupError(record,error)};
          const result:SourceHandle|PromiseLike<SourceHandle>=record.target.mode==='LIVE'
            ?startFleetScene(container,{...sourceCallbacks,onModel(value){if(valid(record))notify({mode:'LIVE',live:Object.freeze({...value})});}})
            :startReplayScene(container,{...sourceCallbacks,sessionId:record.target.sessionId,onModel(value){if(valid(record))notify({mode:'REPLAY',replay:Object.freeze({...value})});}});
          if(result&&typeof (result as {then?:unknown}).then==='function'){
            void Promise.resolve(result).then(handle=>adopt(record,handle),error=>constructionFailed(record,error));break;
          }
          adopt(record,result as SourceHandle);
        }catch(error){constructionFailed(record,error);}
      }
    }finally{pumping=false;}
  }
  function transition(target:ModeTarget) {
    if(disposed||blocked||sameTarget(desired,target))return;
    desired=target;generation++;if(owner)owner.valid=false;
    abortHistory();
    if(blocked){notify({mode:'ERROR',error:'History request release unconfirmed'});pump();return;}
    notify({mode:'SWITCHING',error:null,history:Object.freeze({...model.history,loading:false})});pump();
  }
  function control(operation:(handle:SourceHandle)=>void) {
    if(owner&&valid(owner)&&!owner.constructing&&owner.handle)operation(owner.handle);
  }
  function playback(operation:(handle:ReplaySceneHandle)=>void) {
    if(owner?.target.mode==='REPLAY')control(handle=>operation(handle as ReplaySceneHandle));
  }
  function readCatalog(more:boolean) {
    if(disposed||blocked||more&&(!model.history.nextCursor||model.history.loading))return;
    const cursor=more?model.history.nextCursor:null;const modeGeneration=generation;
    abortHistory();if(blocked){notify({mode:'ERROR',error:'History request release unconfirmed'});pump();return;}
    const requestGeneration=historyGeneration;const controller=new AbortController();requests.add(controller);
    const current=()=>!disposed&&!blocked&&modeGeneration===generation&&requestGeneration===historyGeneration;
    notify({history:Object.freeze({...model.history,loading:true,error:null,statusError:null})});
    if(!current())return;
    let client:ReturnType<typeof createHistoryClient>;
    try{client=createHistoryClient();}catch(cause){if(current())notify({history:Object.freeze({...model.history,loading:false,error:historyMessage(cause)})});return;}
    void Promise.allSettled([readHistoryStatus(controller.signal),client.listSessions({signal:controller.signal,cursor})]).then(([status,list])=>{
      if(!current())return;
      const sessions=list.status==='fulfilled'?(more?[...new Map([...model.history.sessions,...list.value.sessions].map(s=>[s.session_id,s])).values()]:list.value.sessions):model.history.sessions;
      notify({history:Object.freeze({status:status.status==='fulfilled'?status.value:null,statusError:status.status==='rejected'?historyMessage(status.reason):null,
        sessions:Object.freeze([...sessions]),nextCursor:list.status==='fulfilled'?list.value.next_cursor:model.history.nextCursor,
        loading:false,error:list.status==='rejected'?historyMessage(list.reason):null})});
    });
  }
  const host:AppModeHost={
    enterReplay(sessionId){if(!entire(sessionId,uuidV4))throw new RangeError('Invalid history session ID');
      if(model.history.sessions.find(s=>s.session_id===sessionId)?.state==='RECORDING')return;transition({mode:'REPLAY',sessionId});},
    goLive(){transition({mode:'LIVE'});},refreshHistory(){readCatalog(false);},loadMore(){readCatalog(true);},
    play(){playback(h=>h.play());},pause(){playback(h=>h.pause());},setRate(rate){playback(h=>h.setRate(rate));},seek(time){playback(h=>h.seek(time));},replay(){playback(h=>h.replay());},
    select(id){control(h=>h.select(id));},locateSelected(){control(h=>h.locateSelected());},trackSelected(){control(h=>h.trackSelected());},stopTracking(){control(h=>h.stopTracking());},
    getState(){return model;},isReleased(){return owner===undefined&&requests.size===0;},
    destroy(){disposed=true;generation++;desired=undefined;if(owner)owner.valid=false;abortHistory();pump();},
  };
  pump();return host;
}

export default function App() {
  const containerRef=useRef<HTMLDivElement>(null);
  const hostRef=useRef<AppModeHost|null>(null);
  const [model,setModel]=useState<AppModeModel>(initialAppModel);
  const [historyOpen,setHistoryOpen]=useState(false);
  useEffect(()=>{
    const container=containerRef.current;if(!container)return;
    const previous=hostRef.current;
    if(previous){previous.destroy();if(!previous.isReleased()){
      setModel(value=>Object.freeze({...value,mode:'ERROR',error:'Previous lifecycle resources remain unconfirmed'}));return;}}
    let current=true;
    const host=createAppModeHost(container,{onModel(value){if(current)setModel(value);},
      onCleanupError(error){console.error('Mode cleanup failed; resource release unconfirmed',error);}});
    hostRef.current=host;host.refreshHistory();
    return ()=>{current=false;host.destroy();if(host.isReleased()&&hostRef.current===host)hostRef.current=null;};
  },[]);
  const panelProps={mode:model.mode,recording:model.history.status,recordingError:model.history.statusError,
    sessions:model.history.sessions,sessionsError:model.history.error,loading:model.history.loading,nextCursor:model.history.nextCursor,
    replay:model.replay,controls:model.mode==='REPLAY'?hostRef.current:null,modeError:model.error,
    onOpen(){setHistoryOpen(true);hostRef.current?.refreshHistory();},onReturnLive(){setHistoryOpen(false);hostRef.current?.goLive();},
    onSelectSession(id:string){setHistoryOpen(true);hostRef.current?.enterReplay(id);},onRefresh(){hostRef.current?.refreshHistory();},onLoadMore(){hostRef.current?.loadMore();}};
  const browsing=historyOpen||model.mode!=='LIVE';
  return <main className="app">
    <header>
      <h1>Autonomous Mining Fleet Digital Twin</h1>
      {model.mode==='LIVE'?<>
        <p>Connection: {model.live.connectionState}</p>
        <p>Vehicle: {model.live.snapshot?.vehicles.some(v=>v.vehicle_id==='TRUCK_001')?'TRUCK_001':'waiting for TRUCK_001'}</p>
        <p>Scene: {model.live.sceneState}</p>
        {model.live.sceneError!==null&&<p role="alert">{model.live.sceneError}</p>}
        {model.live.renderError!==null&&<p role="alert">{model.live.renderError}</p>}
      </>:<p>Mode: {model.mode==='REPLAY'?'Historical playback':model.mode}</p>}
      {!browsing&&<HistoryPanel {...panelProps} open={false}/>}
    </header>
    {browsing?<HistoryPanel {...panelProps} open/>:<FleetPanel model={model.live} controls={hostRef.current}/>}
    <div id="cesium-container" className="cesium-container" ref={containerRef}/>
  </main>;
}