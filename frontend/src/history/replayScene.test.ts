import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Cartesian3, Entity, EntityCollection, Event as CesiumEvent, JulianDate,
  PerspectiveFrustum, PointVisualizer, type Viewer } from 'cesium';
import { createViewer, type ViewerHandle } from '../cesium/viewer';
import { focusVehicle } from '../cesium/camera';
import { makeFleetSnapshotFixture } from '../realtime/fleetFixtures';
import { makeSceneInput } from '../scene/sceneFixtures';
import { startReplayScene, type ReplayViewModel } from './replayScene';

vi.mock('../cesium/viewer', () => ({createViewer:vi.fn()}));
vi.mock('../cesium/camera', () => ({focusVehicle:vi.fn()}));
const SID='11111111-1111-4111-8111-111111111111';
const STAMP='2026-10-14T04:00:00.000001+00:00';
const container={} as HTMLElement;
function packet(sequence:number,time=sequence) {
  const value=makeFleetSnapshotFixture(); value.sequence=sequence; value.simulation_time_seconds=time;
  value.vehicles.forEach(v=>{v.longitude+=sequence*0.0001;}); return value;
}
function metadata(end=120,count=end+1,state:'COMPLETED'|'FAILED'|'INTERRUPTED'|'RECORDING'='COMPLETED') {
  const incomplete=state==='FAILED'||state==='INTERRUPTED';
  return {session_id:SID,state,started_utc:STAMP,ended_utc:state==='RECORDING'?null:STAMP,
    snapshot_count:count,first_sequence:0,last_sequence:count-1,first_simulation_time:0,last_simulation_time:end,
    incomplete,failure_code:incomplete?'WRITE_FAILED':null,failure_message:incomplete?'Recorded prefix only':null,
    storage_version:1,fleet_schema_version:1,code_revision:'a'.repeat(40),scene_sha256:'b'.repeat(64),config_sha256:'c'.repeat(64),
    vehicle_configs:[1,2,3].map(i=>({vehicle_id:`TRUCK_00${i}`,route_id:'ROUTE_001',initial_progress_fraction:(i-1)/3,
      cruise_speed_kmh:25,initial_soc:100-i*10,load:65,soc_rate:0.1,parking:null}))};
}
function page(from=0,to=59,last=120) {return {session_id:SID,snapshots:Array.from({length:to-from+1},(_,i)=>packet(from+i)),next_after_sequence:to<last?to:null};}
function response(body:unknown,status=200):Response {return {ok:status>=200&&status<300,status,json:async()=>body} as Response;}
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function viewerFixture() {
  let dead=false;let tracked:Entity|undefined;
  const changed=new CesiumEvent();const actions=new Map<number,unknown>();
  const camera={positionWC:new Cartesian3(6378137,400,1000),directionWC:new Cartesian3(-1,0,0),upWC:new Cartesian3(0,0,1),
    frustum:new PerspectiveFrustum({fov:0.9,aspectRatio:1.6,near:2,far:200000}),
    setView:vi.fn<Viewer['camera']['setView']>(o=>{if(o?.destination instanceof Cartesian3)Cartesian3.clone(o.destination,camera.positionWC);
      if(o?.orientation&&'direction'in o.orientation){Cartesian3.clone(o.orientation.direction!,camera.directionWC);Cartesian3.clone(o.orientation.up!,camera.upWC);}})};
  const viewer={entities:new EntityCollection(),camera,trackedEntityChanged:changed,scene:{pick:vi.fn()},
    screenSpaceEventHandler:{getInputAction:(t:number)=>actions.get(t),setInputAction:(a:unknown,t:number)=>actions.set(t,a),removeInputAction:(t:number)=>actions.delete(t)},
    isDestroyed:()=>dead,get trackedEntity(){return tracked;},set trackedEntity(v:Entity|undefined){tracked=v;changed.raiseEvent(v);}} as unknown as Viewer;
  const handle:ViewerHandle={viewer,destroy:vi.fn(()=>{dead=true;})};return {viewer,handle,camera};
}
let f:ReturnType<typeof viewerFixture>;let now:number;let frames:Map<number,FrameRequestCallback>;let nextFrame:number;
let doc:EventTarget&{hidden:boolean};let models:ReplayViewModel[];let errors:Error[];
let fetcher:ReturnType<typeof vi.fn<typeof fetch>>;
const latest=()=>models.at(-1)!;
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
function frame(ms:number){now=ms;const batch=[...frames.values()];frames.clear();batch.forEach(cb=>cb(ms));}
function start(onModel?:(value:ReplayViewModel)=>void){return startReplayScene(container,{sessionId:SID,onModel(value){models.push(value);onModel?.(value);},onCleanupError(error){errors.push(error);}});}
beforeEach(()=>{
  vi.clearAllMocks();f=viewerFixture();now=0;frames=new Map();nextFrame=0;models=[];errors=[];
  doc=Object.assign(new EventTarget(),{hidden:false});vi.stubGlobal('document',doc);
  vi.spyOn(performance,'now').mockImplementation(()=>now);
  vi.stubGlobal('requestAnimationFrame',vi.fn((cb:FrameRequestCallback)=>{const id=++nextFrame;frames.set(id,cb);return id;}));
  vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>{frames.delete(id);}));
  vi.mocked(createViewer).mockReturnValue(f.handle);
  fetcher=vi.fn<typeof fetch>(async input=>{
    const u=new URL(String(input),'http://local');
    if(u.pathname.endsWith('/scene'))return response(makeSceneInput());
    if(u.pathname.endsWith('/snapshots')){const from=Number(u.searchParams.get('after_sequence'))+1;return response(page(from,Math.min(from+59,120)));}
    if(u.pathname.endsWith('/seek')){const t=Number(u.searchParams.get('time_seconds'));const s=Math.floor(t);return response({session_id:SID,target_time_seconds:t,snapshot:packet(s),next_snapshot:s<120?packet(s+1):null});}
    return response(metadata());
  });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

test('loads_terminal_scene_and_first_snapshot_paused',async()=>{
  const h=start();expect(latest().status).toBe('LOADING');await flush();
  expect(latest().status).toBe('PAUSED');expect(latest().session?.session_id).toBe(SID);
  expect(latest().snapshot?.sequence).toBe(0);expect(latest().snapshot?.timestamp).toBe(STAMP);
  expect(latest().time_seconds).toBe(0);expect(latest().rate).toBe(1);expect(latest().sceneState).toBe('READY');
  expect(f.viewer.entities.values).toHaveLength(16);expect(frames.size).toBe(0);
  expect(fetcher.mock.calls.map(c=>String(c[0]))).toContain(`/api/history/sessions/${SID}/scene`);
  h.destroy();expect(f.viewer.isDestroyed()).toBe(true);expect(f.viewer.entities.values).toHaveLength(0);
});
test('applies_only_when_snapshot_changes_and_preserves_identity',async()=>{
  const h=start();await flush();const entity=f.viewer.entities.getById('TRUCK_001')!;const position=entity.position!;
  const update=vi.spyOn(position,'setValue' as never);h.play();expect(latest().status).toBe('PLAYING');expect(frames.size).toBe(1);
  frame(200);frame(500);expect(latest().time_seconds).toBe(0.5);expect(latest().snapshot?.sequence).toBe(0);expect(update).not.toHaveBeenCalled();
  frame(1000);expect(latest().snapshot?.sequence).toBe(1);expect(update).toHaveBeenCalledTimes(1);
  expect(f.viewer.entities.getById(entity.id)).toBe(entity);expect(entity.position).toBe(position);expect(focusVehicle).toHaveBeenCalledTimes(1);
  h.pause();const frozen=latest().time_seconds;frame(10000);expect(latest().time_seconds).toBe(frozen);expect(frames.size).toBe(0);h.destroy();
});

test('seek_generation_ignores_late_pages',async()=>{
  const old=deferred<Response>();const recent=deferred<Response>();const base=fetcher.getMockImplementation()!;const signals:AbortSignal[]=[];
  fetcher.mockImplementation((input,init)=>{const u=new URL(String(input),'http://local');if(u.pathname.endsWith('/seek')){signals.push(init!.signal!);return u.searchParams.get('time_seconds')==='70'?old.promise:recent.promise;}return base(input,init);});
  const h=start();await flush();h.seek(70);h.seek(5);expect(signals[0].aborted).toBe(true);
  recent.resolve(response({session_id:SID,target_time_seconds:5,snapshot:packet(5),next_snapshot:packet(6)}));await flush();
  expect(latest().snapshot?.sequence).toBe(5);expect(latest().status).toBe('PAUSED');expect(latest().time_seconds).toBe(5);
  old.resolve(response({session_id:SID,target_time_seconds:70,snapshot:packet(70),next_snapshot:packet(71)}));await flush();
  expect(latest().snapshot?.sequence).toBe(5);expect(focusVehicle).toHaveBeenCalledTimes(1);h.destroy();
});

test('bounded_prefetch_and_buffering_rebase_without_catchup',async()=>{
  const delayed=deferred<Response>();const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>{const u=new URL(String(input),'http://local');if(u.pathname.endsWith('/snapshots'))return Number(u.searchParams.get('after_sequence'))===-1?Promise.resolve(response(page(0,0))):delayed.promise;return base(input,init);});
  const h=start();await flush();h.play();frame(500);expect(latest().status).toBe('BUFFERING');expect(latest().time_seconds).toBe(0);expect(frames.size).toBe(0);
  now=100000;delayed.resolve(response(page(1,60)));await flush();expect(latest().status).toBe('PLAYING');expect(latest().time_seconds).toBe(0);
  frame(100500);expect(latest().time_seconds).toBe(0.5);expect(latest().snapshot?.sequence).toBe(0);
  expect(fetcher.mock.calls.filter(c=>String(c[0]).includes('/snapshots'))).toHaveLength(2);h.destroy();
});

test('pause_during_buffering_prevents_automatic_resume',async()=>{
  const delayed=deferred<Response>();const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>String(input).includes('/snapshots')?String(input).includes('after_sequence=-1')?Promise.resolve(response(page(0,0))):delayed.promise:base(input,init));
  const h=start();await flush();h.play();frame(1000);expect(latest().status).toBe('BUFFERING');h.pause();now=8000;
  delayed.resolve(response(page(1,60)));await flush();expect(latest().status).toBe('PAUSED');expect(frames.size).toBe(0);expect(latest().time_seconds).toBe(0);h.destroy();
});

test('hidden_tab_does_not_catch_up',async()=>{
  const h=start();await flush();h.play();frame(500);doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));
  const frozen=latest().time_seconds;now=60000;doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));frame(60500);
  expect(latest().time_seconds).toBe(frozen+0.5);expect(latest().snapshot?.sequence).toBe(1);h.destroy();
});

test.each(['FAILED','INTERRUPTED'] as const)('gaps_and_incomplete_%s',async state=>{
  const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>{const p=new URL(String(input),'http://local').pathname;
    if(p.endsWith('/snapshots'))return Promise.resolve(response({session_id:SID,snapshots:[packet(0,0),packet(1,5),packet(2,10)],next_after_sequence:null}));
    if(p===`/api/history/sessions/${SID}`)return Promise.resolve(response(metadata(10,3,state)));return base(input,init);});
  const h=start();await flush();expect(latest().incomplete).toBe(true);expect(latest().session?.failure_code).toBe('WRITE_FAILED');
  h.play();frame(2000);expect(latest().time_seconds).toBe(2);expect(latest().snapshot?.sequence).toBe(0);expect(latest().gap).toEqual({from:0,to:5});
  frame(10000);expect(latest().status).toBe('ENDED');expect(latest().snapshot?.sequence).toBe(2);expect(latest().time_seconds).toBe(10);expect(frames.size).toBe(0);
  h.play();expect(frames.size).toBe(0);expect(latest().status).toBe('ENDED');h.destroy();
});

test('pause_and_seek_release_tracking_without_repeated_first_focus',async()=>{
  const h=start();await flush();h.trackSelected();expect(latest().trackedVehicleId).toBeNull();h.play();h.trackSelected();
  expect(latest().trackedVehicleId).toBe('TRUCK_001');const before=Cartesian3.clone(f.camera.positionWC);const direction=Cartesian3.clone(f.camera.directionWC);const frustum=f.camera.frustum.clone();
  h.pause();expect(latest().trackedVehicleId).toBeNull();expect(f.camera.positionWC).toEqual(before);expect(f.camera.directionWC).toEqual(direction);expect(f.camera.frustum.equals(frustum)).toBe(true);
  h.play();h.trackSelected();h.seek(5);expect(latest().trackedVehicleId).toBeNull();await flush();expect(latest().status).toBe('PAUSED');expect(focusVehicle).toHaveBeenCalledTimes(1);h.destroy();
});

test('rates_replay_and_invalid_controls_are_atomic',async()=>{
  const h=start();await flush();h.play();frame(1000);h.setRate(2);frame(1500);expect(latest().time_seconds).toBe(2);
  const before=latest();expect(()=>h.setRate(3)).toThrow();expect(()=>h.seek(NaN)).toThrow();expect(()=>h.seek(121)).toThrow();expect(latest()).toBe(before);
  h.seek(120);await flush();expect(latest().status).toBe('ENDED');h.replay();await flush();expect(latest().status).toBe('PLAYING');expect(latest().snapshot?.sequence).toBe(0);expect(latest().time_seconds).toBe(0);h.destroy();
});

test('seek_failure_keeps_last_confirmed_picture',async()=>{
  const base=fetcher.getMockImplementation()!;fetcher.mockImplementation((input,init)=>String(input).includes('/seek')?Promise.resolve(response({},503)):base(input,init));
  const h=start();await flush();const before=latest().snapshot;const entity=f.viewer.entities.getById('TRUCK_001');h.seek(10);await flush();
  expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBe(before);expect(f.viewer.entities.getById('TRUCK_001')).toBe(entity);expect(frames.size).toBe(0);h.destroy();
});

test('active_session_and_http_error_do_not_become_paused',async()=>{
  fetcher.mockResolvedValue(response(metadata(120,121,'RECORDING')));const h=start();await flush();expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBeNull();expect(f.viewer.entities.values).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledTimes(1);h.destroy();
});

test('history_does_not_use_live_source_and_cleanup_ignores_late_http_and_raf',async()=>{
  const socket=vi.fn();vi.stubGlobal('WebSocket',socket);const h=start();await flush();h.play();const late=[...frames.values()][0];
  h.destroy();const count=models.length;late(50000);await flush();expect(models).toHaveLength(count);expect(frames.size).toBe(0);expect(f.viewer.isDestroyed()).toBe(true);
  expect(socket).not.toHaveBeenCalled();expect(fetcher.mock.calls.every(c=>String(c[0]).startsWith('/api/history/'))).toBe(true);h.destroy();expect(f.handle.destroy).toHaveBeenCalledTimes(1);
});
test('pause_cannot_publish_seek_as_confirmed_before_transaction',async()=>{
  const waiting=deferred<Response>();const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>String(input).includes('/seek')?waiting.promise:base(input,init));
  const h=start();await flush();const previous=latest().snapshot;h.seek(10);h.pause();
  expect(latest().status).toBe('LOADING');expect(latest().snapshot).toBe(previous);
  waiting.resolve(response({session_id:SID,target_time_seconds:10,snapshot:packet(10),next_snapshot:packet(11)}));await flush();
  expect(latest().status).toBe('PAUSED');expect(latest().snapshot?.sequence).toBe(10);h.destroy();
});

test('bounded_pages_are_not_downloaded_eagerly',async()=>{
  const h=start();await flush();h.play();await flush();
  expect(fetcher.mock.calls.filter(c=>String(c[0]).includes('/snapshots'))).toHaveLength(2);
  frame(1000);frame(2000);await flush();expect(fetcher.mock.calls.filter(c=>String(c[0]).includes('/snapshots'))).toHaveLength(2);
  frame(60000);await flush();expect(fetcher.mock.calls.filter(c=>String(c[0]).includes('/snapshots'))).toHaveLength(3);
  frame(61000);await flush();expect(fetcher.mock.calls.filter(c=>String(c[0]).includes('/snapshots'))).toHaveLength(3);
  h.destroy();
});

test('rejects_oversized_page_before_presentation_mutation',async()=>{
  const base=fetcher.getMockImplementation()!;const huge=page();
  huge.snapshots.forEach(p=>{p.vehicles=Array.from({length:200},(_,i)=>({...p.vehicles[0],vehicle_id:`TRUCK_${String(i).padStart(3,'0')}`}));});
  expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(2*1024*1024);
  fetcher.mockImplementation((input,init)=>String(input).includes('/snapshots')?Promise.resolve(response(huge)):base(input,init));
  const h=start();await flush();expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBeNull();
  expect(f.viewer.entities.values).toHaveLength(0);expect(latest().renderError).toContain('budget');h.destroy();
});

test('nonfatal_apply_failure_does_not_publish_and_can_seek_again',async()=>{
  const base=fetcher.getMockImplementation()!;fetcher.mockImplementation((input,init)=>{
    if(String(input).includes('/seek')){const t=Number(new URL(String(input),'http://local').searchParams.get('time_seconds'));const p=packet(t);
      if(t===1)p.vehicles.push({...p.vehicles[0],vehicle_id:'TRUCK_004'});
      return Promise.resolve(response({session_id:SID,target_time_seconds:t,snapshot:p,next_snapshot:packet(t+1)}));}return base(input,init);});
  const h=start();await flush();const previous=latest().snapshot;const original=f.viewer.entities.getById('TRUCK_001')!;
  const external=f.viewer.entities.add(new Entity({id:'TRUCK_004'}));h.seek(1);await flush();
  expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBe(previous);expect(latest().time_seconds).toBe(0);
  expect(f.viewer.entities.getById(original.id)).toBe(original);expect(f.viewer.isDestroyed()).toBe(false);
  h.seek(2);await flush();expect(latest().status).toBe('PAUSED');expect(latest().snapshot?.sequence).toBe(2);
  h.destroy();expect(f.viewer.entities.values).toEqual([external]);
});

test.each(['before','after'] as const)('real_dynamic_notification_fatal_%s_visualizer',async order=>{
  let armed=false;let failed=false;let h:ReturnType<typeof start>;
  const listen=()=>f.viewer.entities.collectionChanged.addEventListener((_c,_a,removed)=>{
    if(!armed||failed||!removed.some(e=>e.id==='TRUCK_001'))return;failed=true;h.play();h.seek(99);throw new Error('REAL_REPLAY_DYNAMIC_NOTIFY');
  });
  let remove=order==='before'?listen():()=>{};
  const points=new Map<Entity,{id:Entity}>();const visualizer=new PointVisualizer({getPoint(entity:Entity){const p={id:entity};points.set(entity,p);return p;},
    removePoint(entity:Entity){points.delete(entity);},removeBillboard(){}} as unknown as ConstructorParameters<typeof PointVisualizer>[0],f.viewer.entities);
  if(order==='after')remove=listen();
  const destroy=f.handle.destroy;f.handle.destroy=vi.fn(()=>{visualizer.destroy();points.clear();destroy();});
  const base=fetcher.getMockImplementation()!;fetcher.mockImplementation((input,init)=>{
    if(String(input).includes('/seek')){const p=packet(1);p.vehicles=p.vehicles.filter(v=>v.vehicle_id!=='TRUCK_001');
      return Promise.resolve(response({session_id:SID,target_time_seconds:1,snapshot:p,next_snapshot:packet(2)}));}return base(input,init);});
  let reentered=false;h=start(m=>{if(m.status==='ERROR'){reentered=true;const calls=fetcher.mock.calls.length;h.play();h.seek(2);h.trackSelected();expect(fetcher).toHaveBeenCalledTimes(calls);}});
  await flush();visualizer.update(JulianDate.fromIso8601(STAMP));expect(points.size).toBe(3);const previous=latest().snapshot;
  armed=true;h.seek(1);await flush();expect(failed).toBe(true);expect(reentered).toBe(true);expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBe(previous);
  expect(latest().renderError).toContain('REAL_REPLAY_DYNAMIC_NOTIFY');expect(f.viewer.isDestroyed()).toBe(true);expect(points.size).toBe(0);
  const count=models.length;h.play();h.seek(3);h.destroy();expect(models).toHaveLength(count);remove();
});

test.each(['before','after'] as const)('real_static_notification_fatal_%s_visualizer',async order=>{
  let failed=false;let h:ReturnType<typeof start>;
  const listen=()=>f.viewer.entities.collectionChanged.addEventListener((_c,added)=>{
    if(failed||!added.some(e=>e.id.startsWith('scene:')))return;failed=true;h.play();throw new Error('REAL_REPLAY_STATIC_NOTIFY');
  });
  let remove=order==='before'?listen():()=>{};
  const points=new Map<Entity,{id:Entity}>();const visualizer=new PointVisualizer({getPoint(entity:Entity){const p={id:entity};points.set(entity,p);return p;},
    removePoint(entity:Entity){points.delete(entity);},removeBillboard(){}} as unknown as ConstructorParameters<typeof PointVisualizer>[0],f.viewer.entities);
  if(order==='after')remove=listen();const destroy=f.handle.destroy;f.handle.destroy=vi.fn(()=>{visualizer.destroy();points.clear();destroy();});
  h=start();await flush();expect(failed).toBe(true);expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBeNull();
  expect(f.viewer.isDestroyed()).toBe(true);expect(points.size).toBe(0);const count=models.length;h.seek(1);h.play();h.destroy();expect(models).toHaveLength(count);remove();
});

test('cleanup_reentry_late_http_and_release_errors_are_retained',async()=>{
  const waiting=deferred<Response>();const base=fetcher.getMockImplementation()!;let requestSignal:AbortSignal|undefined;
  fetcher.mockImplementation((input,init)=>{if(String(input).includes('/seek')){requestSignal=init?.signal as AbortSignal;return waiting.promise;}return base(input,init);});
  const h=start();await flush();h.seek(20);const originalRemove=doc.removeEventListener.bind(doc);
  vi.spyOn(doc,'removeEventListener').mockImplementationOnce(()=>{throw new Error('VISIBILITY_CLEANUP');}).mockImplementation(originalRemove);
  const destroy=f.handle.destroy;f.handle.destroy=vi.fn().mockImplementationOnce(()=>{throw new Error('VIEWER_CLEANUP');}).mockImplementation(destroy);
  h.destroy();expect(requestSignal?.aborted).toBe(true);expect(errors.length).toBeGreaterThan(0);
  expect(errors.map(e=>e.message).join(' ')).toContain('release');h.destroy();expect(f.viewer.isDestroyed()).toBe(true);
  const count=models.length;waiting.resolve(response({session_id:SID,target_time_seconds:20,snapshot:packet(20),next_snapshot:packet(21)}));await flush();expect(models).toHaveLength(count);
});

test('synchronous_collection_cleanup_prevents_publication_and_new_lifecycle_is_independent',async()=>{
  let h:ReturnType<typeof start>;let once=false;
  const remove=f.viewer.entities.collectionChanged.addEventListener((_c,added)=>{if(!once&&added.some(e=>e.id.startsWith('scene:'))){once=true;h.destroy();}});
  h=start();await flush();expect(f.viewer.isDestroyed()).toBe(true);expect(latest().snapshot).toBeNull();remove();
  const count=models.length;h.play();h.destroy();expect(models).toHaveLength(count);
  f=viewerFixture();vi.mocked(createViewer).mockReturnValue(f.handle);const second=start();await flush();expect(latest().status).toBe('PAUSED');expect(f.viewer.entities.values).toHaveLength(16);second.destroy();
});

test('creation_callback_failure_releases_late_adopted_presentation',async()=>{
  const h=start(()=>{throw new Error('MODEL_CONSUMER');});await flush();expect(f.viewer.isDestroyed()).toBe(true);expect(fetcher).not.toHaveBeenCalled();expect(errors.length).toBeGreaterThan(0);h.destroy();
});
test('prefetch_rejects_time_regression_across_page_boundary',async()=>{
  const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>{if(String(input).includes('/snapshots')&&!String(input).includes('after_sequence=-1')){
    const p=page(60,119);p.snapshots.forEach((s,i)=>{s.simulation_time_seconds=i+1;});return Promise.resolve(response(p));}return base(input,init);});
  const h=start();await flush();const before=latest().snapshot;h.play();await flush();
  expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBe(before);expect(frames.size).toBe(0);h.destroy();
});

test('oversized_prefetch_failure_is_not_silently_swallowed',async()=>{
  const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>{if(String(input).includes('/snapshots')&&!String(input).includes('after_sequence=-1')){
    const p=page(60,119);p.snapshots.forEach(s=>{s.vehicles=Array.from({length:100},(_,i)=>({...s.vehicles[0],vehicle_id:`TRUCK_${String(i).padStart(3,'0')}`}));});
    return Promise.resolve(response(p));}return base(input,init);});
  const h=start();await flush();const before=latest().snapshot;h.play();await flush();expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBe(before);expect(frames.size).toBe(0);h.destroy();
});

test('pause_cancels_pending_explicit_replay_autoplay',async()=>{
  const waiting=deferred<Response>();const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>String(input).includes('/seek')?waiting.promise:base(input,init));
  const h=start();await flush();h.replay();h.pause();waiting.resolve(response({session_id:SID,target_time_seconds:0,snapshot:packet(0),next_snapshot:packet(1)}));
  await flush();expect(latest().status).toBe('PAUSED');expect(frames.size).toBe(0);h.destroy();
});

test.each([404,409,503])('startup_http_%s_stays_error',async status=>{
  fetcher.mockResolvedValue(response({error:{code:'HISTORY_UNAVAILABLE',message:'Cannot read history'}},status));
  const h=start();await flush();expect(latest().status).toBe('ERROR');expect(latest().snapshot).toBeNull();expect(frames.size).toBe(0);h.destroy();
});
test('error_is_not_cleared_by_pause_or_play',async()=>{
  const base=fetcher.getMockImplementation()!;fetcher.mockImplementation((input,init)=>String(input).includes('/seek')?Promise.resolve(response({},503)):base(input,init));
  const h=start();await flush();h.seek(5);await flush();expect(latest().status).toBe('ERROR');h.pause();h.play();expect(latest().status).toBe('ERROR');expect(frames.size).toBe(0);h.destroy();
});

test('synchronous_model_pause_does_not_recursively_advance',async()=>{
  let h:ReturnType<typeof start>;let requested=false;
  h=start(m=>{if(m.status==='PLAYING'&&m.time_seconds===1){requested=true;h.pause();}});
  await flush();h.play();frame(1000);expect(requested).toBe(true);expect(latest().status).toBe('PAUSED');expect(latest().renderError).toBeNull();expect(f.viewer.isDestroyed()).toBe(false);h.destroy();
});
test('large_frame_buffers_at_committed_cache_boundary_without_evicting_cursor',async()=>{
  const h=start();await flush();h.play();await flush();frame(1000);expect(latest().time_seconds).toBe(1);
  frame(120000);expect(latest().status).toBe('BUFFERING');expect(latest().time_seconds).toBe(119);expect(latest().snapshot?.sequence).toBe(119);
  await flush();expect(latest().status).toBe('PLAYING');frame(120500);expect(latest().time_seconds).toBe(119.5);
  frame(121000);expect(latest().status).toBe('ENDED');expect(latest().snapshot?.sequence).toBe(120);h.destroy();
});

test('raf_request_failure_enters_error_instead_of_unowned_playing',async()=>{
  const h=start();await flush();vi.mocked(requestAnimationFrame).mockImplementationOnce(()=>{throw new Error('RAF_REQUEST');});
  expect(()=>h.play()).not.toThrow();expect(latest().status).toBe('ERROR');expect(latest().renderError).toContain('RAF_REQUEST');expect(frames.size).toBe(0);h.trackSelected();expect(latest().trackedVehicleId).toBeNull();h.destroy();
});

test('raf_request_failure_during_buffer_resume_is_not_swallowed',async()=>{
  const delayed=deferred<Response>();const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input,init)=>String(input).includes('/snapshots')?String(input).includes('after_sequence=-1')?Promise.resolve(response(page(0,0))):delayed.promise:base(input,init));
  const h=start();await flush();h.play();frame(1000);expect(latest().status).toBe('BUFFERING');
  vi.mocked(requestAnimationFrame).mockImplementationOnce(()=>{throw new Error('RAF_RESUME');});now=5000;
  delayed.resolve(response(page(1,60)));await flush();expect(latest().status).toBe('ERROR');expect(latest().renderError).toContain('RAF_RESUME');expect(frames.size).toBe(0);h.destroy();
});

test('cleanup_retries_failed_owned_raf_cancellation',async()=>{
  const h=start();await flush();h.play();const id=[...frames.keys()][0];const cancel=vi.mocked(cancelAnimationFrame);
  cancel.mockImplementationOnce(()=>{throw new Error('CANCEL_FRAME');});
  h.destroy();expect(frames.has(id)).toBe(true);expect(errors.length).toBeGreaterThan(0);expect(f.viewer.isDestroyed()).toBe(true);
  h.destroy();expect(cancel.mock.calls.filter(c=>c[0]===id)).toHaveLength(2);expect(frames.size).toBe(0);expect(f.handle.destroy).toHaveBeenCalledTimes(1);
});