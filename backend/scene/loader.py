"""Validate scene topology and derive one immutable WGS84 geometry snapshot."""

import json
import math
from pathlib import Path
from collections.abc import Mapping
from copy import deepcopy
from types import MappingProxyType

from pyproj import Geod

_GEOD = Geod(ellps='WGS84')


class SceneValidationError(ValueError):
    """The scene source violates the supported application profile."""


class _ObjectPairs(list):
    """Retain JSON object pairs until their complete field path is known."""


class _NonfiniteConstant(str):
    """Internal JSON token marker, rejected once its field path is known."""


def _decode_objects(value, path='$'):
    if isinstance(value, _NonfiniteConstant):
        raise ValueError(f'{path}: nonfinite JSON number {value}')
    if isinstance(value, _ObjectPairs):
        result = {}
        for key, child in value:
            child_path = f'{path}.{key}'
            if key in result:
                raise ValueError(f'{child_path}: duplicate key {key!r}')
            result[key] = _decode_objects(child, child_path)
        return result
    if isinstance(value, list):
        return [_decode_objects(child, f'{path}[{index}]') for index, child in enumerate(value)]
    return value



def _read_scene(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(
            path.read_text(encoding='utf-8'),
            object_pairs_hook=_ObjectPairs,
            parse_constant=_NonfiniteConstant,
        )
        payload = _decode_objects(payload)
    except (OSError, UnicodeError, ValueError) as exc:
        raise SceneValidationError(f'$: cannot read scene {path}: {exc}') from exc
    _validate_structure(payload)
    _validate_features(payload)
    _validate_property_types(payload)
    _validate_coordinates(payload)
    _validate_geometry(payload)
    _validate_containment(payload)
    return payload


def _fail(path, message):
    raise SceneValidationError(f'{path}: {message}')


def _keys(value, required, path):
    if not isinstance(value, dict):
        _fail(path, 'expected object')
    missing = required - value.keys()
    extra = value.keys() - required
    if missing or extra:
        _fail(path, f'missing keys {sorted(missing)}; unknown keys {sorted(extra)}')


def _array(value, path):
    if not isinstance(value, list):
        _fail(path, 'expected array')


def _validate_structure(payload):
    _keys(payload, {'schema_version', 'mine_id', 'features', 'preset_route'}, '$')
    if type(payload['schema_version']) is not int or payload['schema_version'] != 1:
        _fail('$.schema_version', 'expected integer 1')
    if payload['mine_id'] != 'DEMO_MINE':
        _fail('$.mine_id', 'expected DEMO_MINE')
    collection = payload['features']
    _keys(collection, {'type', 'features'}, '$.features')
    if collection['type'] != 'FeatureCollection':
        _fail('$.features.type', 'expected FeatureCollection')
    _array(collection['features'], '$.features.features')
    for index, feature in enumerate(collection['features']):
        path = f'$.features.features[{index}]'
        _keys(feature, {'type', 'id', 'geometry', 'properties'}, path)
        if feature['type'] != 'Feature':
            _fail(f'{path}.type', 'expected Feature')
        _keys(feature['geometry'], {'type', 'coordinates'}, f'{path}.geometry')
        props = feature['properties']
        required = {'kind', 'name'}
        if isinstance(props, dict) and props.get('kind') == 'road_edge':
            required |= {'from_node', 'to_node', 'bidirectional'}
        _keys(props, required, f'{path}.properties')
    route = payload['preset_route']
    _keys(route, {'route_id', 'segments'}, '$.preset_route')
    if route['route_id'] != 'ROUTE_001':
        _fail('$.preset_route.route_id', 'expected ROUTE_001')
    _array(route['segments'], '$.preset_route.segments')
    for index, segment in enumerate(route['segments']):
        _keys(segment, {'edge_id', 'reverse'}, f'$.preset_route.segments[{index}]')


_NODE_IDS = {f'N{i}' for i in range(1, 9)}
_ROAD_IDS = {f'ROAD_{i:03d}' for i in range(1, 10)}
_AREA_KINDS = {
    'MINE_BOUNDARY': 'mine_boundary',
    'AREA_LOADING': 'loading_area',
    'AREA_DUMPING': 'dumping_area',
    'AREA_FACILITY': 'facility_area',
}
_FEATURE_IDS = _NODE_IDS | _ROAD_IDS | _AREA_KINDS.keys()


def _validate_features(payload):
    features = payload['features']['features']
    if len(features) != 21:
        _fail('$.features.features', 'expected exactly 21 features')
    seen = set()
    for index, feature in enumerate(features):
        path = f'$.features.features[{index}]'
        identifier = feature['id']
        if not isinstance(identifier, str) or identifier not in _FEATURE_IDS or identifier in seen:
            _fail(f'{path}.id', 'expected unique supported feature ID')
        seen.add(identifier)
        if identifier in _NODE_IDS:
            kind, geometry = 'road_node', 'Point'
        elif identifier in _ROAD_IDS:
            kind, geometry = 'road_edge', 'LineString'
        else:
            kind, geometry = _AREA_KINDS[identifier], 'Polygon'
        if feature['properties']['kind'] != kind:
            _fail(f'{path}.properties.kind', f'expected {kind} for {identifier}')
        if feature['geometry']['type'] != geometry:
            _fail(f'{path}.geometry.type', f'expected {geometry} for {identifier}')
        name = feature['properties']['name']
        if not isinstance(name, str) or not name.strip():
            _fail(f'{path}.properties.name', 'expected nonempty string')


def _validate_property_types(payload):
    for index, feature in enumerate(payload['features']['features']):
        if feature['id'] not in _ROAD_IDS:
            continue
        props = feature['properties']
        path = f'$.features.features[{index}].properties'
        if type(props['bidirectional']) is not bool:
            _fail(f'{path}.bidirectional', 'expected boolean')
        for field in ('from_node', 'to_node'):
            value = props[field]
            if not isinstance(value, str):
                _fail(f'{path}.{field}', 'expected string')

    for index, segment in enumerate(payload['preset_route']['segments']):
        path = f'$.preset_route.segments[{index}]'
        if type(segment['reverse']) is not bool:
            _fail(f'{path}.reverse', 'expected boolean')
        if not isinstance(segment['edge_id'], str):
            _fail(f'{path}.edge_id', 'expected string')


def _position(value, path):
    if not isinstance(value, list) or len(value) != 3:
        _fail(path, 'expected exactly three coordinates')
    for index, number in enumerate(value):
        number_path = f'{path}[{index}]'
        if type(number) not in (int, float):
            _fail(number_path, 'expected finite number, excluding boolean')
        try:
            finite = math.isfinite(number)
        except OverflowError as exc:
            raise SceneValidationError(f'{number_path}: number is not representable as a finite float') from exc
        if not finite:
            _fail(number_path, 'expected finite number, excluding boolean')
    if not -180 <= value[0] <= 180:
        _fail(f'{path}[0]', 'longitude outside [-180, 180]')
    if not -90 <= value[1] <= 90:
        _fail(f'{path}[1]', 'latitude outside [-90, 90]')
    if value[2] <= 0:
        _fail(f'{path}[2]', 'height must be positive')


def _validate_coordinates(payload):
    for index, feature in enumerate(payload['features']['features']):
        geometry = feature['geometry']
        coordinates = geometry['coordinates']
        path = f'$.features.features[{index}].geometry.coordinates'
        if geometry['type'] == 'Point':
            _position(coordinates, path)
        elif geometry['type'] == 'LineString':
            _array(coordinates, path)
            for position_index, position in enumerate(coordinates):
                _position(position, f'{path}[{position_index}]')
        else:
            _array(coordinates, path)
            for ring_index, ring in enumerate(coordinates):
                _array(ring, f'{path}[{ring_index}]')
                for position_index, position in enumerate(ring):
                    _position(position, f'{path}[{ring_index}][{position_index}]')


def _rectangle(coordinates, path):
    if len(coordinates) != 1:
        _fail(path, 'expected one exterior ring without holes')
    ring = coordinates[0]
    if len(ring) != 5:
        _fail(f'{path}[0]', 'expected five positions SW/SE/NE/NW/SW')
    west, south, height = ring[0]
    east, north, _ = ring[2]
    if west >= east or south >= north:
        _fail(f'{path}[0]', 'rectangle must have positive width and height')
    expected = [
        [west, south, height], [east, south, height],
        [east, north, height], [west, north, height], [west, south, height],
    ]
    if ring != expected:
        _fail(f'{path}[0]', 'expected closed constant-height rectangle SW/SE/NE/NW/SW')
    return west, south, east, north


def _validate_geometry(payload):
    for index, feature in enumerate(payload['features']['features']):
        geometry = feature['geometry']
        coordinates = geometry['coordinates']
        path = f'$.features.features[{index}].geometry.coordinates'
        if geometry['type'] == 'LineString':
            if len(coordinates) < 2:
                _fail(path, 'expected at least two positions')
            for position_index, (start, end) in enumerate(zip(coordinates, coordinates[1:])):
                if start[:2] == end[:2]:
                    _fail(f'{path}[{position_index + 1}]', 'adjacent positions must differ horizontally')
        elif geometry['type'] == 'Polygon':
            _rectangle(coordinates, path)


def _validate_containment(payload):
    features = payload['features']['features']
    boundary = next(feature for feature in features if feature['id'] == 'MINE_BOUNDARY')
    ring = boundary['geometry']['coordinates'][0]
    west, south = ring[0][:2]
    east, north = ring[2][:2]
    areas = []
    for index, feature in enumerate(features):
        if feature['id'] == 'MINE_BOUNDARY':
            continue
        geometry = feature['geometry']
        coords = geometry['coordinates']
        path = f'$.features.features[{index}].geometry.coordinates'
        if geometry['type'] == 'Point':
            positions = [(coords, path)]
        elif geometry['type'] == 'LineString':
            positions = [(position, f'{path}[{i}]') for i, position in enumerate(coords)]
        else:
            positions = [(position, f'{path}[0][{i}]') for i, position in enumerate(coords[0])]
            areas.append((coords[0][0][0], coords[0][0][1], coords[0][2][0], coords[0][2][1], path))
        for position, position_path in positions:
            if not (west <= position[0] <= east and south <= position[1] <= north):
                _fail(position_path, 'outside mine boundary')
    for index, first in enumerate(areas):
        for second in areas[index + 1:]:
            if max(first[0], second[0]) < min(first[2], second[2]) and max(first[1], second[1]) < min(first[3], second[3]):
                _fail(first[4], f'area interior overlaps {second[4]}')


Position = tuple[float, float, float]
DEFAULT_SCENE_PATH = Path(__file__).resolve().parents[1] / 'data' / 'demo_mine.json'


class LoadedScene:
    """Validated snapshot; load_scene is its only supported construction path."""

    __slots__ = ('__payload', '__roads', '__nodes', '__segments')

    def __init__(self, *args, **kwargs):
        raise TypeError('LoadedScene must be created by load_scene')

    def __setattr__(self, name, value):
        raise AttributeError('LoadedScene is read-only')

    @property
    def road_coordinates(self) -> Mapping[str, tuple[Position, ...]]:
        return self.__roads

    @property
    def node_coordinates(self) -> Mapping[str, Position]:
        return self.__nodes

    @property
    def route_segments(self) -> tuple[tuple[str, bool], ...]:
        return self.__segments

    def get_payload(self) -> dict[str, object]:
        return deepcopy(self.__payload)


def _snapshot(payload):
    scene = object.__new__(LoadedScene)
    features = payload['features']['features']
    nodes = {f['id']: tuple(f['geometry']['coordinates']) for f in features if f['id'] in _NODE_IDS}
    roads = {f['id']: tuple(tuple(p) for p in f['geometry']['coordinates']) for f in features if f['id'] in _ROAD_IDS}
    segments = tuple((s['edge_id'], s['reverse']) for s in payload['preset_route']['segments'])
    object.__setattr__(scene, '_LoadedScene__payload', payload)
    object.__setattr__(scene, '_LoadedScene__nodes', MappingProxyType(nodes))
    object.__setattr__(scene, '_LoadedScene__roads', MappingProxyType(roads))
    object.__setattr__(scene, '_LoadedScene__segments', segments)
    return scene


def load_scene(path: Path) -> LoadedScene:
    payload = _read_scene(path)
    _validate_road_lengths(payload)
    _validate_references(payload)
    _normalize_endpoints(payload)
    _validate_road_lengths(payload)
    _validate_reachability(payload)
    _validate_route(payload)
    _densify(payload)
    _validate_road_lengths(payload, dense=True)
    return _snapshot(payload)


def _roads(payload):
    return [f for f in payload['features']['features'] if f['id'] in _ROAD_IDS]


def _validate_references(payload):
    for road in _roads(payload):
        props = road['properties']
        path = road['id'] + '.properties'
        for field in ('from_node', 'to_node'):
            if props[field] not in _NODE_IDS:
                _fail(f'{path}.{field}', 'expected road_node reference')
        if props['from_node'] == props['to_node']:
            _fail(f'{path}.to_node', 'self-loop is not allowed')


def _validate_reachability(payload):
    graph = {node: set() for node in _NODE_IDS}
    for road in _roads(payload):
        props = road['properties']
        graph[props['from_node']].add(props['to_node'])
        if props['bidirectional']:
            graph[props['to_node']].add(props['from_node'])
    reached, pending = set(), ['N1']
    while pending:
        node = pending.pop()
        if node not in reached:
            reached.add(node)
            pending.extend(graph[node] - reached)
    missing = sorted(_NODE_IDS - reached)
    if missing:
        _fail('$.features', f'nodes unreachable from N1: {missing}')


def _validate_route(payload):
    segments = payload['preset_route']['segments']
    path = '$.preset_route.segments'
    required = {f'ROAD_{i:03d}' for i in range(1, 7)}
    if len(segments) != 6 or {s['edge_id'] for s in segments} != required:
        _fail(path, 'expected ROAD_001 through ROAD_006 exactly once')
    roads = {road['id']: road for road in _roads(payload)}
    current = 'N1'
    for index, segment in enumerate(segments):
        road = roads[segment['edge_id']]
        props = road['properties']
        start, end = props['from_node'], props['to_node']
        if segment['reverse']:
            if not props['bidirectional']:
                _fail(f'{path}[{index}].reverse', 'cannot reverse a one-way edge')
            start, end = end, start
        if start != current:
            _fail(f'{path}[{index}]', f'route starts at {start}, expected {current}')
        current = end
    if current != 'N1':
        _fail(path, 'route must close at N1')



def _horizontal(start, end):
    return _GEOD.inv(start[0], start[1], end[0], end[1])[2]


def _normalize_endpoints(payload):
    nodes = {f['id']: f['geometry']['coordinates'] for f in payload['features']['features'] if f['id'] in _NODE_IDS}
    for road in _roads(payload):
        coords, props = road['geometry']['coordinates'], road['properties']
        for index, field in ((0, 'from_node'), (-1, 'to_node')):
            node = nodes[props[field]]
            gap = math.hypot(_horizontal(coords[index], node), coords[index][2] - node[2])
            if not math.isfinite(gap) or gap > 0.01:
                _fail(f"{road['id']}.geometry.coordinates[{index}]", '3D endpoint distance exceeds 0.01 m')
            coords[index] = node.copy()


def _validate_road_lengths(payload, *, dense=False):
    for road in _roads(payload):
        coordinates = road['geometry']['coordinates']
        for index, (start, end) in enumerate(zip(coordinates, coordinates[1:])):
            distance = _horizontal(start, end)
            path = f"{road['id']}.geometry.coordinates[{index + 1}]"
            if not math.isfinite(distance) or distance <= 0.001:
                _fail(path, 'horizontal segment length must exceed 0.001 m')
            if dense and distance > 5.0 + 1e-6:
                _fail(path, 'densified segment exceeds 5 m')


def _densify(payload):
    for road in _roads(payload):
        raw = road['geometry']['coordinates']
        dense = [raw[0]]
        for start, end in zip(raw, raw[1:]):
            azimuth, _, distance = _GEOD.inv(*start[:2], *end[:2])
            count = math.ceil(distance / 5.0)
            for step in range(1, count):
                fraction = step / count
                lon, lat, _ = _GEOD.fwd(start[0], start[1], azimuth, distance * fraction)
                point = [lon, lat, start[2] + (end[2] - start[2]) * fraction]
                _position(point, f"{road['id']}.geometry.coordinates[{len(dense)}]")
                dense.append(point)
            dense.append(end)
        road['geometry']['coordinates'] = dense
