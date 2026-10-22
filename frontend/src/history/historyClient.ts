import { parseFleetSnapshot, type FleetSnapshot } from '../realtime/fleetTelemetry';
import { parseMineScene, type MineScene } from '../scene/sceneClient';
import { isFiniteNumber, isValidUtcTimestamp } from '../realtime/telemetryGuards';

type ReadonlyDeep<T> = T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export interface SessionSummary {
  readonly session_id: string;
  readonly state: 'RECORDING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  readonly started_utc: string;
  readonly ended_utc: string | null;
  readonly snapshot_count: number;
  readonly first_sequence: 0;
  readonly last_sequence: number;
  readonly first_simulation_time: 0;
  readonly last_simulation_time: number;
  readonly incomplete: boolean;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
}
type VehicleConfig = Readonly<{
  vehicle_id: string; route_id: 'ROUTE_001'; initial_progress_fraction: number;
  cruise_speed_kmh: number; initial_soc: number; load: number; soc_rate: number;
  parking: Readonly<{period_seconds:number;start_seconds:number;duration_seconds:number}> | null;
}>;
export interface SessionDetail extends SessionSummary {
  readonly storage_version: 1;
  readonly fleet_schema_version: 1;
  readonly code_revision: string | null;
  readonly scene_sha256: string;
  readonly config_sha256: string;
  readonly vehicle_configs: readonly VehicleConfig[];
}
export interface SnapshotPage {
  readonly session_id: string;
  readonly snapshots: readonly FleetSnapshot[];
  readonly next_after_sequence: number | null;
}
export interface SeekResult {
  readonly session_id: string;
  readonly target_time_seconds: number;
  readonly snapshot: FleetSnapshot;
  readonly next_snapshot: FleetSnapshot | null;
}
export interface HistoryStatus {
  readonly enabled: boolean;
  readonly state: 'DISABLED_CONFIG'|'STARTING'|'RECORDING'|'STOPPING'|'COMPLETED'|'FAILED';
  readonly session_id: string | null;
  readonly last_offered_sequence: number | null;
  readonly last_persisted_sequence: number | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
}
export class HistoryLoadError extends Error {
  constructor(readonly code:'NETWORK'|'HTTP'|'JSON'|'SCHEMA', message:string,
    options:{status?:number;cause?:unknown}={}) {
    super(message,{cause:options.cause});
    this.name='HistoryLoadError'; this.status=options.status;
  }
  readonly status?:number;
}
type SessionRequest = {sessionId:string;signal:AbortSignal};
type PageRequest = {session:SessionSummary;signal:AbortSignal;afterSequence?:number;limit?:number};


const summaryKeys = ['session_id','state','started_utc','ended_utc','snapshot_count',
  'first_sequence','last_sequence','first_simulation_time','last_simulation_time',
  'incomplete','failure_code','failure_message'] as const;
const detailKeys = [...summaryKeys,'storage_version','fleet_schema_version','code_revision',
  'scene_sha256','config_sha256','vehicle_configs'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX = Number.MAX_SAFE_INTEGER;
function schema(condition: unknown): asserts condition {
  if (!condition) throw new HistoryLoadError('SCHEMA','Invalid history contract');
}
function full(value: unknown, pattern: RegExp): value is string {
  return typeof value==='string' && pattern.exec(value)?.[0].length===value.length;
}
function exact(input: unknown, keys: readonly string[]): Record<string,unknown> {
  schema(typeof input==='object' && input!==null && !Array.isArray(input));
  schema(Reflect.ownKeys(input).length===keys.length && keys.every(key=>Object.hasOwn(input,key)));
  // Capture fields once, detach before validation; no reference to a mutable wire object remains.
  return Object.fromEntries(keys.map(key=>[key,(input as Record<string,unknown>)[key]]));
}
function integer(value: unknown, low: number, high=MAX): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value>=low && value<=high;
}
function freeze<T>(value:T): ReadonlyDeep<T> {
  if (typeof value==='object' && value!==null && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as ReadonlyDeep<T>;
}
function parseSummary(input: unknown): SessionSummary {
  const v=exact(input,summaryKeys);
  schema(full(v.session_id,uuid) && ['RECORDING','COMPLETED','FAILED','INTERRUPTED'].includes(v.state as string));
  schema(isValidUtcTimestamp(v.started_utc) && typeof v.incomplete==='boolean');
  schema(integer(v.snapshot_count,1) && integer(v.last_sequence,0)
    && v.snapshot_count===v.last_sequence+1 && v.first_sequence===0 && v.first_simulation_time===0);
  schema(isFiniteNumber(v.last_simulation_time) && (v.last_sequence===0
    ? v.last_simulation_time===0 : v.last_simulation_time>0));
  const incomplete=v.state==='FAILED'||v.state==='INTERRUPTED';
  schema(v.incomplete===incomplete && (v.state==='RECORDING' ? v.ended_utc===null : isValidUtcTimestamp(v.ended_utc)));
  if (incomplete) schema(full(v.failure_code,/^[A-Z][A-Z0-9_]{0,63}$/)
    && typeof v.failure_message==='string' && v.failure_message.length>0 && Array.from(v.failure_message).length<=512);
  else schema(v.failure_code===null && v.failure_message===null);
  return freeze(v) as unknown as SessionSummary;
}
function parseConfig(input:unknown): VehicleConfig {
  const v=exact(input,['vehicle_id','route_id','initial_progress_fraction','cruise_speed_kmh',
    'initial_soc','load','soc_rate','parking']);
  schema(full(v.vehicle_id,/^TRUCK_[0-9]{3}$/) && v.route_id==='ROUTE_001');
  schema(isFiniteNumber(v.initial_progress_fraction) && v.initial_progress_fraction>=0 && v.initial_progress_fraction<1
    && isFiniteNumber(v.cruise_speed_kmh) && v.cruise_speed_kmh>=0
    && isFiniteNumber(v.initial_soc) && v.initial_soc>=0 && v.initial_soc<=100
    && isFiniteNumber(v.load) && isFiniteNumber(v.soc_rate) && v.soc_rate>=0);
  if (v.parking!==null) {
    const park=exact(v.parking,['period_seconds','start_seconds','duration_seconds']);
    schema(isFiniteNumber(park.period_seconds) && park.period_seconds>0
      && isFiniteNumber(park.start_seconds) && park.start_seconds>=0
      && isFiniteNumber(park.duration_seconds) && park.duration_seconds>0
      && park.start_seconds+park.duration_seconds<=park.period_seconds);
    v.parking=park;
  }
  return freeze(v) as unknown as VehicleConfig;
}
function parseDetail(input:unknown, sessionId:string):SessionDetail {
  const v=exact(input,detailKeys);
  const summary=parseSummary(Object.fromEntries(summaryKeys.map(key=>[key,v[key]])));
  schema(summary.session_id===sessionId && v.storage_version===1 && v.fleet_schema_version===1
    && (v.code_revision===null || full(v.code_revision,/^[0-9a-f]{40}$/))
    && full(v.scene_sha256,/^[0-9a-f]{64}$/) && full(v.config_sha256,/^[0-9a-f]{64}$/));
  schema(Array.isArray(v.vehicle_configs) && v.vehicle_configs.length>0 && v.vehicle_configs.length<=100);
  const configs=v.vehicle_configs.map(parseConfig);
  schema(new Set(configs.map(c=>c.vehicle_id)).size===configs.length
    && configs.some(config=>config.vehicle_id==='TRUCK_001'));
  return freeze({...summary,storage_version:1,fleet_schema_version:1,
    code_revision:v.code_revision,scene_sha256:v.scene_sha256,config_sha256:v.config_sha256,
    vehicle_configs:configs}) as SessionDetail;
}
function sessionContext(input:SessionSummary):SessionSummary {
  // SessionDetail is a structural subtype; wire response parsing still enforces exact keys.
  schema(typeof input==='object' && input!==null);
  const summary=parseSummary(Object.fromEntries(summaryKeys.map(key=>[key,input[key]])));
  schema(summary.state!=='RECORDING');
  return summary;
}
type Cursor = Readonly<{started_utc:string;session_id:string}>;
function parseCursor(value:unknown):Cursor {
  schema(full(value,/^[A-Za-z0-9_-]+$/) && value.length<=256);
  try {
    const decoded=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
    schema(btoa(decoded).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')===value);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Uint8Array.from(decoded,c=>c.charCodeAt(0)));
    const v=exact(JSON.parse(text),['started_utc','session_id']);
    schema(isValidUtcTimestamp(v.started_utc) && full(v.session_id,uuid));
    // A valid cursor is a flat two-string object. Count lexical keys to reject JSON duplicates.
    schema((text.match(/"(?:\\[\s\S]|[^"\\])*"\s*:/g) ?? []).length===2);
    return freeze({started_utc:v.started_utc,session_id:v.session_id});
  } catch (cause) {
    if (cause instanceof HistoryLoadError) throw cause;
    throw new HistoryLoadError('SCHEMA','Invalid history cursor',{cause});
  }
}
function compareKeys(a:Cursor,b:Cursor):number {
  for (const key of ['started_utc','session_id'] as const) {
    if (a[key]!==b[key]) return a[key]<b[key] ? -1:1;
  }
  return 0;
}
function parseList(input:unknown,limit:number,cursor:Cursor|null) {
  const v=exact(input,['sessions','next_cursor']);
  schema(Array.isArray(v.sessions) && v.sessions.length<=limit);
  const sessions:SessionSummary[]=[], identities=new Map<string,SessionSummary>();
  let previous:SessionSummary|null=null;
  for (const raw of v.sessions) {
    const next=parseSummary(raw);
    schema((cursor===null || compareKeys(next,cursor)<0) && (previous===null || compareKeys(previous,next)>=0));
    const old=identities.get(next.session_id);
    if (old) schema(summaryKeys.every(key=>old[key]===next[key]));
    else {sessions.push(next); identities.set(next.session_id,next);}
    previous=next;
  }
  if (v.next_cursor!==null) {
    const next=parseCursor(v.next_cursor);
    schema(v.sessions.length===limit && previous!==null && compareKeys(next,previous)===0);
  }
  return freeze({sessions,next_cursor:v.next_cursor as string|null});
}
function contextualSnapshot(input:unknown,session:SessionSummary):FleetSnapshot {
  const value=parseFleetSnapshot(input);
  schema(value!==null && value.session_id===session.session_id && value.sequence<=session.last_sequence
    && value.simulation_time_seconds>=session.first_simulation_time
    && value.simulation_time_seconds<=session.last_simulation_time);
  schema(value.sequence===0 ? value.simulation_time_seconds===0
    : value.sequence===session.last_sequence ? value.simulation_time_seconds===session.last_simulation_time
    : value.simulation_time_seconds<session.last_simulation_time);
  return value;
}
function parsePage(input:unknown,session:SessionSummary,after:number,limit:number):SnapshotPage {
  const v=exact(input,['session_id','snapshots','next_after_sequence']);
  schema(v.session_id===session.session_id && Array.isArray(v.snapshots) && v.snapshots.length<=limit);
  const snapshots=v.snapshots.map(value=>contextualSnapshot(value,session));
  snapshots.forEach((value,index)=>{
    schema(value.sequence===after+index+1 && (index===0 || value.simulation_time_seconds>snapshots[index-1].simulation_time_seconds));
  });
  if (snapshots.length===0) schema(after>=session.last_sequence && v.next_after_sequence===null);
  else {
    const last=snapshots[snapshots.length-1];
    schema(last.sequence<session.last_sequence ? v.next_after_sequence===last.sequence : v.next_after_sequence===null);
  }
  return freeze({session_id:session.session_id,snapshots,next_after_sequence:v.next_after_sequence as number|null});
}
function parseSeek(input:unknown,session:SessionSummary,target:number):SeekResult {
  const v=exact(input,['session_id','target_time_seconds','snapshot','next_snapshot']);
  schema(v.session_id===session.session_id && isFiniteNumber(v.target_time_seconds) && v.target_time_seconds===target);
  const current=contextualSnapshot(v.snapshot,session);
  schema(current.simulation_time_seconds<=target);
  let next:FleetSnapshot|null=null;
  if (v.next_snapshot===null) schema(current.sequence===session.last_sequence);
  else {
    next=contextualSnapshot(v.next_snapshot,session);
    schema(next.sequence===current.sequence+1 && next.simulation_time_seconds>target
      && next.simulation_time_seconds>current.simulation_time_seconds);
  }
  return freeze({session_id:session.session_id,target_time_seconds:target,snapshot:current,next_snapshot:next});
}
function baseUrl(value:string):string {
  schema(typeof value==='string' && value.length>0 && value.trim()===value && !/[\s?#\\]/.test(value));
  if (value.startsWith('/')) schema(!value.startsWith('//'));
  else {
    let url:URL;
    try {url=new URL(value);} catch {throw new HistoryLoadError('SCHEMA','Invalid history base URL');}
    schema(/^https?:\/\//i.test(value) && (url.protocol==='http:'||url.protocol==='https:') && !url.username && !url.password);
  }
  return value.replace(/\/+$/,'');
}
function cancellation(signal:AbortSignal,cause:unknown):void {
  signal.throwIfAborted();
  if (typeof cause==='object' && cause!==null && 'name' in cause && cause.name==='AbortError') throw cause;
}

/** Stateless HTTP reader. Pages/seek take metadata explicitly, never a realtime gate or hidden cache. */
export function createHistoryClient(options:{baseUrl?:string;fetchImpl?:typeof fetch}={}) {
  const base=baseUrl(options.baseUrl ?? '/api/history'), fetcher=options.fetchImpl ?? fetch;
  async function request<T>(path:string,signal:AbortSignal,parse:(input:unknown)=>T):Promise<T> {
    signal.throwIfAborted();
    let response:Response;
    try {response=await fetcher(base+path,{signal,cache:'no-store'});}
    catch(cause) {cancellation(signal,cause);throw new HistoryLoadError('NETWORK','Unable to fetch history',{cause});}
    signal.throwIfAborted();
    if (!response.ok) throw new HistoryLoadError('HTTP',`History request failed: HTTP ${response.status}`,{status:response.status});
    let input:unknown;
    try {input=await response.json();}
    catch(cause) {cancellation(signal,cause);throw new HistoryLoadError('JSON','Unable to decode history JSON',{cause});}
    signal.throwIfAborted();
    try {return parse(input);} finally {signal.throwIfAborted();}
  }
  return {
    async listSessions({signal,limit=60,cursor}: {signal:AbortSignal;limit?:number;cursor?:string|null}) {
      signal.throwIfAborted();schema(integer(limit,1,200));
      const key=cursor===undefined||cursor===null ? null:parseCursor(cursor);
      const params=new URLSearchParams({limit:String(limit)});
      if (key!==null) params.set('cursor',cursor!);
      return request('/sessions?'+params,signal,input=>parseList(input,limit,key));
    },
    async getSession({sessionId,signal}:SessionRequest):Promise<SessionDetail> {
      signal.throwIfAborted();schema(full(sessionId,uuid));
      return request(`/sessions/${sessionId}`,signal,input=>parseDetail(input,sessionId));
    },
    async getScene({sessionId,signal}:SessionRequest):Promise<ReadonlyDeep<MineScene>> {
      signal.throwIfAborted();schema(full(sessionId,uuid));
      return request(`/sessions/${sessionId}/scene`,signal,input=>{
        const scene=parseMineScene(input);schema(scene!==null);return freeze(scene);
      });
    },
    async getSnapshots({session:input,signal,afterSequence=-1,limit=60}:PageRequest):Promise<SnapshotPage> {
      signal.throwIfAborted();const session=sessionContext(input);
      schema(integer(afterSequence,-1) && integer(limit,1,200));
      const params=new URLSearchParams({after_sequence:String(afterSequence),limit:String(limit)});
      return request(`/sessions/${session.session_id}/snapshots?`+params,signal,
        value=>parsePage(value,session,afterSequence,limit));
    },
    async seek({session:input,signal,timeSeconds}:{session:SessionSummary;signal:AbortSignal;timeSeconds:number}):Promise<SeekResult> {
      signal.throwIfAborted();const session=sessionContext(input);
      schema(isFiniteNumber(timeSeconds) && timeSeconds>=session.first_simulation_time && timeSeconds<=session.last_simulation_time);
      return request(`/sessions/${session.session_id}/seek?`+new URLSearchParams({time_seconds:String(timeSeconds)}),
        signal,value=>parseSeek(value,session,timeSeconds));
    },
  };
}
