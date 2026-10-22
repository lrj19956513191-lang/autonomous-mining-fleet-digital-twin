import { expect, test } from 'vitest';
import { parseMineScene, loadMineScene, SceneLoadError } from './sceneClient';
import { makeSceneInput } from './sceneFixtures';

test('parses_valid_scene', () => {
  const input = makeSceneInput();
  const scene = parseMineScene(input);
  expect(scene).not.toBeNull();
  expect(scene).toEqual(input);
  expect(scene).not.toBe(input);
  expect(scene?.features.features).toHaveLength(21);
  expect(scene?.features.features.filter(f => f.properties.kind === 'road_node')).toHaveLength(8);
  expect(scene?.features.features.filter(f => f.properties.kind === 'road_edge')).toHaveLength(9);
  expect(scene?.features.features.filter(f => f.geometry.type === 'Polygon')).toHaveLength(4);
  expect(scene?.features.features.map(f => f.id).sort()).toEqual([
    'AREA_DUMPING', 'AREA_FACILITY', 'AREA_LOADING', 'MINE_BOUNDARY',
    'N1','N2','N3','N4','N5','N6','N7','N8',
    'ROAD_001','ROAD_002','ROAD_003','ROAD_004','ROAD_005','ROAD_006','ROAD_007','ROAD_008','ROAD_009',
  ]);
  expect(scene?.features.features.find(f => f.id === 'N1')?.geometry.coordinates).toEqual([116.39,39.9,50]);
  expect(scene?.preset_route).toEqual({ route_id: 'ROUTE_001', segments: [
    {edge_id:'ROAD_001',reverse:false},{edge_id:'ROAD_002',reverse:false},
    {edge_id:'ROAD_003',reverse:false},{edge_id:'ROAD_004',reverse:false},
    {edge_id:'ROAD_005',reverse:false},{edge_id:'ROAD_006',reverse:false},
  ] });
});

type MutableFeature = {type:unknown;id:unknown;geometry:Record<string,unknown>;properties:Record<string,unknown>};
type MutableScene = {schema_version:unknown;mine_id:unknown;features:{type:unknown;features:MutableFeature[]};preset_route:{route_id:unknown;segments:Record<string,unknown>[]}};
function inputScene(): MutableScene { return makeSceneInput() as MutableScene; }
function feature(scene: MutableScene, id: string): MutableFeature {
  const result = scene.features.features.find(f => f.id === id);
  if (!result) throw new Error(`test fixture missing ${id}`);
  return result;
}
function reject(input: unknown) {
  expect(() => parseMineScene(input)).not.toThrow();
  expect(parseMineScene(input)).toBeNull();
}
const envelopeMutations: [string,(s:MutableScene)=>void][] = [
  ['version',s=>{s.schema_version=2;}],['boolean version',s=>{s.schema_version=true;}],
  ['mine',s=>{s.mine_id='OTHER';}],['collection type',s=>{s.features.type='Feature';}],
  ['count',s=>{s.features.features.pop();}],['duplicate id',s=>{s.features.features[1].id='N1';}],
  ['unknown id',s=>{s.features.features[0].id='N9';}],
  ['id-kind binding',s=>{feature(s,'AREA_LOADING').properties.kind='dumping_area';}],
  ['unknown kind',s=>{feature(s,'N1').properties.kind='unknown';}],
  ['feature type',s=>{feature(s,'N1').type='Other';}],
  ['geometry type',s=>{feature(s,'ROAD_001').geometry.type='MultiLineString';}],
  ['route id',s=>{s.preset_route.route_id='ROUTE_002';}],
];
test.each(envelopeMutations)('rejects_invalid_scene_envelope_and_ids %s',(label,mutate)=>{
  const s=inputScene(); mutate(s); reject(s);
});
test.each([
  ['null',null],['array',[]],['boolean',true],['number',42],['string','scene'],['undefined',undefined],
])('rejects_invalid_scene_envelope_and_ids root %s',(_,input)=>reject(input));
const objectSelectors: [string,(s:MutableScene)=>Record<string,unknown>][] = [
  ['root',s=>s as unknown as Record<string,unknown>],
  ['collection',s=>s.features as unknown as Record<string,unknown>],
  ['feature',s=>feature(s,'N1') as unknown as Record<string,unknown>],
  ['geometry',s=>feature(s,'N1').geometry],['node properties',s=>feature(s,'N1').properties],
  ['edge properties',s=>feature(s,'ROAD_001').properties],['area properties',s=>feature(s,'AREA_LOADING').properties],
  ['route',s=>s.preset_route as unknown as Record<string,unknown>],['segment',s=>s.preset_route.segments[0]],
];
for (const [label,select] of objectSelectors) {
  const keys=Object.keys(select(inputScene()));
  for(const key of keys) test(`rejects_invalid_scene_envelope_and_ids missing ${label}.${key}`,()=>{
    const s=inputScene();delete select(s)[key];reject(s);
  });
  test(`rejects_invalid_scene_envelope_and_ids extra ${label}`,()=>{
    const s=inputScene();select(s).unexpected=true;reject(s);
  });
}

const badPositions: [string,unknown][] = [
  ['2d',[116.39,39.9]],['4d',[116.39,39.9,50,1]],['boolean',[true,39.9,50]],
  ['string',['116.39',39.9,50]],['nan',[NaN,39.9,50]],['infinity',[116.39,39.9,Infinity]],
  ['longitude',[181,39.9,50]],['latitude',[116.39,-91,50]],['zero height',[116.39,39.9,0]],
  ['negative height',[116.39,39.9,-1]],['null',null],['object',{}],
];
for(const id of ['N1','ROAD_001','AREA_LOADING']) test.each(badPositions)(`rejects_invalid_scene_geometry ${id} %s`,(_,position)=>{
  const s=inputScene(),g=feature(s,id).geometry;
  if(id==='N1') g.coordinates=position;
  else if(id==='ROAD_001') (g.coordinates as unknown[])[1]=position;
  else (g.coordinates as unknown[][])[0][1]=position;
  reject(s);
});
const geometryMutations: [string,(s:MutableScene)=>void][] = [
  ['short line',s=>{feature(s,'ROAD_001').geometry.coordinates=[[116.39,39.9,50]];}],
  ['line object',s=>{feature(s,'ROAD_001').geometry.coordinates={};}],
  ['repeat horizontal',s=>{const p=feature(s,'ROAD_001').geometry.coordinates as number[][];p[1]=[p[0][0],p[0][1],51];}],
  ['holes',s=>{const p=feature(s,'AREA_LOADING').geometry.coordinates as unknown[][];p.push(structuredClone(p[0]));}],
  ['polygon object',s=>{feature(s,'AREA_LOADING').geometry.coordinates={};}],
  ['four corner ring',s=>{(feature(s,'AREA_LOADING').geometry.coordinates as unknown[][])[0].pop();}],
  ['unclosed',s=>{(feature(s,'AREA_LOADING').geometry.coordinates as number[][][])[0][4][2]=46;}],
  ['height varies',s=>{(feature(s,'AREA_LOADING').geometry.coordinates as number[][][])[0][2][2]=46;}],
  ['not axis aligned',s=>{(feature(s,'AREA_LOADING').geometry.coordinates as number[][][])[0][1][1]+=0.0001;}],
  ['reverse polygon',s=>{(feature(s,'AREA_LOADING').geometry.coordinates as unknown[][])[0].reverse();}],
  ['zero width',s=>{const p=(feature(s,'AREA_LOADING').geometry.coordinates as number[][][])[0];for(const q of p) q[0]=p[0][0];}],
];
test.each(geometryMutations)('rejects_invalid_scene_geometry %s',(_,mutate)=>{const s=inputScene();mutate(s);reject(s);});
for(const id of ['N1','ROAD_001','AREA_LOADING']) test.each([null,42,'',' \t'])('rejects_invalid_scene_geometry name '+id+' %j',name=>{
  const s=inputScene();feature(s,id).properties.name=name;reject(s);
});
test('accepts_arbitrary_additional_road_vertices_without_frontend_densification',()=>{
  const s=inputScene();const points=feature(s,'ROAD_001').geometry.coordinates as number[][];
  // Independent structural input: not a reproduction of backend Geod processing.
  points.splice(1,0,[116.3905,39.8997,50.4],[116.391,39.8994,50.7]);
  expect(parseMineScene(s)?.features.features.find(f=>f.id==='ROAD_001')?.geometry.coordinates)
    .toEqual([[116.39,39.9,50],[116.3905,39.8997,50.4],[116.391,39.8994,50.7],[116.3915,39.8992,51],[116.393,39.899,52]]);
});

const topologyMutations: [string,(s:MutableScene)=>void][] = [
  ['unknown from',s=>{feature(s,'ROAD_001').properties.from_node='N9';}],
  ['wrong to kind',s=>{feature(s,'ROAD_001').properties.to_node='AREA_LOADING';}],
  ['nonstring reference',s=>{feature(s,'ROAD_001').properties.to_node=2;}],
  ['self loop',s=>{feature(s,'ROAD_001').properties.to_node='N1';}],
  ['bidirectional number',s=>{feature(s,'ROAD_001').properties.bidirectional=1;}],
  ['reverse number',s=>{s.preset_route.segments[0].reverse=0;}],
  ['illegal reverse',s=>{reverseRoute(s);feature(s,'ROAD_006').properties.bidirectional=false;}],
  ['five segments',s=>{s.preset_route.segments.pop();}],
  ['duplicate edge',s=>{s.preset_route.segments[5].edge_id='ROAD_001';}],
  ['branch in route',s=>{s.preset_route.segments[5].edge_id='ROAD_009';}],
  ['unknown route edge',s=>{s.preset_route.segments[0].edge_id='ROAD_010';}],
  ['wrong order',s=>{[s.preset_route.segments[1],s.preset_route.segments[2]]=[s.preset_route.segments[2],s.preset_route.segments[1]];}],
  ['wrong direction',s=>{s.preset_route.segments[1].reverse=true;}],
  ['starts off N1',s=>{s.preset_route.segments.push(s.preset_route.segments.shift()!);}],
  ['horizontal endpoint approx 0.005m',s=>{(feature(s,'ROAD_001').geometry.coordinates as number[][])[0][0]+=0.000000058;}],
  ['vertical endpoint 0.005m',s=>{(feature(s,'ROAD_001').geometry.coordinates as number[][])[0][2]+=0.005;}],
  ['terminal endpoint height',s=>{const p=feature(s,'ROAD_006').geometry.coordinates as number[][];p[p.length-1][2]+=0.005;}],
  ['unreachable N8',s=>{const f=feature(s,'ROAD_009');f.properties.from_node='N8';f.properties.to_node='N6';f.properties.bidirectional=false;(f.geometry.coordinates as unknown[]).reverse();}],
];
function reverseRoute(s:MutableScene) { s.preset_route.segments.reverse();for(const p of s.preset_route.segments)p.reverse=true; }
test.each(topologyMutations)('rejects_invalid_scene_topology %s',(_,mutate)=>{const s=inputScene();mutate(s);reject(s);});
test('accepts_legal_reverse_six_edge_cycle',()=>{
  const s=inputScene();reverseRoute(s);
  expect(parseMineScene(s)?.preset_route.segments).toEqual([
    {edge_id:'ROAD_006',reverse:true},{edge_id:'ROAD_005',reverse:true},
    {edge_id:'ROAD_004',reverse:true},{edge_id:'ROAD_003',reverse:true},
    {edge_id:'ROAD_002',reverse:true},{edge_id:'ROAD_001',reverse:true},
  ]);
});
test('parser_returns_independent_protocol_objects',()=>{
  const input=inputScene();const scene=parseMineScene(input)!;
  feature(input,'N1').properties.name='changed';
  (feature(input,'ROAD_001').geometry.coordinates as number[][])[1][2]=99;
  input.preset_route.segments[0].reverse=true;
  expect(scene.features.features.find(f=>f.id==='N1')?.properties.name).toBe('Node 1');
  expect(scene.features.features.find(f=>f.id==='ROAD_001')?.geometry.coordinates).toEqual([[116.39,39.9,50],[116.3915,39.8992,51],[116.393,39.899,52]]);
  expect(scene.preset_route.segments[0].reverse).toBe(false);
});


test('fetches_scene_with_signal_and_no_store',async()=>{
  const input=makeSceneInput(),controller=new AbortController();
  let calls=0;
  const fetchImpl:typeof fetch=async(url,init)=>{
    calls++;
    expect(url).toBe('/api/scene');
    expect(init).toEqual({signal:controller.signal,cache:'no-store'});
    return new Response(JSON.stringify(input),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const scene=await loadMineScene({url:'/api/scene',signal:controller.signal,fetchImpl});
  expect(scene).toEqual(parseMineScene(input));
  expect(scene.features.features).toHaveLength(21);expect(calls).toBe(1);
});

test.each([
  ['NETWORK',undefined,'network'],['HTTP',404,'{}'],['HTTP',503,'{}'],
  ['JSON',200,'<html>error</html>'],['JSON',200,'{bad'],['SCHEMA',200,'{}'],
] as const)('distinguishes_network_http_json_schema_errors %s %j %s',async(code,status,body)=>{
  const cause=new TypeError('network unavailable');let calls=0;
  const fetchImpl:typeof fetch=async()=>{calls++;if(status===undefined)throw cause;return new Response(body,{status});};
  try {
    await loadMineScene({url:'/api/scene',signal:new AbortController().signal,fetchImpl});
    throw new Error('expected scene load failure');
  } catch(error) {
    expect(error).toBeInstanceOf(SceneLoadError);
    expect(error).toMatchObject({code});
    if(code==='HTTP')expect(error).toMatchObject({status});
    else expect((error as SceneLoadError).status).toBeUndefined();
    if(code==='NETWORK')expect((error as SceneLoadError).cause).toBe(cause);
    if(code==='JSON')expect((error as SceneLoadError).cause).toBeInstanceOf(SyntaxError);
  }
  expect(calls).toBe(1);
});

test('preserves_abort_error already cancelled without fetching',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const fetchImpl:typeof fetch=async()=>{calls++;return new Response(JSON.stringify(makeSceneInput()));};
  await expect(loadMineScene({url:'/api/scene',signal:controller.signal,fetchImpl})).rejects.toBe(controller.signal.reason);
  expect(calls).toBe(0);
});
test('preserves_abort_error while fetch is waiting',async()=>{
  const controller=new AbortController();
  const fetchImpl:typeof fetch=async(_,init)=>new Promise<Response>((_,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});
  });
  const promise=loadMineScene({url:'/api/scene',signal:controller.signal,fetchImpl});
  controller.abort();
  await expect(promise).rejects.toBe(controller.signal.reason);
});
test('preserves_abort_error while JSON body is waiting',async()=>{
  const controller=new AbortController();let started!:()=>void;
  const bodyStarted=new Promise<void>(resolve=>{started=resolve;});
  class WaitingResponse extends Response {
    override async json():Promise<unknown> {
      started();return new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    }
  }
  const fetchImpl:typeof fetch=async()=>new WaitingResponse('');
  const promise=loadMineScene({url:'/api/scene',signal:controller.signal,fetchImpl});
  await bodyStarted;controller.abort();
  await expect(promise).rejects.toBe(controller.signal.reason);
});
test('preserves_abort_error when a transport rejects AbortError',async()=>{
  const abort=new DOMException('cancelled','AbortError');
  const fetchImpl:typeof fetch=async()=>{throw abort;};
  await expect(loadMineScene({url:'/api/scene',signal:new AbortController().signal,fetchImpl})).rejects.toBe(abort);
});
test('preserves_abort_error even if JSON reader resolves after cancellation',async()=>{
  const controller=new AbortController();
  class CancellingResponse extends Response {
    override async json():Promise<unknown> {controller.abort();return makeSceneInput();}
  }
  const promise=loadMineScene({url:'/api/scene',signal:controller.signal,fetchImpl:async()=>new CancellingResponse('')});
  await expect(promise).rejects.toMatchObject({name:'AbortError'});
  await expect(promise).rejects.toBe(controller.signal.reason);
});



test('rejects_invalid_scene_geometry sparse position',()=>{
  const s=inputScene();const p:number[]=[];p.length=3;p[1]=39.9;p[2]=50;
  (feature(s,'ROAD_001').geometry.coordinates as unknown[])[1]=p;reject(s);
});
