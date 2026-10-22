"""Pure route contracts checked against independent WGS84 numeric references."""

import importlib
import json
import math
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime

import pytest
from pyproj import Geod

from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.simulation.route_motion import RouteSimulator
from backend.tests.test_route_motion import reference_scene

REFERENCE_GEOD = Geod(ellps='WGS84')


def geometry_module():
    return importlib.import_module('backend.simulation.route_geometry')


def ecef(longitude, latitude, height):
    # Explicit WGS84 ellipsoid conversion, independent of production sampling.
    lon, lat = math.radians(longitude), math.radians(latitude)
    a, flattening = 6378137.0, 1 / 298.257223563
    eccentricity_sq = flattening * (2 - flattening)
    normal = a / math.sqrt(1 - eccentricity_sq * math.sin(lat)**2)
    return (
        (normal + height) * math.cos(lat) * math.cos(lon),
        (normal + height) * math.cos(lat) * math.sin(lon),
        (normal * (1 - eccentricity_sq) + height) * math.sin(lat),
    )


def assert_position(sample, expected):
    actual = ecef(sample.longitude, sample.latitude, sample.height)
    assert math.dist(actual, ecef(*expected)) <= 1e-4


def test_compilation_and_sampling_match_legacy(reference_scene):
    # Wrong mileage units, slope distance, reverse heading or adapter defaults fail.
    module = geometry_module()
    route = module.compile_route(reference_scene)
    assert module.sample_route(route, 0).longitude == reference_scene.node_coordinates['N1'][0]
    assert module.sample_route(route, route.length_m) == module.sample_route(route, 0)
    # The equator oracle uses its radius directly, without the shared algorithm.
    east_length = 6378137.0 * math.radians(0.001)
    for distance in (0.0, 19.1, 55.0, east_length / 2):
        sample = module.sample_route(route, distance)
        assert_position(sample, (math.degrees(distance / 6378137.0), 0.0,
                                 50.0 + 30.0 * distance / east_length))
        assert sample.heading == pytest.approx(90.0, abs=1e-8)
        progress, advanced = module.advance_route(route, 7.0, distance)
        assert progress == pytest.approx(7.0 + distance, abs=1e-10)
        assert_position(advanced, (math.degrees((7.0 + distance) / 6378137.0),
                                   0.0, 50.0 + 30.0 * (7.0 + distance) / east_length))
        legacy = RouteSimulator(reference_scene, speed_kmh=3.6)
        legacy.step(distance)
        state = legacy.get_state()
        assert_position(sample, (state['longitude'], state['latitude'], state['height']))
        assert state['heading'] == sample.heading
    # Exact-node semantics use the processed cumulative boundary, while the
    # analytic oracle above independently checks physical coordinates.
    node_mileage = route.cumulative_m[len(reference_scene.road_coordinates['ROAD_001']) - 1]
    assert node_mileage == pytest.approx(east_length, rel=0, abs=1e-10)
    node = module.sample_route(route, node_mileage)
    assert (node.longitude, node.latitude, node.height) == reference_scene.node_coordinates['N2']
    assert node.heading == pytest.approx(0.0, abs=1e-8)
    before = datetime.now(UTC)
    legacy = RouteSimulator(reference_scene)
    after = datetime.now(UTC)
    state = legacy.get_state()
    assert set(state) == {'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height',
                          'heading', 'speed', 'soc', 'load', 'status'}
    assert state['vehicle_id'] == 'TRUCK_001'
    assert (state['soc'], state['load'], state['status'], state['speed']) == (90.0, 65.0, 'running', 25.0)
    timestamp = datetime.fromisoformat(state['timestamp'])
    assert timestamp.utcoffset().total_seconds() == 0
    assert before <= timestamp <= after
    stopped_speed = RouteSimulator(reference_scene, speed_kmh=0)
    stopped_speed.step(2.5)
    assert stopped_speed.get_state()['soc'] == pytest.approx(89.75)
    assert stopped_speed.get_state()['status'] == 'running'


def test_shared_route_is_readonly():
    # Mutable geometry would allow one future consumer to move another's route.
    module = geometry_module()
    route = module.compile_route(load_scene(DEFAULT_SCENE_PATH))
    sample = module.sample_route(route, 0)
    with pytest.raises(FrozenInstanceError):
        route.length_m = 1.0
    with pytest.raises(FrozenInstanceError):
        sample.heading = 0.0
    with pytest.raises(TypeError):
        route.cumulative_m[1] = 0.0
    with pytest.raises(TypeError):
        route.segments[0][0][0] = 0.0
    assert all(end > start for start, end in zip(route.cumulative_m, route.cumulative_m[1:]))
    assert route.cumulative_m[-1] == route.length_m


@pytest.mark.parametrize('bad_length', [float('nan'), float('inf'), 0.0, -1.0])
def test_compile_rejects_invalid_geodesic_lengths(bad_length, reference_scene, monkeypatch):
    # Bad geodesic results must never become a compiled route usable by consumers.
    module = geometry_module()

    class FaultyGeod:
        def inv(self, *args):
            azimuth, back, _ = REFERENCE_GEOD.inv(*args)
            return azimuth, back, bad_length

    monkeypatch.setattr(module, '_GEOD', FaultyGeod())
    with pytest.raises(module.RouteMotionError):
        module.compile_route(reference_scene)



@pytest.mark.parametrize('reverse', [False, True], ids=['forward', 'reversed'])
def test_route_and_fleet_share_one_sampler(reverse, tmp_path, demo_payload, monkeypatch):
    # Independent consumers must see the same immutable geometry, without a clock,
    # HTTP dependency, loader subdivision or endpoint-only reversal.
    if reverse:
        demo_payload['preset_route']['segments'] = [
            {'edge_id': f'ROAD_{i:03d}', 'reverse': True} for i in range(6, 0, -1)
        ]
    path = tmp_path / 'shared-route.json'
    path.write_text(json.dumps(demo_payload), encoding='utf-8')
    scene = load_scene(path)
    payload_before = scene.get_payload()
    module = geometry_module()
    route = module.compile_route(scene)
    before = (route.length_m, route.segments, route.cumulative_m)
    legacy = RouteSimulator(scene, speed_kmh=3.6)

    class UnavailableClock:
        @classmethod
        def now(cls, tz):
            raise AssertionError('Pure route computation must not read UTC')

    monkeypatch.setattr('backend.simulation.route_motion.datetime', UnavailableClock)
    cumulative, count = 0.0, 0
    for edge_id, reversed_edge in scene.route_segments:
        coordinates = scene.road_coordinates[edge_id]
        if reversed_edge:
            coordinates = tuple(reversed(coordinates))
        for start, end in zip(coordinates, coordinates[1:]):
            azimuth, _, length = REFERENCE_GEOD.inv(*start[:2], *end[:2])
            # Retains every processed point and its height in traversal order.
            assert route.segments[count][:2] == (start, end)
            assert route.cumulative_m[count] == pytest.approx(cumulative, rel=0, abs=1e-8)
            exact = module.sample_route(route, route.cumulative_m[count])
            assert (exact.longitude, exact.latitude, exact.height) == start
            assert exact.heading == pytest.approx(azimuth % 360, abs=1e-8)
            for fraction in (0.27, 0.5, 0.89):
                distance = cumulative + fraction * length
                lon, lat, _ = REFERENCE_GEOD.fwd(*start[:2], azimuth, fraction * length)
                height = start[2] + fraction * (end[2] - start[2])
                direct = module.sample_route(route, distance)
                assert_position(direct, (lon, lat, height))
                outgoing = REFERENCE_GEOD.inv(lon, lat, *end[:2])[0] % 360
                assert abs((direct.heading - outgoing + 180) % 360 - 180) <= 1e-5
                progress, shared = module.advance_route(route, 0.0, distance)
                assert progress == pytest.approx(distance, abs=1e-8)
                assert shared == direct
            cumulative += length
            count += 1
    assert route.length_m == pytest.approx(cumulative, rel=0, abs=1e-8)
    assert len(route.segments) == count
    assert len(route.cumulative_m) == count + 1
    assert all(b > a for a, b in zip(route.cumulative_m, route.cumulative_m[1:]))
    for progress in (0.0, route.length_m / 3, 2 * route.length_m / 3):
        mileage, sample = module.advance_route(route, progress, 2 * route.length_m + 19.1)
        assert mileage == pytest.approx((progress + 19.1) % route.length_m, abs=1e-8)
        assert sample == module.sample_route(route, mileage)
    assert module.sample_route(route, route.length_m) == module.sample_route(route, 0.0)
    assert legacy.get_state()['longitude'] == scene.node_coordinates['N1'][0]
    assert (route.length_m, route.segments, route.cumulative_m) == before
    assert scene.get_payload() == payload_before
    motion = importlib.import_module('backend.simulation.route_motion')
    assert motion.RouteMotionError is module.RouteMotionError


@pytest.mark.parametrize(
    'bad', [-1.0, True, '1', None, float('nan'), float('inf'), 10**400],
    ids=['negative', 'bool', 'string', 'none', 'nan', 'inf', 'unrepresentable-integer'],
)
@pytest.mark.parametrize('operation', ['sample', 'progress', 'distance'])
def test_pure_core_rejects_invalid_mileage(operation, bad, reference_scene):
    # New entry points must not admit bools, negatives or nonrepresentable mileage.
    module = geometry_module()
    route = module.compile_route(reference_scene)
    before = module.sample_route(route, 19.1)
    with pytest.raises(module.RouteMotionError):
        if operation == 'sample':
            module.sample_route(route, bad)
        elif operation == 'progress':
            module.advance_route(route, bad, 1.0)
        else:
            module.advance_route(route, 1.0, bad)
    assert module.sample_route(route, 19.1) == before


def test_pure_advance_rejects_overflow(reference_scene):
    # Modulo must not hide overflow of two individually finite inputs.
    module = geometry_module()
    route = module.compile_route(reference_scene)
    with pytest.raises(module.RouteMotionError):
        module.advance_route(route, 1e308, 1e308)
    assert_position(module.sample_route(route, 19.1),
                    (math.degrees(19.1 / 6378137), 0.0,
                     50 + 30 * 19.1 / (6378137 * math.radians(0.001))))
