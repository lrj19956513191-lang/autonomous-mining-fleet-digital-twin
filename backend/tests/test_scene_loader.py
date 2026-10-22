import json
import math
from pathlib import Path

import pytest
from pyproj import Geod

from backend.scene import loader

from backend.scene.loader import SceneValidationError, _read_scene


TEST_GEOD = Geod(ellps='WGS84')
DEMO_PATH = Path(__file__).resolve().parents[1] / 'data' / 'demo_mine.json'


def test_structure_matches_spec():
    # Literal expectations transcribed independently from the approved Spec.
    expected_nodes = {
        'N1': [116.3900, 39.9000, 50.0],
        'N2': [116.3930, 39.8990, 52.0],
        'N3': [116.3960, 39.9000, 54.0],
        'N4': [116.3945, 39.9030, 56.0],
        'N5': [116.3890, 39.9030, 53.0],
        'N6': [116.3860, 39.9010, 51.0],
        'N7': [116.3900, 39.9018, 52.0],
        'N8': [116.3845, 39.8995, 50.0],
    }
    expected_midpoints = {
        'ROAD_001': [116.3915, 39.8992, 51.0],
        'ROAD_002': [116.3950, 39.8992, 53.0],
        'ROAD_003': [116.3960, 39.9015, 55.0],
        'ROAD_004': [116.3920, 39.9033, 54.5],
        'ROAD_005': [116.3870, 39.9025, 52.0],
        'ROAD_006': [116.3865, 39.8998, 50.5],
        'ROAD_007': [116.3915, 39.9005, 52.0],
        'ROAD_008': [116.3895, 39.9022, 52.5],
        'ROAD_009': [116.3845, 39.9005, 50.5],
    }
    expected_rectangles = {
        'MINE_BOUNDARY': [[116.3830, 39.8959, 45.0], [116.3970, 39.8959, 45.0], [116.3970, 39.9041, 45.0], [116.3830, 39.9041, 45.0], [116.3830, 39.8959, 45.0]],
        'AREA_LOADING': [[116.3915, 39.8982, 45.0], [116.3945, 39.8982, 45.0], [116.3945, 39.8998, 45.0], [116.3915, 39.8998, 45.0], [116.3915, 39.8982, 45.0]],
        'AREA_DUMPING': [[116.3875, 39.9022, 45.0], [116.3905, 39.9022, 45.0], [116.3905, 39.9038, 45.0], [116.3875, 39.9038, 45.0], [116.3875, 39.9022, 45.0]],
        'AREA_FACILITY': [[116.3838, 39.8987, 45.0], [116.3858, 39.8987, 45.0], [116.3858, 39.9002, 45.0], [116.3838, 39.9002, 45.0], [116.3838, 39.8987, 45.0]],
    }
    expected_ends = {
        'ROAD_001': ('N1', 'N2'), 'ROAD_002': ('N2', 'N3'),
        'ROAD_003': ('N3', 'N4'), 'ROAD_004': ('N4', 'N5'),
        'ROAD_005': ('N5', 'N6'), 'ROAD_006': ('N6', 'N1'),
        'ROAD_007': ('N2', 'N7'), 'ROAD_008': ('N7', 'N5'),
        'ROAD_009': ('N6', 'N8'),
    }
    payload = _read_scene(DEMO_PATH)
    features = {feature['id']: feature for feature in payload['features']['features']}
    nodes = {key: features[key]['geometry']['coordinates'] for key in expected_nodes}
    original_road_midpoints = {key: features[key]['geometry']['coordinates'][1] for key in expected_midpoints}
    rectangles = {key: features[key]['geometry']['coordinates'][0] for key in expected_rectangles}
    assert payload['schema_version'] == 1
    assert payload['mine_id'] == 'DEMO_MINE'
    assert len(payload['features']['features']) == 21
    assert set(features) == set(expected_nodes) | set(expected_midpoints) | set(expected_rectangles)
    assert nodes == expected_nodes
    assert original_road_midpoints == expected_midpoints
    assert rectangles == expected_rectangles
    for key, (start, end) in expected_ends.items():
        assert features[key]['geometry']['coordinates'] == [expected_nodes[start], expected_midpoints[key], expected_nodes[end]]
        assert features[key]['properties']['from_node'] == start
        assert features[key]['properties']['to_node'] == end
        assert features[key]['properties']['bidirectional'] is True
    assert payload['preset_route']['route_id'] == 'ROUTE_001'
    assert payload['preset_route']['segments'] == [
        {'edge_id': 'ROAD_001', 'reverse': False},
        {'edge_id': 'ROAD_002', 'reverse': False},
        {'edge_id': 'ROAD_003', 'reverse': False},
        {'edge_id': 'ROAD_004', 'reverse': False},
        {'edge_id': 'ROAD_005', 'reverse': False},
        {'edge_id': 'ROAD_006', 'reverse': False},
    ]


def write_payload(tmp_path, payload):
    path = tmp_path / 'scene.json'
    path.write_text(json.dumps(payload), encoding='utf-8')
    return path


@pytest.mark.parametrize('case', ['duplicate-root', 'duplicate-feature', 'syntax', 'nan', 'infinity', 'negative-infinity', 'missing-file', 'invalid-utf8'])
def test_structure_rejects_invalid_json(case, tmp_path, demo_payload):
    path = tmp_path / 'scene.json'
    if case == 'missing-file':
        pass
    elif case == 'invalid-utf8':
        path.write_bytes(b'\xff')
    else:
        text = json.dumps(demo_payload)
        if case == 'duplicate-root':
            text = text.replace('"schema_version": 1', '"schema_version": 1, "schema_version": 1')
        elif case == 'duplicate-feature':
            text = text.replace('"id": "N1"', '"id": "N1", "id": "N1"')
        elif case == 'syntax':
            text = text[:-1]
        elif case == 'nan':
            text = text.replace('50.0', 'NaN', 1)
        elif case == 'infinity':
            text = text.replace('50.0', 'Infinity', 1)
        elif case == 'negative-infinity':
            text = text.replace('50.0', '-Infinity', 1)
        path.write_text(text, encoding='utf-8')
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(path)
    location = '$.features.features[0].geometry.coordinates[2]' if case in {'nan', 'infinity', 'negative-infinity'} else '$'
    assert location in str(exc.value)
    assert exc.value.__cause__ is not None


def at_path(payload, path):
    value = payload
    for key in path:
        value = value[key]
    return value


KEY_OBJECTS = [
    ((), 'mine_id', '$'),
    (('features',), 'type', '$.features'),
    (('features', 'features', 0), 'type', '$.features.features[0]'),
    (('features', 'features', 0, 'geometry'), 'type', '$.features.features[0].geometry'),
    (('features', 'features', 0, 'properties'), 'name', '$.features.features[0].properties'),
    (('features', 'features', 8, 'properties'), 'from_node', '$.features.features[8].properties'),
    (('preset_route',), 'route_id', '$.preset_route'),
    (('preset_route', 'segments', 0), 'reverse', '$.preset_route.segments[0]'),
]


@pytest.mark.parametrize('path,key,location', KEY_OBJECTS)
@pytest.mark.parametrize('change', ['missing', 'extra', 'null', 'array'])
def test_structure_requires_exact_keys(path, key, location, change, tmp_path, demo_payload):
    target = at_path(demo_payload, path)
    if change == 'missing':
        del target[key]
    elif change == 'extra':
        target['unexpected'] = 'value'
    elif path:
        at_path(demo_payload, path[:-1])[path[-1]] = None if change == 'null' else []
    else:
        demo_payload = None if change == 'null' else []
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)


@pytest.mark.parametrize('path,value,location', [
    (('schema_version',), True, '$.schema_version'),
    (('schema_version',), 1.0, '$.schema_version'),
    (('schema_version',), 2, '$.schema_version'),
    (('mine_id',), 'OTHER', '$.mine_id'),
    (('preset_route', 'route_id'), 'OTHER', '$.preset_route.route_id'),
    (('features', 'type'), 'Other', '$.features.type'),
    (('features', 'features', 0, 'type'), 'Other', '$.features.features[0].type'),
    (('features', 'features'), None, '$.features.features'),
    (('preset_route', 'segments'), None, '$.preset_route.segments'),
])
def test_structure_requires_exact_keys_values(path, value, location, tmp_path, demo_payload):
    at_path(demo_payload, path[:-1])[path[-1]] = value
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)


@pytest.mark.parametrize('case', ['count', 'duplicate-id', 'unknown-id', 'empty-id', 'null-id', 'object-id', 'node-kind', 'area-kinds', 'unknown-kind', 'null-kind', 'unknown-geometry', 'wrong-geometry', 'missing-name', 'null-name', 'number-name', 'blank-name'])
def test_structure_binds_ids_and_kinds(case, tmp_path, demo_payload):
    features = demo_payload['features']['features']
    location = '$.features.features'
    if case == 'count':
        features.pop()
    elif case in {'duplicate-id', 'unknown-id', 'empty-id', 'null-id', 'object-id'}:
        features[0]['id'] = {'duplicate-id': 'N2', 'unknown-id': 'N9', 'empty-id': '', 'null-id': None, 'object-id': {}}[case]
        location += '[1].id' if case == 'duplicate-id' else '[0].id'
    elif case == 'area-kinds':
        features[18]['properties']['kind'], features[19]['properties']['kind'] = features[19]['properties']['kind'], features[18]['properties']['kind']
        location += '[18].properties.kind'
    elif case in {'node-kind', 'unknown-kind', 'null-kind'}:
        features[0]['properties']['kind'] = {'node-kind': 'loading_area', 'unknown-kind': 'unknown', 'null-kind': None}[case]
        location += '[0].properties.kind'
    elif case in {'unknown-geometry', 'wrong-geometry'}:
        features[0]['geometry']['type'] = 'Unknown' if case == 'unknown-geometry' else 'Polygon'
        location += '[0].geometry.type'
    else:
        location += '[0].properties'
        if case == 'missing-name':
            del features[0]['properties']['name']
        else:
            features[0]['properties']['name'] = {'null-name': None, 'number-name': 10, 'blank-name': ' \t\n '}[case]
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)


def test_structure_preserves_names_and_feature_order(tmp_path, demo_payload):
    demo_payload['features']['features'][0]['properties']['name'] = '  Node one  '
    demo_payload['features']['features'].reverse()
    assert _read_scene(write_payload(tmp_path, demo_payload)) == demo_payload



@pytest.mark.parametrize('field,value', [
    ('bidirectional', 1), ('bidirectional', 'false'), ('bidirectional', None),
    ('from_node', 1), ('from_node', None), ('from_node', {}), ('from_node', []),
    ('to_node', 1), ('to_node', None), ('to_node', {}), ('to_node', []),
])
def test_structure_validates_property_types(field, value, tmp_path, demo_payload):
    demo_payload['features']['features'][8]['properties'][field] = value
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert f'$.features.features[8].properties.{field}' in str(exc.value)


@pytest.mark.parametrize('field,value', [('reverse', 1), ('reverse', 'false'), ('reverse', None), ('edge_id', 1), ('edge_id', {}), ('edge_id', []), ('edge_id', None)])
def test_structure_validates_property_types_route(field, value, tmp_path, demo_payload):
    demo_payload['preset_route']['segments'][0][field] = value
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert f'$.preset_route.segments[0].{field}' in str(exc.value)


def test_structure_accepts_boolean_properties(tmp_path, demo_payload):
    demo_payload['features']['features'][8]['properties']['bidirectional'] = False
    demo_payload['preset_route']['segments'][0]['reverse'] = True
    # Directional route feasibility is deliberately deferred to Task 2.
    assert _read_scene(write_payload(tmp_path, demo_payload)) == demo_payload


INVALID_POSITIONS = [
    None, 1, 'position', {}, [], [116.39, 39.90], [116.39, 39.90, 50, 1],
    [True, 39.90, 50], [116.39, False, 50], [116.39, 39.90, True],
    ['116.39', 39.90, 50], [116.39, '39.90', 50], [116.39, 39.90, '50'],
    [float('nan'), 39.90, 50], [116.39, float('inf'), 50], [116.39, 39.90, float('-inf')],
    [-180.01, 39.90, 50], [180.01, 39.90, 50], [116.39, -90.01, 50], [116.39, 90.01, 50],
    [116.39, 39.90, 0], [116.39, 39.90, -1],
]


@pytest.mark.parametrize('target', ['node', 'road', 'area'])
@pytest.mark.parametrize('value', INVALID_POSITIONS)
def test_structure_validates_coordinates(target, value, tmp_path, demo_payload):
    features = demo_payload['features']['features']
    if target == 'node':
        features[0]['geometry']['coordinates'] = value
        location = '$.features.features[0].geometry.coordinates'
    elif target == 'road':
        features[8]['geometry']['coordinates'][1] = value
        location = '$.features.features[8].geometry.coordinates[1]'
    else:
        features[18]['geometry']['coordinates'][0][0] = value
        location = '$.features.features[18].geometry.coordinates[0][0]'
    nonfinite_index = next((index for index, item in enumerate(value) if isinstance(item, float) and (item != item or abs(item) == float('inf'))), None) if isinstance(value, list) else None
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    if nonfinite_index is not None:
        assert f'{location}[{nonfinite_index}]' in str(exc.value)
        assert exc.value.__cause__ is not None
    else:
        assert location in str(exc.value)


def test_structure_validates_coordinates_overflow(tmp_path, demo_payload):
    text = json.dumps(demo_payload).replace('50.0', '1e309', 1)
    path = tmp_path / 'scene.json'
    path.write_text(text, encoding='utf-8')
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(path)
    assert '$.features.features[0].geometry.coordinates[2]' in str(exc.value)


def test_structure_preserves_coordinate_units(tmp_path, demo_payload):
    assert _read_scene(write_payload(tmp_path, demo_payload)) == demo_payload


@pytest.mark.parametrize('case', ['point-nested', 'line-null', 'line-primitive', 'line-short', 'line-empty', 'line-repeated', 'line-vertical', 'polygon-null', 'polygon-primitive', 'polygon-no-rings', 'polygon-ring-null', 'polygon-holes', 'polygon-short', 'polygon-order', 'polygon-unclosed', 'polygon-height', 'polygon-degenerate', 'polygon-not-rectangle'])
def test_structure_validates_geometry(case, tmp_path, demo_payload):
    features = demo_payload['features']['features']
    if case == 'point-nested':
        features[0]['geometry']['coordinates'] = [[116.39, 39.90, 50]]
        location = '$.features.features[0].geometry.coordinates'
    elif case.startswith('line'):
        coords = features[8]['geometry']['coordinates']
        location = '$.features.features[8].geometry.coordinates'
        if case == 'line-null':
            features[8]['geometry']['coordinates'] = None
        elif case == 'line-primitive':
            features[8]['geometry']['coordinates'] = 1
        elif case == 'line-short':
            features[8]['geometry']['coordinates'] = coords[:1]
        elif case == 'line-empty':
            features[8]['geometry']['coordinates'] = []
        elif case == 'line-repeated':
            coords[1] = coords[0].copy()
        else:
            coords[1] = [coords[0][0], coords[0][1], coords[0][2] + 1]
    else:
        polygon = features[18]['geometry']
        ring = polygon['coordinates'][0]
        location = '$.features.features[18].geometry.coordinates'
        if case == 'polygon-null':
            polygon['coordinates'] = None
        elif case == 'polygon-primitive':
            polygon['coordinates'] = 1
        elif case == 'polygon-no-rings':
            polygon['coordinates'] = []
        elif case == 'polygon-ring-null':
            polygon['coordinates'] = [None]
        elif case == 'polygon-holes':
            polygon['coordinates'].append([position.copy() for position in ring])
        elif case == 'polygon-short':
            ring.pop()
        elif case == 'polygon-order':
            ring[1], ring[3] = ring[3], ring[1]
        elif case == 'polygon-unclosed':
            ring[-1] = ring[1].copy()
        elif case == 'polygon-height':
            ring[2][2] += 1
        elif case == 'polygon-degenerate':
            for position in ring:
                position[0] = 116.3915
        else:
            ring[2][0] -= 0.0001
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)


def test_structure_validates_coordinates_large_integer(tmp_path, demo_payload):
    demo_payload['features']['features'][0]['geometry']['coordinates'][0] = 10**400
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert '$.features.features[0].geometry.coordinates[0]' in str(exc.value)


def set_rectangle(feature, west, south, east, north, height=45.0):
    feature['geometry']['coordinates'] = [[
        [west, south, height], [east, south, height], [east, north, height],
        [west, north, height], [west, south, height],
    ]]


@pytest.mark.parametrize('case', ['node-west', 'node-east', 'node-south', 'node-north', 'road-vertex', 'area-west', 'area-east', 'area-south', 'area-north', 'area-overlap'])
def test_structure_contains_features(case, tmp_path, demo_payload):
    features = demo_payload['features']['features']
    if case.startswith('node'):
        coords = features[0]['geometry']['coordinates']
        index, value = {'node-west': (0, 116.3829), 'node-east': (0, 116.3971), 'node-south': (1, 39.8958), 'node-north': (1, 39.9042)}[case]
        coords[index] = value
        location = '$.features.features[0].geometry.coordinates'
    elif case == 'road-vertex':
        features[8]['geometry']['coordinates'][1][0] = 116.3971
        location = '$.features.features[8].geometry.coordinates[1]'
    else:
        bounds = {
            'area-west': (116.3829, 39.8982, 116.3945, 39.8998),
            'area-east': (116.3915, 39.8982, 116.3971, 39.8998),
            'area-south': (116.3915, 39.8958, 116.3945, 39.8998),
            'area-north': (116.3915, 39.8982, 116.3945, 39.9042),
            'area-overlap': (116.3850, 39.8990, 116.3865, 39.9000),
        }[case]
        set_rectangle(features[18], *bounds)
        location = '$.features.features[18].geometry.coordinates'
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)


@pytest.mark.parametrize('contact', ['edge', 'corner', 'boundary'])
def test_structure_contains_features_allows_shared_boundaries(contact, tmp_path, demo_payload):
    features = demo_payload['features']['features']
    if contact == 'edge':
        set_rectangle(features[18], 116.3858, 39.8987, 116.3875, 39.9002)
    elif contact == 'corner':
        set_rectangle(features[18], 116.3858, 39.9002, 116.3875, 39.9010)
    else:
        features[0]['geometry']['coordinates'] = [116.3830, 39.8959, 50]
        features[8]['geometry']['coordinates'][1] = [116.3970, 39.9041, 51]
        set_rectangle(features[18], 116.3950, 39.8959, 116.3970, 39.8980)
    assert _read_scene(write_payload(tmp_path, demo_payload)) == demo_payload


@pytest.mark.parametrize('path', [
    ('features', 'features', 0, 'id'),
    ('features', 'features', 0, 'geometry'),
    ('features', 'features', 0, 'properties'),
    ('features', 'features', 0, 'geometry', 'type'),
    ('features', 'features', 0, 'properties', 'kind'),
    ('features', 'features', 0, 'properties', 'name'),
])
@pytest.mark.parametrize('value', [{}, [], None])
def test_structure_malformed_objects_do_not_leak_type_errors(path, value, tmp_path, demo_payload):
    at_path(demo_payload, path[:-1])[path[-1]] = value
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(write_payload(tmp_path, demo_payload))
    assert '$.features.features[0]' in str(exc.value)


@pytest.mark.parametrize('duplicate,location', [
    ('"schema_version": 1', '$.schema_version'),
    ('"id": "N1"', '$.features.features[0].id'),
])
def test_structure_duplicate_json_reports_field_path(duplicate, location, tmp_path, demo_payload):
    text = json.dumps(demo_payload).replace(duplicate, f'{duplicate}, {duplicate}', 1)
    path = tmp_path / 'scene.json'
    path.write_text(text, encoding='utf-8')
    with pytest.raises(SceneValidationError) as exc:
        _read_scene(path)
    assert location in str(exc.value)
    assert exc.value.__cause__ is not None


@pytest.mark.parametrize('path,value', [
    (('features', 'features', 8, 'properties', 'from_node'), 'N9'),
    (('features', 'features', 8, 'properties', 'to_node'), 'N9'),
    (('features', 'features', 8, 'properties', 'to_node'), 'N1'),
    (('preset_route', 'segments', 0, 'edge_id'), 'UNKNOWN'),
])
def test_structure_defers_reference_semantics(path, value, tmp_path, demo_payload):
    # Task 1 checks string types; reference/self-loop semantics belong to Task 2.
    at_path(demo_payload, path[:-1])[path[-1]] = value
    assert _read_scene(write_payload(tmp_path, demo_payload)) == demo_payload



def test_topology_returns_loaded_scene():
    # Missing validation entry point or leaked mutable snapshot breaks consumers.
    assert callable(getattr(loader, 'load_scene', None))
    scene = loader.load_scene(DEMO_PATH)
    assert isinstance(scene, loader.LoadedScene)
    assert loader.DEFAULT_SCENE_PATH == DEMO_PATH
    assert len(scene.node_coordinates) == 8
    assert len(scene.road_coordinates) == 9
    assert scene.route_segments == tuple((f'ROAD_{i:03d}', False) for i in range(1, 7))
    payload = scene.get_payload()
    payload['features']['features'][0]['geometry']['coordinates'][2] = 999
    payload['preset_route']['segments'][0]['reverse'] = True
    assert scene.get_payload()['features']['features'][0]['geometry']['coordinates'][2] == 50.0
    assert scene.route_segments[0] == ('ROAD_001', False)
    with pytest.raises(TypeError):
        scene.node_coordinates['N1'] = (0, 0, 0)
    with pytest.raises(TypeError):
        scene.road_coordinates['ROAD_001'] = ()
    with pytest.raises(AttributeError):
        scene.route_segments = ()
    with pytest.raises(AttributeError):
        scene.node_coordinates = {}
    with pytest.raises(AttributeError):
        scene.road_coordinates = {}
    with pytest.raises(TypeError):
        loader.LoadedScene(payload)


@pytest.mark.parametrize('case,location', [
    ('missing-from', 'ROAD_001.properties.from_node'),
    ('non-node-to', 'ROAD_001.properties.to_node'),
    ('self-loop', 'ROAD_001.properties.to_node'),
    ('unreachable', 'N8'),
    ('crossing-not-connection', 'N8'),
])
def test_topology_references_and_reachability(case, location, tmp_path, demo_payload, scene_features):
    # Wrong graph direction or treating geometric crossings as nodes admits N8.
    first = scene_features['ROAD_001']['properties']
    if case == 'missing-from':
        first['from_node'] = 'N9'
    elif case == 'non-node-to':
        first['to_node'] = 'AREA_LOADING'
    elif case == 'self-loop':
        first['to_node'] = 'N1'
    else:
        spur = scene_features['ROAD_009']
        spur['properties']['from_node'], spur['properties']['to_node'] = 'N8', 'N6'
        spur['properties']['bidirectional'] = False
        spur['geometry']['coordinates'].reverse()
        if case == 'crossing-not-connection':
            spur['geometry']['coordinates'][1] = scene_features['ROAD_001']['geometry']['coordinates'][1].copy()
        assert spur['geometry']['coordinates'][0] == scene_features['N8']['geometry']['coordinates']
        assert spur['geometry']['coordinates'][-1] == scene_features['N6']['geometry']['coordinates']
    with pytest.raises(SceneValidationError) as exc:
        loader.load_scene(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)
    if case in {'unreachable', 'crossing-not-connection'}:
        assert 'unreachable' in str(exc.value)


@pytest.mark.parametrize('case', ['reverse-type', 'one-way-reverse', 'missing-edge', 'branch', 'repeat', 'too-short', 'broken-order', 'wrong-start', 'not-closed', 'reverse-loop'])
def test_topology_route_direction(case, tmp_path, demo_payload, scene_features):
    # Accepting a broken/directionally forbidden ring would create vehicle jumps.
    segments = demo_payload['preset_route']['segments']
    if case == 'reverse-type':
        segments[0]['reverse'] = 1
    elif case in {'one-way-reverse', 'reverse-loop'}:
        segments[:] = [{'edge_id': f'ROAD_{i:03d}', 'reverse': True} for i in range(6, 0, -1)]
        if case == 'one-way-reverse':
            scene_features['ROAD_006']['properties']['bidirectional'] = False
    elif case == 'missing-edge':
        segments[0]['edge_id'] = 'UNKNOWN'
    elif case == 'branch':
        segments[0]['edge_id'] = 'ROAD_007'
    elif case == 'repeat':
        segments[1]['edge_id'] = 'ROAD_001'
    elif case == 'too-short':
        segments.pop()
    elif case == 'broken-order':
        segments[1], segments[2] = segments[2], segments[1]
    elif case == 'wrong-start':
        segments[:] = segments[1:] + segments[:1]
    else:
        final = scene_features['ROAD_006']
        final['properties']['to_node'] = 'N7'
        final['geometry']['coordinates'][-1] = scene_features['N7']['geometry']['coordinates'].copy()
    if case == 'reverse-loop':
        scene = loader.load_scene(write_payload(tmp_path, demo_payload))
        assert scene.route_segments == tuple((f'ROAD_{i:03d}', True) for i in range(6, 0, -1))
    else:
        with pytest.raises(SceneValidationError) as exc:
            loader.load_scene(write_payload(tmp_path, demo_payload))
        assert '$.preset_route.segments' in str(exc.value)



def displaced(position, horizontal, vertical=0.0, azimuth=90.0):
    lon, lat, _ = TEST_GEOD.fwd(position[0], position[1], azimuth, horizontal)
    return [lon, lat, position[2] + vertical]


@pytest.mark.parametrize('endpoint,node', [(0, 'N1'), (-1, 'N2')])
@pytest.mark.parametrize('horizontal,vertical,accepted', [(0.02, 0.0, False), (0.0, 0.02, False), (0.008, 0.008, False), (0.005, 0.005, True), (0.0, 0.01, True)])
def test_topology_checks_3d_endpoints(endpoint, node, horizontal, vertical, accepted, tmp_path, demo_payload, scene_features):
    # Ignoring height or testing components separately admits >0.01m 3D gaps.
    exact = scene_features[node]['geometry']['coordinates'].copy()
    scene_features['ROAD_001']['geometry']['coordinates'][endpoint] = displaced(exact, horizontal, vertical)
    if accepted:
        scene = loader.load_scene(write_payload(tmp_path, demo_payload))
        assert scene.road_coordinates['ROAD_001'][endpoint] == tuple(exact)
        assert scene.road_coordinates['ROAD_001'][endpoint] == scene.node_coordinates[node]
        payload_roads = {f['id']: f for f in scene.get_payload()['features']['features']}
        assert payload_roads['ROAD_001']['geometry']['coordinates'][endpoint] == exact
    else:
        with pytest.raises(SceneValidationError) as exc:
            loader.load_scene(write_payload(tmp_path, demo_payload))
        assert 'ROAD_001.geometry.coordinates' in str(exc.value)


@pytest.mark.parametrize('case', ['raw-short', 'normalized-collapse', 'normalized-short', 'vertical-gap', 'shared-ring'])
def test_topology_rechecks_after_normalization(case, tmp_path, demo_payload, scene_features):
    # A tolerated endpoint snap can collapse a previously positive first segment.
    coords = scene_features['ROAD_001']['geometry']['coordinates']
    node = scene_features['N1']['geometry']['coordinates']
    if case == 'raw-short':
        coords.insert(1, displaced(node, 0.0005))
    elif case in {'normalized-collapse', 'normalized-short'}:
        coords[0] = displaced(node, 0.005)
        coords.insert(1, node.copy() if case == 'normalized-collapse' else displaced(node, 0.0005))
        assert TEST_GEOD.inv(*coords[0][:2], *coords[1][:2])[2] > 0.001
    elif case == 'vertical-gap':
        coords[-1][2] += 0.02
    else:
        for road in (scene_features[f'ROAD_{i:03d}'] for i in range(1, 7)):
            road['geometry']['coordinates'][0] = displaced(road['geometry']['coordinates'][0], 0.005, 0.005)
            road['geometry']['coordinates'][-1] = displaced(road['geometry']['coordinates'][-1], 0.005, -0.005, 270.0)
        scene = loader.load_scene(write_payload(tmp_path, demo_payload))
        for i in range(1, 7):
            edge = f'ROAD_{i:03d}'
            end_node = f'N{i + 1}' if i < 6 else 'N1'
            following = f'ROAD_{i + 1:03d}' if i < 6 else 'ROAD_001'
            assert scene.road_coordinates[edge][0] == scene.node_coordinates[f'N{i}']
            assert scene.road_coordinates[edge][-1] == scene.node_coordinates[end_node]
            assert scene.road_coordinates[edge][-1] == scene.road_coordinates[following][0]
        return
    with pytest.raises(SceneValidationError) as exc:
        loader.load_scene(write_payload(tmp_path, demo_payload))
    assert 'ROAD_001.geometry.coordinates' in str(exc.value)


@pytest.mark.parametrize('edge', [f'ROAD_{i:03d}' for i in range(1, 10)])
def test_densification_uses_same_geometry(edge, demo_payload, scene_features):
    # Skipping a source segment, dropping vertices or returning raw API lines fails.
    scene = loader.load_scene(DEMO_PATH)
    dense = scene.road_coordinates[edge]
    raw = scene_features[edge]['geometry']['coordinates']
    expected_count = 1 + sum(math.ceil(TEST_GEOD.inv(*a[:2], *b[:2])[2] / 5.0) for a, b in zip(raw, raw[1:]))
    assert len(dense) == expected_count
    assert dense[0] == tuple(raw[0]) and dense[-1] == tuple(raw[-1])
    assert all(tuple(vertex) in dense for vertex in raw)
    for start, end in zip(dense, dense[1:]):
        assert 0.001 < TEST_GEOD.inv(*start[:2], *end[:2])[2] <= 5.0 + 1e-6
        assert all(math.isfinite(v) for v in end)
    payload_features = {f['id']: f for f in scene.get_payload()['features']['features']}
    assert dense == tuple(tuple(p) for p in payload_features[edge]['geometry']['coordinates'])
    for identifier, feature in scene_features.items():
        actual = payload_features[identifier]
        if identifier.startswith('ROAD_'):
            assert actual['properties'] == feature['properties']
        else:
            assert actual == feature
    assert scene.get_payload()['preset_route'] == demo_payload['preset_route']


@pytest.mark.parametrize('distance,parts', [(0.002, 1), (4.99, 1), (5.01, 2), (10.01, 3)])
def test_densification_segment_count_boundary(distance, parts, tmp_path, demo_payload, scene_features):
    # Floor/round instead of ceil either exceeds 5m or adds unexpected vertices.
    raw = scene_features['ROAD_001']['geometry']['coordinates']
    vertex = displaced(raw[0], distance)
    raw.insert(1, vertex)
    dense = loader.load_scene(write_payload(tmp_path, demo_payload)).road_coordinates['ROAD_001']
    assert dense[parts] == tuple(vertex)
    assert sum(tuple(vertex) == p for p in dense) == 1
    for start, end in zip(dense[:parts + 1], dense[1:parts + 1]):
        assert TEST_GEOD.inv(*start[:2], *end[:2])[2] == pytest.approx(distance / parts, abs=1e-6)


def test_densification_is_readonly(tmp_path, monkeypatch):
    # Snapshot mutation or cwd-dependent loading must never corrupt shared geometry.
    source = DEMO_PATH.read_bytes()
    scene = loader.load_scene(DEMO_PATH)
    pristine = scene.get_payload()
    first = scene.get_payload()
    features = {f['id']: f for f in first['features']['features']}
    features['ROAD_001']['geometry']['coordinates'][1][0] = 0
    features['ROAD_001']['geometry']['coordinates'].clear()
    features['N1']['geometry']['coordinates'][2] = 999
    features['AREA_LOADING']['properties']['name'] = 'changed'
    first['preset_route']['segments'].clear()
    assert scene.get_payload() == pristine
    with pytest.raises(TypeError):
        scene.road_coordinates['ROAD_001'][1][0] = 0
    with pytest.raises(TypeError):
        scene.node_coordinates['N1'][2] = 999
    with pytest.raises(TypeError):
        scene.route_segments[0] = ('ROAD_009', True)
    for field in ('road_coordinates', 'node_coordinates', 'route_segments'):
        with pytest.raises(AttributeError):
            setattr(scene, field, {})
    with pytest.raises(TypeError):
        loader.LoadedScene()
    assert DEMO_PATH.read_bytes() == source
    monkeypatch.chdir(tmp_path)
    again = loader.load_scene(loader.DEFAULT_SCENE_PATH)
    assert again.road_coordinates == scene.road_coordinates
    assert again.node_coordinates == scene.node_coordinates
    assert again.route_segments == scene.route_segments
    assert again.get_payload() == pristine
    assert DEMO_PATH.read_bytes() == source


def ecef(position):
    """Independent WGS84 geodetic-to-ECEF formula, metres."""
    longitude, latitude = map(math.radians, position[:2])
    height = position[2]
    a = 6378137.0
    flattening = 1.0 / 298.257223563
    eccentricity_squared = flattening * (2.0 - flattening)
    normal = a / math.sqrt(1.0 - eccentricity_squared * math.sin(latitude) ** 2)
    return (
        (normal + height) * math.cos(latitude) * math.cos(longitude),
        (normal + height) * math.cos(latitude) * math.sin(longitude),
        (normal * (1.0 - eccentricity_squared) + height) * math.sin(latitude),
    )


def point_segment_distance(point, start, end):
    chord = tuple(b - a for a, b in zip(start, end))
    delta = tuple(p - a for p, a in zip(point, start))
    fraction = max(0.0, min(1.0, sum(d * c for d, c in zip(delta, chord)) / sum(c * c for c in chord)))
    return math.sqrt(sum((d - fraction * c) ** 2 for d, c in zip(delta, chord)))


@pytest.mark.parametrize('edge', [f'ROAD_{i:03d}' for i in range(1, 10)])
def test_densification_matches_geodesic(edge, tmp_path, demo_payload, scene_features):
    # Linear lon/lat, wrong azimuth, or height interpolation fail actual coordinates.
    raw = scene_features[edge]['geometry']['coordinates']
    scene = loader.load_scene(write_payload(tmp_path, demo_payload))
    dense = scene.road_coordinates[edge]
    offset = 0
    for start, end in zip(raw, raw[1:]):
        azimuth, _, distance = TEST_GEOD.inv(*start[:2], *end[:2])
        parts = math.ceil(distance / 5.0)
        for step in range(1, parts):
            position = dense[offset + step]
            actual_azimuth, _, traveled = TEST_GEOD.inv(*start[:2], *position[:2])
            remaining = TEST_GEOD.inv(*position[:2], *end[:2])[2]
            assert traveled == pytest.approx(distance * step / parts, abs=1e-6)
            assert traveled + remaining == pytest.approx(distance, abs=1e-6)
            angle_error = (actual_azimuth - azimuth + 180.0) % 360.0 - 180.0
            assert abs(angle_error) < 1e-6
            assert position[2] == pytest.approx(start[2] + (end[2] - start[2]) * step / parts, abs=1e-10)
        offset += parts
        assert dense[offset] == tuple(end)
    assert offset == len(dense) - 1
    for start, end in zip(dense, dense[1:]):
        azimuth, _, distance = TEST_GEOD.inv(*start[:2], *end[:2])
        lon, lat, _ = TEST_GEOD.fwd(*start[:2], azimuth, distance / 2.0)
        midpoint = (lon, lat, (start[2] + end[2]) / 2.0)
        error = point_segment_distance(ecef(midpoint), ecef(start), ecef(end))
        assert error <= 0.05


@pytest.mark.parametrize('consumer', ['reader', 'loader'])
@pytest.mark.parametrize('target,index,location', [
    ('node', 0, '$.features.features[0].geometry.coordinates[2]'),
    ('road', 8, '$.features.features[8].geometry.coordinates[1][2]'),
    ('area', 18, '$.features.features[18].geometry.coordinates[0][0][2]'),
])
def test_topology_rejects_unrepresentable_height(consumer, target, index, location, tmp_path, demo_payload):
    # Accepting unrepresentable integers leaks arithmetic errors during densification.
    coords = demo_payload['features']['features'][index]['geometry']['coordinates']
    if target == 'node':
        coords[2] = 10**400
    elif target == 'road':
        coords[1][2] = 10**400
    else:
        for position in coords[0]:
            position[2] = 10**400
    read = _read_scene if consumer == 'reader' else loader.load_scene
    with pytest.raises(SceneValidationError) as exc:
        read(write_payload(tmp_path, demo_payload))
    assert location in str(exc.value)
    assert isinstance(exc.value.__cause__, OverflowError)
