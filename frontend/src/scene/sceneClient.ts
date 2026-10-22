export type ScenePosition = [number, number, number];
export type SceneNodeId = 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7' | 'N8';
export type SceneRoadId = `ROAD_00${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

type Feature<Id extends string, Kind extends string, Geometry, Props = object> = {
  type: 'Feature';
  id: Id;
  geometry: Geometry;
  properties: { kind: Kind; name: string } & Props;
};
export type SceneNodeFeature = Feature<SceneNodeId, 'road_node', {
  type: 'Point'; coordinates: ScenePosition;
}>;
export type SceneRoadFeature = Feature<SceneRoadId, 'road_edge', {
  type: 'LineString'; coordinates: ScenePosition[];
}, { from_node: SceneNodeId; to_node: SceneNodeId; bidirectional: boolean }>;
type PolygonGeometry = { type: 'Polygon'; coordinates: [ScenePosition[]] };
export type SceneAreaFeature =
  | Feature<'MINE_BOUNDARY', 'mine_boundary', PolygonGeometry>
  | Feature<'AREA_LOADING', 'loading_area', PolygonGeometry>
  | Feature<'AREA_DUMPING', 'dumping_area', PolygonGeometry>
  | Feature<'AREA_FACILITY', 'facility_area', PolygonGeometry>;
export type SceneFeature = SceneNodeFeature | SceneRoadFeature | SceneAreaFeature;
export type MineScene = {
  schema_version: 1;
  mine_id: 'DEMO_MINE';
  features: { type: 'FeatureCollection'; features: SceneFeature[] };
  preset_route: { route_id: 'ROUTE_001'; segments: { edge_id: SceneRoadId; reverse: boolean }[] };
};

const areaKinds = {
  MINE_BOUNDARY: 'mine_boundary', AREA_LOADING: 'loading_area',
  AREA_DUMPING: 'dumping_area', AREA_FACILITY: 'facility_area',
} as const;

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isNodeId(value: unknown): value is SceneNodeId {
  return typeof value === 'string' && /^N[1-8]$/.test(value);
}
function isRoadId(value: unknown): value is SceneRoadId {
  return typeof value === 'string' && /^ROAD_00[1-9]$/.test(value);
}
function isAreaId(value: unknown): value is keyof typeof areaKinds {
  return typeof value === 'string' && Object.hasOwn(areaKinds, value);
}
function position(value: unknown): ScenePosition | null {
  if (!Array.isArray(value) || value.length !== 3
    || ![value[0], value[1], value[2]].every(n => typeof n === 'number' && Number.isFinite(n))
    || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90 || value[2] <= 0) {
    return null;
  }
  return [value[0], value[1], value[2]];
}
function positions(value: unknown): ScenePosition[] | null {
  if (!Array.isArray(value)) return null;
  const result: ScenePosition[] = [];
  for (const item of value) {
    const point = position(item);
    if (!point) return null;
    result.push(point);
  }
  return result;
}
function samePosition(a: ScenePosition, b: ScenePosition): boolean {
  return a.every((number, index) => number === b[index]);
}

function parseFeature(value: unknown): SceneFeature | null {
  if (!objectWithKeys(value, ['type', 'id', 'geometry', 'properties']) || value.type !== 'Feature') return null;
  const id = value.id, geometry = value.geometry, props = value.properties;
  const road = isRoadId(id), node = isNodeId(id), area = isAreaId(id);
  if (!road && !node && !area) return null;
  if (!objectWithKeys(geometry, ['type', 'coordinates'])
    || !objectWithKeys(props, road ? ['kind', 'name', 'from_node', 'to_node', 'bidirectional'] : ['kind', 'name'])
    || typeof props.name !== 'string' || !props.name.trim()) return null;
  const name = props.name;
  if (isNodeId(id)) {
    const coordinates = position(geometry.coordinates);
    if (props.kind !== 'road_node' || geometry.type !== 'Point' || !coordinates) return null;
    return { type: 'Feature', id, geometry: { type: 'Point', coordinates }, properties: { kind: 'road_node', name } };
  }
  if (isRoadId(id)) {
    if (props.kind !== 'road_edge' || geometry.type !== 'LineString'
      || !isNodeId(props.from_node) || !isNodeId(props.to_node) || props.from_node === props.to_node
      || typeof props.bidirectional !== 'boolean') return null;
    const coordinates = positions(geometry.coordinates);
    if (!coordinates || coordinates.length < 2 || coordinates.some((point, index) => index > 0
      && point[0] === coordinates[index - 1][0] && point[1] === coordinates[index - 1][1])) return null;
    return {
      type: 'Feature', id, geometry: { type: 'LineString', coordinates },
      properties: { kind: 'road_edge', name, from_node: props.from_node, to_node: props.to_node,
        bidirectional: props.bidirectional },
    };
  }
  if (!isAreaId(id) || props.kind !== areaKinds[id] || geometry.type !== 'Polygon'
    || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) return null;
  const ring = positions(geometry.coordinates[0]);
  if (!ring || ring.length !== 5) return null;
  const [west, south, height] = ring[0], [east, north] = ring[2];
  const expected: ScenePosition[] = [
    [west, south, height], [east, south, height], [east, north, height],
    [west, north, height], [west, south, height],
  ];
  if (west >= east || south >= north || !ring.every((point, index) => samePosition(point, expected[index]))) return null;
  const polygon: PolygonGeometry = { type: 'Polygon', coordinates: [ring] };
  switch (id) {
    case 'MINE_BOUNDARY': return { type: 'Feature', id, geometry: polygon, properties: { kind: 'mine_boundary', name } };
    case 'AREA_LOADING': return { type: 'Feature', id, geometry: polygon, properties: { kind: 'loading_area', name } };
    case 'AREA_DUMPING': return { type: 'Feature', id, geometry: polygon, properties: { kind: 'dumping_area', name } };
    case 'AREA_FACILITY': return { type: 'Feature', id, geometry: polygon, properties: { kind: 'facility_area', name } };
  }
}

function isNodeFeature(feature: SceneFeature): feature is SceneNodeFeature {
  return feature.properties.kind === 'road_node';
}
function isRoadFeature(feature: SceneFeature): feature is SceneRoadFeature {
  return feature.properties.kind === 'road_edge';
}

export function parseMineScene(input: unknown): MineScene | null {
  if (!objectWithKeys(input, ['schema_version', 'mine_id', 'features', 'preset_route'])
    || input.schema_version !== 1 || input.mine_id !== 'DEMO_MINE') return null;
  const collection = input.features;
  if (!objectWithKeys(collection, ['type', 'features']) || collection.type !== 'FeatureCollection'
    || !Array.isArray(collection.features) || collection.features.length !== 21) return null;
  const seen = new Set<string>();
  const features: SceneFeature[] = [];
  for (const value of collection.features) {
    const feature = parseFeature(value);
    if (!feature || seen.has(feature.id)) return null;
    seen.add(feature.id);
    features.push(feature);
  }
  const route = input.preset_route;
  if (!objectWithKeys(route, ['route_id', 'segments']) || route.route_id !== 'ROUTE_001'
    || !Array.isArray(route.segments) || route.segments.length !== 6) return null;
  const segments: MineScene['preset_route']['segments'] = [];
  const routeIds = new Set<SceneRoadId>();
  for (const segment of route.segments) {
    if (!objectWithKeys(segment, ['edge_id', 'reverse']) || !isRoadId(segment.edge_id)
      || typeof segment.reverse !== 'boolean' || !/^ROAD_00[1-6]$/.test(segment.edge_id)
      || routeIds.has(segment.edge_id)) return null;
    routeIds.add(segment.edge_id);
    segments.push({ edge_id: segment.edge_id, reverse: segment.reverse });
  }
  const nodes = new Map(features.filter(isNodeFeature).map(node => [node.id, node.geometry.coordinates]));
  const roads = new Map(features.filter(isRoadFeature).map(road => [road.id, road]));
  const outgoing = new Map<SceneNodeId, SceneNodeId[]>();
  for (const road of roads.values()) {
    const { from_node: from, to_node: to, bidirectional } = road.properties;
    const coordinates = road.geometry.coordinates, start = nodes.get(from), end = nodes.get(to);
    // HTTP geometry has already been normalized by the backend: require exact 3D endpoints.
    if (!start || !end || !samePosition(start, coordinates[0])
      || !samePosition(end, coordinates[coordinates.length - 1])) return null;
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
    if (bidirectional) outgoing.set(to, [...(outgoing.get(to) ?? []), from]);
  }
  const reached = new Set<SceneNodeId>(), pending: SceneNodeId[] = ['N1'];
  while (pending.length) {
    const node = pending.pop()!;
    if (reached.has(node)) continue;
    reached.add(node);
    pending.push(...(outgoing.get(node) ?? []));
  }
  if (reached.size !== 8) return null;
  let current: SceneNodeId = 'N1';
  for (const segment of segments) {
    const road = roads.get(segment.edge_id);
    if (!road || (segment.reverse && !road.properties.bidirectional)) return null;
    const start = segment.reverse ? road.properties.to_node : road.properties.from_node;
    const end = segment.reverse ? road.properties.from_node : road.properties.to_node;
    if (start !== current) return null;
    current = end;
  }
  if (current !== 'N1') return null;
  return { schema_version: 1, mine_id: 'DEMO_MINE', features: { type: 'FeatureCollection', features },
    preset_route: { route_id: 'ROUTE_001', segments } };
}

export type SceneLoadErrorCode = 'NETWORK' | 'HTTP' | 'JSON' | 'SCHEMA';
export class SceneLoadError extends Error {
  readonly code: SceneLoadErrorCode;
  readonly status?: number;
  constructor(code: SceneLoadErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SceneLoadError';
    this.code = code;
    this.status = options.status;
  }
}

function preserveCancellation(signal: AbortSignal, cause: unknown): void {
  if (typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError') throw cause;
  signal.throwIfAborted();
}

export async function loadMineScene(options: {
  url: string; signal: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<MineScene> {
  options.signal.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.url, { signal: options.signal, cache: 'no-store' });
  } catch (cause) {
    preserveCancellation(options.signal, cause);
    throw new SceneLoadError('NETWORK', 'Unable to fetch mine scene', { cause });
  }
  options.signal.throwIfAborted();
  if (!response.ok) {
    throw new SceneLoadError('HTTP', `Mine scene request failed: HTTP ${response.status}`, { status: response.status });
  }
  let input: unknown;
  try {
    input = await response.json();
  } catch (cause) {
    preserveCancellation(options.signal, cause);
    throw new SceneLoadError('JSON', 'Unable to decode mine scene JSON', { cause });
  }
  options.signal.throwIfAborted();
  const scene = parseMineScene(input);
  if (!scene) throw new SceneLoadError('SCHEMA', 'Invalid mine scene schema');
  return scene;
}
