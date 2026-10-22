import { expect, test, vi } from 'vitest';
import { createHistoryClient, HistoryLoadError } from './historyClient';
import { makeFleetSnapshotFixture } from '../realtime/fleetFixtures';
import { makeSceneInput } from '../scene/sceneFixtures';
import { createFleetSnapshotGate, parseFleetSnapshot } from '../realtime/fleetTelemetry';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-10-14T04:00:00.000001+00:00';
const signal = () => new AbortController().signal;
function summary() {
  return { session_id: SID, state: 'COMPLETED' as const, started_utc: STAMP,
    ended_utc: '2026-10-14T04:00:02+00:00', snapshot_count: 3, first_sequence: 0 as const,
    last_sequence: 2, first_simulation_time: 0 as const, last_simulation_time: 2,
    incomplete: false, failure_code: null, failure_message: null };
}
function detail() {
  return { ...summary(), storage_version: 1, fleet_schema_version: 1, code_revision: 'a'.repeat(40),
    scene_sha256: 'b'.repeat(64), config_sha256: 'c'.repeat(64),
    vehicle_configs: [1,2,3].map(i => ({vehicle_id: `TRUCK_00${i}`, route_id: 'ROUTE_001',
      initial_progress_fraction: (i-1)/3, cruise_speed_kmh: 25, initial_soc: 100-i*10,
      load: 65, soc_rate: 0.1, parking: i===1 ? null : {
        period_seconds: 120, start_seconds: i===2 ? 60:90, duration_seconds: i===2 ? 15:20,
      }})) };
}
function snapshot(seq: number, time=seq) {
  return { ...makeFleetSnapshotFixture(), sequence: seq, simulation_time_seconds: time };
}
function page() {
  return {session_id:SID, snapshots:[snapshot(0),snapshot(1),snapshot(2)], next_after_sequence:null};
}
function wire(body: unknown, status=200): Response {
  return {ok:status>=200&&status<300,status,json:async()=>body} as Response;
}
function clientFor(body: unknown, status=200) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(wire(body,status));
  return { client:createHistoryClient({fetchImpl}), fetchImpl };
}

test('accepts_terminal_metadata_and_valid_page', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(wire(detail())).mockResolvedValueOnce(wire(page()));
  const client = createHistoryClient({fetchImpl});
  const metadata = await client.getSession({sessionId:SID,signal:signal()});
  expect(metadata).toEqual(detail());
  const value = await client.getSnapshots({session:metadata,signal:signal()});
  expect(value).toEqual(page());
  expect(fetchImpl.mock.calls[0][0]).toBe(`/api/history/sessions/${SID}`);
  expect(String(fetchImpl.mock.calls[1][0])).toContain(`/sessions/${SID}/snapshots`);
});

async function schema(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({name:'HistoryLoadError',code:'SCHEMA'});
}
function cursorFor(value=summary()) {
  return Buffer.from(JSON.stringify({started_utc:value.started_utc,session_id:value.session_id})).toString('base64url');
}

test.each(['COMPLETED','FAILED','INTERRUPTED','RECORDING'] as const)('accepts state %s and preserves diagnostics', async state => {
  const raw = {...detail(),state,ended_utc:state==='RECORDING'?null:detail().ended_utc,
    incomplete:state==='FAILED'||state==='INTERRUPTED',
    failure_code:state==='FAILED'||state==='INTERRUPTED'?'WRITE_FAILED':null,
    failure_message:state==='FAILED'||state==='INTERRUPTED'?'Recorded prefix only':null};
  const {client} = clientFor(raw);
  expect(await client.getSession({sessionId:SID,signal:signal()})).toEqual(raw);
});

test.each([
  ['session_id',OTHER],['state','STOPPED'],['started_utc','2026-02-30T00:00:00Z'],
  ['ended_utc',null],['snapshot_count',2],['snapshot_count',NaN],['snapshot_count',Infinity],
  ['snapshot_count',true],['snapshot_count',9007199254740992],['first_sequence',1],
  ['last_sequence',-1],['last_sequence',1.5],['first_simulation_time',1],['last_simulation_time',-1],
  ['last_simulation_time',NaN],['incomplete',true],['failure_code','WRITE_FAILED'],['failure_message','unexpected'],
  ['storage_version',2],['fleet_schema_version',true],['code_revision','A'.repeat(40)],
  ['scene_sha256','b'.repeat(63)],['config_sha256','c'.repeat(64)+'\n'],['extra',1],
] as const)('validates metadata %s', async (key,value) => {
  const {client}=clientFor({...detail(),[key]:value});
  await schema(client.getSession({sessionId:SID,signal:signal()}));
});

test('rejects missing metadata fields and preserves legal UTC rollback', async () => {
  for (const key of Object.keys(detail())) {
    const raw:Record<string,unknown>={...detail()}; delete raw[key];
    await schema(clientFor(raw).client.getSession({sessionId:SID,signal:signal()}));
  }
  const raw={...detail(),ended_utc:'2026-10-13T00:00:00Z',code_revision:null};
  expect(await clientFor(raw).client.getSession({sessionId:SID,signal:signal()})).toEqual(raw);
});

test.each([
  {incomplete:false}, {ended_utc:null}, {failure_code:null}, {failure_code:'bad reason'},
  {failure_message:null},{failure_message:'x'.repeat(513)},
])('validates incomplete session diagnostics %j', async mutation => {
  const raw={...detail(),state:'FAILED',incomplete:true,failure_code:'WRITE_FAILED',failure_message:'Prefix only',...mutation};
  await schema(clientFor(raw).client.getSession({sessionId:SID,signal:signal()}));
});

test.each(['duplicate','speed','soc','fraction','parking','missing','extra'])('validates config %s',async mode=>{
  const raw=detail();
  if(mode==='duplicate')raw.vehicle_configs[1].vehicle_id=raw.vehicle_configs[0].vehicle_id;
  if(mode==='speed')raw.vehicle_configs[0].cruise_speed_kmh=-1;
  if(mode==='soc')raw.vehicle_configs[0].initial_soc=101;
  if(mode==='fraction')raw.vehicle_configs[0].initial_progress_fraction=1;
  if(mode==='parking')raw.vehicle_configs[1].parking!.duration_seconds=Infinity;
  if(mode==='missing')delete (raw.vehicle_configs[0] as Record<string,unknown>).soc_rate;
  if(mode==='extra')Object.assign(raw.vehicle_configs[0],{unknown:1});
  await schema(clientFor(raw).client.getSession({sessionId:SID,signal:signal()}));
});

test('requires compatible TRUCK_001 in recorded configuration',async()=>{
  const raw=detail();
  raw.vehicle_configs=raw.vehicle_configs.filter(config=>config.vehicle_id==='TRUCK_002');
  await expect(clientFor(raw).client.getSession({sessionId:SID,signal:signal()}))
    .rejects.toMatchObject({code:'SCHEMA'});
});
test('lists strict metadata, cursor and per-page identity deduplication',async()=>{
  const raw={sessions:[summary(),summary()],next_cursor:null};
  const {client,fetchImpl}=clientFor(raw);
  const result=await client.listSessions({signal:signal()});
  expect(result).toEqual({sessions:[summary()],next_cursor:null});
  expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/history/sessions');
  const terminal={sessions:[summary()],next_cursor:cursorFor()};
  const next=await clientFor(terminal).client.listSessions({signal:signal(),limit:1});
  expect(next.next_cursor).toBe(cursorFor());
  await schema(clientFor({...terminal,next_cursor:cursorFor({...summary(),session_id:OTHER})}).client
    .listSessions({signal:signal(),limit:1}));
  await schema(clientFor({sessions:[],next_cursor:cursorFor()}).client.listSessions({signal:signal()}));
  await schema(clientFor({sessions:[summary(),{...summary(),snapshot_count:4,last_sequence:3}],next_cursor:null})
    .client.listSessions({signal:signal()}));
});

test('list ordering and request cursor stay consistent',async()=>{
  const newer={...summary(),session_id:OTHER};
  const raw={sessions:[newer,summary()],next_cursor:null};
  expect((await clientFor(raw).client.listSessions({signal:signal()})).sessions).toEqual(raw.sessions);
  await schema(clientFor({sessions:[summary(),newer],next_cursor:null}).client.listSessions({signal:signal()}));
  await schema(clientFor(raw).client.listSessions({signal:signal(),cursor:cursorFor(summary())}));
});

test.each([503,409,404])('rejects_error_as_empty HTTP %s',async status=>{
  const {client,fetchImpl}=clientFor({error:{code:'HISTORY_BUSY',message:'not empty'}},status);
  await expect(client.listSessions({signal:signal()})).rejects.toMatchObject({code:'HTTP',status});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each(['list','detail','scene','page','seek'])('rejects backend error object on 200 %s',async mode=>{
  const {client}=clientFor({error:{code:'HISTORY_CORRUPT',message:'no'}});
  if(mode==='list')await schema(client.listSessions({signal:signal()}));
  if(mode==='detail')await schema(client.getSession({sessionId:SID,signal:signal()}));
  if(mode==='scene')await schema(client.getScene({sessionId:SID,signal:signal()}));
  if(mode==='page')await schema(client.getSnapshots({session:summary(),signal:signal()}));
  if(mode==='seek')await schema(client.seek({session:summary(),timeSeconds:1,signal:signal()}));
});

test.each(['id','duplicate','backwards','gap','range','time','next','early-null','shape','empty'])('binds_page_to_session %s',async mode=>{
  const raw=page() as {session_id:string;snapshots:ReturnType<typeof snapshot>[];next_after_sequence:number|null};
  if(mode==='id')raw.session_id=OTHER;
  if(mode==='duplicate')raw.snapshots[1]=snapshot(0);
  if(mode==='backwards')raw.snapshots.reverse();
  if(mode==='gap')raw.snapshots.splice(1,1);
  if(mode==='range')raw.snapshots.push(snapshot(3));
  if(mode==='time')raw.snapshots[1]=snapshot(1,3);
  if(mode==='next')raw.next_after_sequence=2;
  if(mode==='early-null')raw.snapshots.pop();
  if(mode==='shape')Object.assign(raw,{unexpected:true});
  if(mode==='empty')raw.snapshots=[];
  await schema(clientFor(raw).client.getSnapshots({session:summary(),signal:signal()}));
});

test('snapshot parser remains strict and pages obey cursor and metadata',async()=>{
  const raw=page(); raw.snapshots[1].session_id=OTHER;
  await schema(clientFor(raw).client.getSnapshots({session:summary(),signal:signal()}));
  raw.snapshots[1]=snapshot(1);
  Object.assign(raw.snapshots[1].vehicles[0],{extra:1});
  await schema(clientFor(raw).client.getSnapshots({session:summary(),signal:signal()}));
  const partial={session_id:SID,snapshots:[snapshot(1)],next_after_sequence:1};
  expect(await clientFor(partial).client.getSnapshots({session:summary(),afterSequence:0,limit:1,signal:signal()})).toEqual(partial);
  await schema(clientFor(partial).client.getSnapshots({session:summary(),afterSequence:1,signal:signal()}));
  expect(await clientFor({session_id:SID,snapshots:[],next_after_sequence:null}).client
    .getSnapshots({session:summary(),afterSequence:2,signal:signal()})).toEqual({session_id:SID,snapshots:[],next_after_sequence:null});
});

function seekBody(time=1) {
  return {session_id:SID,target_time_seconds:time,snapshot:snapshot(time),next_snapshot:time===2?null:snapshot(time+1)};
}

test('validates seek floor, gaps, boundaries and reverse seek without realtime gate',async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(wire(seekBody(2))).mockResolvedValueOnce(wire(seekBody(0)));
  const client=createHistoryClient({fetchImpl});
  const gate=createFleetSnapshotGate(); expect(gate.accept(parseFleetSnapshot(snapshot(2))!)).toBe(true);
  expect((await client.seek({session:summary(),timeSeconds:2,signal:signal()})).snapshot.sequence).toBe(2);
  const result=await client.seek({session:summary(),timeSeconds:0,signal:signal()});
  expect(result.snapshot.sequence).toBe(0);
  expect(gate.accept(result.snapshot)).toBe(false);
  expect(gate.accept(parseFleetSnapshot(snapshot(3))!)).toBe(true);
  const gap={session_id:SID,target_time_seconds:0.5,snapshot:snapshot(0),next_snapshot:snapshot(1)};
  expect(await clientFor(gap).client.seek({session:summary(),timeSeconds:0.5,signal:signal()})).toEqual(gap);
});

test.each(['id','target','floor','missing-next','next-id','next-seq','next-time','out-of-range'])('rejects malformed seek %s',async mode=>{
  const raw=seekBody();
  if(mode==='id')raw.session_id=OTHER;
  if(mode==='target')raw.target_time_seconds=0.5;
  if(mode==='floor')raw.snapshot=snapshot(2);
  if(mode==='missing-next')raw.next_snapshot=null;
  if(mode==='next-id')raw.next_snapshot!.session_id=OTHER;
  if(mode==='next-seq')raw.next_snapshot=snapshot(1);
  if(mode==='next-time')raw.next_snapshot=snapshot(2,1);
  if(mode==='out-of-range')raw.next_snapshot=snapshot(3);
  await schema(clientFor(raw).client.seek({session:summary(),timeSeconds:1,signal:signal()}));
});

test('validates scene through original parser',async()=>{
  const raw=makeSceneInput();
  expect(await clientFor(raw).client.getScene({sessionId:SID,signal:signal()})).toEqual(raw);
  await schema(clientFor({...raw as object,features:{type:'FeatureCollection',features:[]}}).client.getScene({sessionId:SID,signal:signal()}));
});

test.each([0,201,1.5,NaN,Infinity,true,'1'])('rejects invalid limit %s before fetch',async limit=>{
  const {client,fetchImpl}=clientFor(page());
  await schema(client.getSnapshots({session:summary(),signal:signal(),limit:limit as number}));
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([-2,9007199254740992,NaN,Infinity,true,'0'])('rejects invalid afterSequence %s',async afterSequence=>{
  const {client,fetchImpl}=clientFor(page());
  await schema(client.getSnapshots({session:summary(),signal:signal(),afterSequence:afterSequence as number}));
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([-1,3,NaN,Infinity,true,'1'])('rejects invalid seek time %s',async timeSeconds=>{
  const {client,fetchImpl}=clientFor(seekBody());
  await schema(client.seek({session:summary(),signal:signal(),timeSeconds:timeSeconds as number}));
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(['bad','a'.repeat(257),'',Buffer.from('{"session_id":"'+SID+'","session_id":"'+SID+'","started_utc":"'+STAMP+'"}').toString('base64url')])('rejects malformed cursor',async cursor=>{
  const {client,fetchImpl}=clientFor({sessions:[],next_cursor:null});
  await schema(client.listSessions({signal:signal(),cursor}));
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('rejects invalid UUID and known active context before playback fetch',async()=>{
  const {client,fetchImpl}=clientFor(detail());
  await schema(client.getSession({sessionId:SID+'\n',signal:signal()}));
  await schema(client.getScene({sessionId:'../../other',signal:signal()}));
  await schema(client.getSnapshots({session:{...summary(),state:'RECORDING',ended_utc:null},signal:signal()}));
  expect(fetchImpl).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('distinguishes NETWORK JSON and HTTP, retaining causes',async()=>{
  const network=new Error('socket');
  const fetchImpl=vi.fn<typeof fetch>().mockRejectedValue(network);
  await expect(createHistoryClient({fetchImpl}).getSession({sessionId:SID,signal:signal()}))
    .rejects.toMatchObject({code:'NETWORK',cause:network});
  const malformed=new SyntaxError('invalid json');
  const json=vi.fn().mockRejectedValue(malformed);
  const read=vi.fn<typeof fetch>().mockResolvedValue({ok:true,status:200,json} as unknown as Response);
  await expect(createHistoryClient({fetchImpl:read}).getSession({sessionId:SID,signal:signal()}))
    .rejects.toMatchObject({code:'JSON',cause:malformed});
  json.mockClear();
  read.mockResolvedValue({ok:false,status:503,json} as unknown as Response);
  await expect(createHistoryClient({fetchImpl:read}).getSession({sessionId:SID,signal:signal()}))
    .rejects.toMatchObject({code:'HTTP',status:503});
  expect(json).not.toHaveBeenCalled();
});

test('abort before fetch preserves exact reason and does not issue a request',async()=>{
  const controller=new AbortController(),reason=new Error('user cancelled');
  controller.abort(reason);
  const {client,fetchImpl}=clientFor(detail());
  await expect(client.getSession({sessionId:SID,signal:controller.signal})).rejects.toBe(reason);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(['fetch-resolve','fetch-reject','json-resolve','json-reject'] as const)('preserves_abort at %s boundary',async phase=>{
  const controller=new AbortController(),reason={cancelled:true};
  const fetchDone=deferred<Response>(),jsonDone=deferred<unknown>(),jsonEntered=deferred<void>();
  const response={ok:true,status:200,json:()=>{jsonEntered.resolve();return jsonDone.promise;}} as Response;
  const fetchImpl=vi.fn<typeof fetch>().mockReturnValue(fetchDone.promise);
  const pending=createHistoryClient({fetchImpl}).getSession({sessionId:SID,signal:controller.signal});
  const rejected=expect(pending).rejects.toBe(reason);
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({signal:controller.signal,cache:'no-store'});
  if(phase.startsWith('json')) {fetchDone.resolve(response);await jsonEntered.promise;}
  controller.abort(reason);
  if(phase==='fetch-resolve')fetchDone.resolve(response);
  if(phase==='fetch-reject')fetchDone.reject(new Error('network after cancel'));
  if(phase==='json-resolve')jsonDone.resolve(detail());
  if(phase==='json-reject')jsonDone.reject(new SyntaxError('body after cancel'));
  await rejected;
});

test('checks cancellation immediately after JSON resolution and after synchronous parsing',async()=>{
  const a=new AbortController(),body=deferred<unknown>(),entered=deferred<void>();
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue({ok:true,status:200,
    json:()=>{entered.resolve();return body.promise;}} as Response);
  const pending=createHistoryClient({fetchImpl}).getSession({sessionId:SID,signal:a.signal});
  const reason=new DOMException('cancel','AbortError');
  const rejection=expect(pending).rejects.toBe(reason);
  await entered.promise;body.resolve(detail());a.abort(reason);await rejection;
  const b=new AbortController(),raw=detail();
  Object.defineProperty(raw,'storage_version',{enumerable:true,get(){b.abort(reason);return 1;}});
  await expect(clientFor(raw).client.getSession({sessionId:SID,signal:b.signal})).rejects.toBe(reason);
});

test('native AbortError and local parser/consumer errors keep their classification',async()=>{
  const aborted=new DOMException('native abort','AbortError');
  const fetchImpl=vi.fn<typeof fetch>().mockRejectedValue(aborted);
  await expect(createHistoryClient({fetchImpl}).getSession({sessionId:SID,signal:signal()})).rejects.toBe(aborted);
  const raw=detail(),local=new Error('local getter boundary');
  Object.defineProperty(raw,'storage_version',{enumerable:true,get(){throw local;}});
  await expect(clientFor(raw).client.getSession({sessionId:SID,signal:signal()})).rejects.toBe(local);
  await expect(clientFor(detail()).client.getSession({sessionId:SID,signal:signal()}).then(()=>{throw local;})).rejects.toBe(local);
});

test('all results are detached and deeply frozen, with no retained response cache',async()=>{
  const raw=detail(),{client}=clientFor(raw);
  const result=await client.getSession({sessionId:SID,signal:signal()});
  raw.vehicle_configs[0].load=99;
  expect(result.vehicle_configs[0].load).toBe(65);
  expect(Reflect.set(result.vehicle_configs[0],'load',1)).toBe(false);
  expect(Object.isFrozen(result.vehicle_configs)).toBe(true);
  expect(Object.isFrozen(result.vehicle_configs[1].parking)).toBe(true);
  const next=await client.getSession({sessionId:SID,signal:signal()});
  expect(next.vehicle_configs[0].load).toBe(99);
  expect(next).not.toBe(result);
  const pageRaw=page(),returned=await clientFor(pageRaw).client.getSnapshots({session:summary(),signal:signal()});
  pageRaw.snapshots[0].vehicles[0].soc=0;
  expect(returned.snapshots[0].vehicles[0].soc).toBe(90);
  expect(Object.isFrozen(returned.snapshots)).toBe(true);
  const sceneRaw=makeSceneInput() as {features:{features:unknown[]}};
  const scene=await clientFor(sceneRaw).client.getScene({sessionId:SID,signal:signal()});
  sceneRaw.features.features.pop();
  expect(scene.features.features).toHaveLength(21);
  expect(Object.isFrozen(scene.features.features[0].geometry.coordinates)).toBe(true);
  const listed=await clientFor({sessions:[summary()],next_cursor:null}).client.listSessions({signal:signal()});
  expect(Object.isFrozen(listed.sessions[0])).toBe(true);
  const seek=await clientFor(seekBody()).client.seek({session:summary(),timeSeconds:1,signal:signal()});
  expect(Object.isFrozen(seek.next_snapshot!.vehicles)).toBe(true);
});

test('captures request metadata before await without modifying the caller or hidden state',async()=>{
  const context=summary(),done=deferred<Response>();
  const fetchImpl=vi.fn<typeof fetch>().mockReturnValue(done.promise);
  const pending=createHistoryClient({fetchImpl}).getSnapshots({session:context,signal:signal()});
  context.session_id=OTHER;context.last_sequence=99;context.last_simulation_time=99;
  done.resolve(wire(page()));
  expect((await pending).session_id).toBe(SID);
});

test('readonly zero-duration sessions and sole public methods remain bounded',async()=>{
  const session={...summary(),snapshot_count:1,last_sequence:0,last_simulation_time:0};
  expect(await clientFor({session_id:SID,snapshots:[snapshot(0)],next_after_sequence:null}).client
    .getSnapshots({session,signal:signal()})).toEqual({session_id:SID,snapshots:[snapshot(0)],next_after_sequence:null});
  const result=await clientFor({session_id:SID,target_time_seconds:0,snapshot:snapshot(0),next_snapshot:null})
    .client.seek({session,timeSeconds:0,signal:signal()});
  expect(result.snapshot.sequence).toBe(0);
  expect(Object.keys(createHistoryClient()).sort()).toEqual(['getScene','getSession','getSnapshots','listSessions','seek']);
});

test.each(['',' https://example.test/api/history','//other/api/history','ftp://other/history',
  'https://name:password@other/history','/api/history?query=yes','/api/history#fragment','https:other/history'])
  ('rejects invalid base URL %s',baseUrl=>{
    expect(()=>createHistoryClient({baseUrl})).toThrow(HistoryLoadError);
  });

test('configured URL is normalized and network implementation captured without another hardcoded origin',async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(wire(detail()));
  const options={baseUrl:'/custom/history/',fetchImpl};
  const client=createHistoryClient(options);
  options.baseUrl='/wrong';options.fetchImpl=vi.fn();
  await client.getSession({sessionId:SID,signal:signal()});
  expect(fetchImpl.mock.calls[0][0]).toBe(`/custom/history/sessions/${SID}`);
});

test('diagnostic text length follows Unicode characters, not UTF16 code units',async()=>{
  const raw={...detail(),state:'FAILED',incomplete:true,failure_code:'WRITE_FAILED',failure_message:'🚚'.repeat(512)};
  expect((await clientFor(raw).client.getSession({sessionId:SID,signal:signal()})).failure_message).toBe(raw.failure_message);
  await schema(clientFor({...raw,failure_message:'🚚'.repeat(513)}).client.getSession({sessionId:SID,signal:signal()}));
});

test('cursor preserves UTF8 JSON rules instead of silently stripping a BOM',async()=>{
  const cursor=Buffer.from('\uFEFF'+JSON.stringify({started_utc:STAMP,session_id:SID})).toString('base64url');
  const {client,fetchImpl}=clientFor({sessions:[],next_cursor:null});
  await schema(client.listSessions({signal:signal(),cursor}));
  expect(fetchImpl).not.toHaveBeenCalled();
});
