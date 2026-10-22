import { createHistoryClient, type SessionDetail, type SnapshotPage } from './historyClient';
import { createPlaybackClock, type PlaybackClockState } from './playbackClock';
import { createFleetPresentation, type FleetPresentationHandle, type FleetPresentationModel } from '../fleetPresentation';
import type { FleetSnapshot } from '../realtime/fleetTelemetry';
import { parseMineScene } from '../scene/sceneClient';

export interface ReplayViewModel {
  readonly session: SessionDetail | null;
  readonly snapshot: FleetSnapshot | null;
  readonly status: 'LOADING'|'PAUSED'|'PLAYING'|'BUFFERING'|'ENDED'|'ERROR';
  readonly time_seconds: number;
  readonly rate: PlaybackClockState['rate'];
  readonly selectedVehicleId: string | null;
  readonly trackedVehicleId: string | null;
  readonly sceneState: FleetPresentationModel['sceneState'];
  readonly sceneError: string | null;
  readonly renderError: string | null;
  readonly incomplete: boolean;
  readonly gap: Readonly<{from:number;to:number}> | null;
}
export interface ReplaySceneHandle {
  play():void; pause():void; setRate(rate:number):void; seek(time:number):void; replay():void;
  select(id:string|null):void; locateSelected():void; trackSelected():void; stopTracking():void; destroy():void;
}
export interface ReplaySceneCallbacks {
  sessionId:string;
  onModel(model:ReplayViewModel):void;
  onCleanupError(error:Error):void;
}
interface CachedPage { readonly data:SnapshotPage; readonly bytes:number }
const PAGE_BYTES=1024*1024;
const CACHE_BYTES=2*PAGE_BYTES;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Historical source only. Geometry, Entity transactions and camera ownership live in Presentation. */
export function startReplayScene(container:HTMLElement, callbacks:ReplaySceneCallbacks):ReplaySceneHandle {
  let model:ReplayViewModel=Object.freeze({session:null,snapshot:null,status:'LOADING',time_seconds:0,rate:1,
    selectedVehicleId:null,trackedVehicleId:null,sceneState:'LOADING',sceneError:null,renderError:null,incomplete:false,gap:null});
  let disposed=false, terminal=false, cleaning=false, advancing=false, depth=0;
  let generation=0, wantedPlaying=false, hidden=document.hidden;
  let presentation:FleetPresentationHandle|undefined;
  let shared:FleetPresentationModel|undefined;
  let clock:ReturnType<typeof createPlaybackClock>|undefined;
  let client:ReturnType<typeof createHistoryClient>;
  let currentAbort:AbortController|undefined;
  const controllers=new Set<AbortController>();
  let pages:CachedPage[]=[];
  let pendingPage:object|undefined;
  let raf:{id?:number}|undefined;
  const pendingFrameReleases=new Set<number>();
  let removeVisibility:(()=>void)|undefined;
  let presentationReleased=false, presentationCleanupFailed=false;
  let collecting:Error[]|undefined;
  let retainedDiagnostics:Error[]=[];
  const active=()=>!disposed&&!terminal;
  const current=(epoch:number)=>active()&&epoch===generation;
  const now=()=>performance.now();
  function report(errors:Error[]) {
    if(!errors.length)return;
    const all=[...retainedDiagnostics,...errors];retainedDiagnostics=[];
    const aggregate=new AggregateError(all,'Replay cleanup incomplete; resource release unconfirmed');
    try{callbacks.onCleanupError(aggregate);}catch(cause){retainedDiagnostics=[aggregate,new Error('Replay diagnostic consumer failed',{cause})];}
  }
  function cancelFrame(errors:Error[]=[]) {
    const ticket=raf;raf=undefined; // Invalidate callbacks independently of release acknowledgement.
    if(ticket?.id!==undefined)pendingFrameReleases.add(ticket.id);
    for(const id of pendingFrameReleases)try{cancelAnimationFrame(id);pendingFrameReleases.delete(id);}
    catch(cause){errors.push(new Error('Replay rAF release unconfirmed',{cause}));}
    return errors;
  }
  function abortRequests(errors:Error[]=[]) {
    for(const controller of controllers)try{controller.abort();controllers.delete(controller);}catch(cause){errors.push(new Error('Replay HTTP abort unconfirmed',{cause}));}
    return errors;
  }
  function cleanup() {
    if(cleaning)return;cleaning=true;
    const errors:Error[]=[];collecting=errors;
    try{
      cancelFrame(errors);abortRequests(errors);
      if(removeVisibility)try{removeVisibility();removeVisibility=undefined;}catch(cause){errors.push(new Error('Replay visibility listener release unconfirmed',{cause}));}
      if(presentation&&!presentationReleased){
        presentationCleanupFailed=false;
        try{presentation.destroy();}catch(cause){presentationCleanupFailed=true;errors.push(new Error('Replay Presentation release unconfirmed',{cause}));}
        if(!presentationCleanupFailed)presentationReleased=true;
      }
    }finally{collecting=undefined;cleaning=false;}
    report(errors);
  }
  function stopSources() {
    generation++;wantedPlaying=false;pendingPage=undefined;
    report(abortRequests(cancelFrame()));
  }
  function notify(change:Partial<ReplayViewModel>={}) {
    if(disposed)return;
    model=Object.freeze({...model,...change});
    try{callbacks.onModel(model);}catch(error){
      // Consumer failures must not leave an unowned active clock or Viewer.
      terminal=true;stopSources();
      model=Object.freeze({...model,status:'ERROR',renderError:message(error)});
      report([new Error('Replay model consumer failed',{cause:error})]);cleanup();
    }
  }
  function presentationFields():Partial<ReplayViewModel> {
    if(!shared)return {};
    return {selectedVehicleId:shared.selectedVehicleId,trackedVehicleId:shared.trackedVehicleId,
      sceneState:shared.sceneState,sceneError:shared.sceneError,renderError:shared.renderError};
  }
  function operation<T>(fn:()=>T):T {depth++;try{return fn();}finally{depth--;}}
  function source(available:boolean) {operation(()=>presentation?.setSourceAvailable(available));}
  function fail(error:unknown) {
    if(!active())return;
    wantedPlaying=false;report(cancelFrame());
    if(clock)clock.seek(model.time_seconds,now());
    try{source(false);}catch(cause){terminal=true;stopSources();notify({status:'ERROR',renderError:message(cause)});cleanup();return;}
    if(active())notify({...presentationFields(),status:'ERROR',renderError:message(error)});
  }
  function beginGeneration():number {
    generation++;pendingPage=undefined;report(abortRequests());
    if(active()){currentAbort=new AbortController();controllers.add(currentAbort);}
    return generation;
  }
  function remember(data:SnapshotPage) {
    const previous=pages.at(-1)?.data.snapshots.at(-1);
    const first=data.snapshots[0];
    if(previous&&first&&(first.sequence!==previous.sequence+1||first.simulation_time_seconds<=previous.simulation_time_seconds))
      throw new Error('History page boundary is not strictly increasing');
    const bytes=new TextEncoder().encode(JSON.stringify(data)).byteLength;
    if(bytes>PAGE_BYTES)throw new Error('History page exceeds the 1MiB response budget');
    const next=[...pages,{data,bytes}];
    while(next.length>2||next.reduce((sum,p)=>sum+p.bytes,0)>CACHE_BYTES)next.shift();
    pages=next;
  }
  function records():FleetSnapshot[] {
    // At most two bounded pages; no unbounded history/index is retained.
    const unique=new Map<number,FleetSnapshot>();
    for(const page of pages)for(const snapshot of page.data.snapshots)unique.set(snapshot.sequence,snapshot);
    return [...unique.values()].sort((a,b)=>a.sequence-b.sequence);
  }
  function at(time:number) {
    const all=records();const last=all.at(-1);
    if(!last||!model.session)return null;
    if(time>last.simulation_time_seconds&&last.sequence!==model.session.last_sequence)return null;
    let index=all.length-1;while(index>=0&&all[index].simulation_time_seconds>time)index--;
    if(index<0)return null;
    const snapshot=all[index], next=all[index+1];
    const gap=next&&next.simulation_time_seconds-snapshot.simulation_time_seconds>1
      ?Object.freeze({from:snapshot.simulation_time_seconds,to:next.simulation_time_seconds}):null;
    return {snapshot,gap};
  }
  function apply(snapshot:FleetSnapshot):boolean {
    if(!active())return false;
    if(model.snapshot?.session_id===snapshot.session_id&&model.snapshot.sequence===snapshot.sequence)return true;
    const applied=operation(()=>presentation!.applySnapshot(snapshot));
    if(!active())return false;
    if(!applied)throw new Error(shared?.renderError||'History snapshot transaction did not commit');
    return true;
  }
  function schedule() {
    if(!active()||hidden||raf||model.status!=='PLAYING')return;
    const ticket:{id?:number}={};raf=ticket;
    try{
      ticket.id=requestAnimationFrame(()=>{
        if(raf!==ticket||!active())return;raf=undefined;
        try{advance();if(active()){prefetch();schedule();}}catch(error){fail(error);}
      });
    }catch(error){if(raf===ticket)raf=undefined;fail(error);return;}
    if(!active()||raf!==ticket){pendingFrameReleases.add(ticket.id);report(cancelFrame());}
  }
  function startPlaying() {
    if(!active()||!clock||hidden||clock.getState().status==='ENDED')return;
    clock.play(now());source(true);
    if(!active())return;
    notify({...presentationFields(),status:'PLAYING',renderError:null});
    if(active()&&wantedPlaying){prefetch();schedule();}
  }
  function prefetch(force=false) {
    if(!active()||!model.session||pendingPage||!wantedPlaying||hidden)return;
    const tail=pages.at(-1)?.data;
    if(!tail||tail.next_after_sequence===null)return;
    if(!force&&pages.length===2&&model.time_seconds<tail.snapshots[0].simulation_time_seconds)return;
    const epoch=generation, request={};pendingPage=request;
    void client.getSnapshots({session:model.session,signal:currentAbort!.signal,afterSequence:tail.next_after_sequence}).then(page=>{
      if(!current(epoch)||pendingPage!==request)return;
      remember(page);pendingPage=undefined;
      if(model.status==='BUFFERING'&&wantedPlaying&&!hidden)startPlaying();
    }).catch(error=>{if(current(epoch)){pendingPage=undefined;fail(error);}});
  }
  function advance() {
    if(advancing)return;advancing=true;
    try{advanceCursor();}finally{advancing=false;}
  }
  function advanceCursor() {
    if(!active()||!clock||model.status!=='PLAYING')return;
    const epoch=generation;const previous=model.time_seconds;
    const state=clock.tick(now());const chosen=at(state.time_seconds);
    if(!chosen){
      // A long frame may outrun both cached pages. Commit the last real cached
      // snapshot before evicting any page, so BUFFERING never strands its cursor.
      const boundary=records().at(-1);
      let frozen=previous;let confirmed=model.snapshot;
      if(boundary&&boundary.simulation_time_seconds>=previous&&boundary.simulation_time_seconds<=state.time_seconds){
        if(!apply(boundary)||!current(epoch))return;
        frozen=boundary.simulation_time_seconds;confirmed=boundary;
      }
      clock.seek(frozen,now());source(false);
      if(current(epoch)){notify({...presentationFields(),status:'BUFFERING',snapshot:confirmed,time_seconds:frozen,gap:null});
        if(current(epoch)&&wantedPlaying)prefetch(true);}
      return;
    }
    if(!apply(chosen.snapshot)||!current(epoch))return;
    if(state.status==='ENDED'){wantedPlaying=false;source(false);}
    if(current(epoch))notify({...presentationFields(),snapshot:chosen.snapshot,time_seconds:state.time_seconds,
      status:state.status,gap:chosen.gap});
  }
  function seekTo(time:number,autoplay=false) {
    if(!active()||!clock||!model.session||depth)return;
    if(typeof time!=='number'||!Number.isFinite(time)||time<model.session.first_simulation_time||time>model.session.last_simulation_time)
      throw new RangeError('Replay seek outside the recorded range');
    wantedPlaying=false;report(cancelFrame());clock.seek(model.time_seconds,now());
    const epoch=beginGeneration();wantedPlaying=autoplay;source(false);
    if(!current(epoch))return;
    pages=[];notify({...presentationFields(),status:'LOADING',renderError:null});
    if(!current(epoch))return;
    void client.seek({session:model.session,signal:currentAbort!.signal,timeSeconds:time}).then(result=>{
      if(!current(epoch))return;
      const snapshots=result.next_snapshot?[result.snapshot,result.next_snapshot]:[result.snapshot];
      const last=snapshots.at(-1)!;
      remember({session_id:result.session_id,snapshots,next_after_sequence:last.sequence<model.session!.last_sequence?last.sequence:null});
      if(!apply(result.snapshot)||!current(epoch))return;
      const state=clock!.seek(time,now());const chosen=at(time)!;
      notify({...presentationFields(),snapshot:result.snapshot,time_seconds:time,status:state.status,renderError:null,gap:chosen.gap});
      if(current(epoch)&&wantedPlaying)startPlaying();
    }).catch(error=>{if(current(epoch))fail(error);});
  }
  const handle:ReplaySceneHandle={
    play(){if(!active()||depth||!clock||!['PAUSED','ENDED'].includes(model.status))return;
      if(clock.getState().status==='ENDED')return;wantedPlaying=true;startPlaying();},
    pause(){if(!active()||depth||!clock||model.status==='ERROR')return;
      if(model.status==='LOADING'){wantedPlaying=false;return;}
      try{if(model.status==='PLAYING')advance();if(!active())return;wantedPlaying=false;report(cancelFrame());
        const state=clock.seek(model.time_seconds,now());source(false);if(active())notify({...presentationFields(),status:state.status});
      }catch(error){fail(error);}},
    setRate(rate){if(!active()||depth||!clock)return;
      if(![0.5,1,2,4].includes(rate))throw new RangeError('Unsupported replay rate');
      try{if(model.status==='PLAYING')advance();if(!active())return;const state=clock.setRate(rate,now());notify({rate:state.rate});}catch(error){fail(error);}},
    seek(time){seekTo(time);}, replay(){if(model.session)seekTo(model.session.first_simulation_time,true);},
    select(id){if(active()&&!depth)presentation?.select(id);},
    locateSelected(){if(active()&&!depth)presentation?.locateSelected();},
    trackSelected(){if(active()&&!depth&&model.status==='PLAYING'&&!hidden)presentation?.trackSelected();},
    stopTracking(){if(active()&&!depth)presentation?.stopTracking();},
    destroy(){disposed=true;generation++;wantedPlaying=false;pendingPage=undefined;pages=[];cleanup();},
  };
  function visibilityChanged() {
    if(!active()||hidden===document.hidden)return;
    hidden=document.hidden;
    try{
      if(hidden){report(cancelFrame());if(clock){clock.seek(model.time_seconds,now());source(false);
        if(active()&&model.status==='PLAYING')notify({...presentationFields(),status:'PAUSED'});}}
      else if(wantedPlaying&&model.status==='PAUSED')startPlaying();
      else if(wantedPlaying&&model.status==='BUFFERING'){if(at(model.time_seconds))startPlaying();else prefetch(true);}
    }catch(error){fail(error);}
  }
  try{
    client=createHistoryClient();
    presentation=createFleetPresentation(container,{
      onModel(value){
        if(disposed)return;shared=value;
        if(value.fatal){
          terminal=true;stopSources();
          try{notify({...presentationFields(),status:'ERROR'});}finally{cleanup();}
        }else if(!depth&&active())notify(presentationFields());
      },
      onFatal(){terminal=true;stopSources();},
      onCleanupError(error){presentationCleanupFailed=true;if(collecting)collecting.push(error);else report([error]);},
    });
    if(!active()){cleanup();return handle;}
    document.addEventListener('visibilitychange',visibilityChanged);
    removeVisibility=()=>document.removeEventListener('visibilitychange',visibilityChanged);
    const epoch=beginGeneration();
    void (async()=>{
      const session=await client.getSession({sessionId:callbacks.sessionId,signal:currentAbort!.signal});
      if(!current(epoch))return;
      if(session.state==='RECORDING')throw new Error('Active history session cannot be replayed');
      notify({session,incomplete:session.incomplete});if(!current(epoch))return;
      const signal=currentAbort!.signal;
      const [scene,page]=await Promise.all([client.getScene({sessionId:session.session_id,signal}),client.getSnapshots({session,signal})]);
      if(!current(epoch))return;remember(page);
      // The HTTP client returns a deeply readonly DTO. Reuse the existing parser
      // to give Presentation its declared MineScene shape without an unsafe cast.
      const presentationScene=parseMineScene(scene);
      if(!presentationScene)throw new Error('Invalid stored scene');
      operation(()=>presentation!.renderScene(presentationScene));if(!current(epoch))return;
      const first=page.snapshots[0];if(!first)throw new Error('History is missing its initial snapshot');
      if(!apply(first)||!current(epoch))return;
      clock=createPlaybackClock({start:session.first_simulation_time,end:session.last_simulation_time});
      notify({...presentationFields(),snapshot:first,status:clock.getState().status,time_seconds:first.simulation_time_seconds,
        gap:at(first.simulation_time_seconds)?.gap??null});
    })().catch(error=>{if(current(epoch))fail(error);});
  }catch(error){if(active())fail(error);else cleanup();}
  return handle;
}