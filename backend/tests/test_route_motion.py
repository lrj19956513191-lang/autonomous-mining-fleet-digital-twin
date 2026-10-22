"""Behavioral route-motion checks against independently measured WGS84 geometry."""

import importlib
import json
import math
from datetime import UTC, datetime

import pytest
from pyproj import Geod

from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene

REFERENCE_GEOD = Geod(ellps='WGS84')


def motion_module():
    try:
        return importlib.import_module('backend.simulation.route_motion')
    except ModuleNotFoundError as exc:
        pytest.fail(f'Required route_motion module is unavailable: {exc}')


def test_initial_state_uses_route_start():
    # Catches hard-coded coordinates/heading and changes to the telemetry contract.
    scene = load_scene(DEFAULT_SCENE_PATH)
    before = datetime.now(UTC)
    simulator = motion_module().RouteSimulator(scene)
    after = datetime.now(UTC)
    state = simulator.get_state()
    assert set(state) == {
        'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height',
        'heading', 'speed', 'soc', 'load', 'status',
    }
    assert state['vehicle_id'] == 'TRUCK_001'
    assert state['status'] == 'running'
    assert (state['longitude'], state['latitude'], state['height']) == scene.node_coordinates['N1']
    assert (state['speed'], state['soc'], state['load']) == (25.0, 90.0, 65.0)
    first = scene.road_coordinates['ROAD_001']
    forward = REFERENCE_GEOD.inv(*first[0][:2], *first[1][:2])[0] % 360
    assert state['heading'] == pytest.approx(forward, abs=1e-10)
    assert state['heading'] != 45.0
    timestamp = datetime.fromisoformat(state['timestamp'])
    assert timestamp.tzinfo is not None
    assert timestamp.utcoffset().total_seconds() == 0
    assert before <= timestamp <= after


@pytest.fixture
def reference_scene(tmp_path, demo_payload):
    """A small equator/meridian loop, still validated as the full 21-feature profile."""

    nodes = {
        'N1': [0.0, 0.0, 50.0], 'N2': [0.001, 0.0, 80.0],
        'N3': [0.001, 0.001, 54.0], 'N4': [0.0, 0.001, 56.0],
        'N5': [0.0, 0.0007, 53.0], 'N6': [0.0, 0.0003, 51.0],
        'N7': [0.0005, 0.0005, 52.0], 'N8': [-0.0005, 0.0003, 50.0],
    }
    features = {f['id']: f for f in demo_payload['features']['features']}
    for identifier, position in nodes.items():
        features[identifier]['geometry']['coordinates'] = position.copy()
    for identifier, feature in features.items():
        if identifier.startswith('ROAD_'):
            props = feature['properties']
            feature['geometry']['coordinates'] = [
                nodes[props['from_node']].copy(), nodes[props['to_node']].copy(),
            ]
    rectangles = {
        'MINE_BOUNDARY': (-0.002, -0.002, 0.002, 0.002),
        'AREA_LOADING': (-0.0018, -0.0018, -0.0012, -0.0012),
        'AREA_DUMPING': (0.0012, -0.0018, 0.0018, -0.0012),
        'AREA_FACILITY': (-0.0018, 0.0012, -0.0012, 0.0018),
    }
    for identifier, (west, south, east, north) in rectangles.items():
        features[identifier]['geometry']['coordinates'] = [[
            [west, south, 45.0], [east, south, 45.0], [east, north, 45.0],
            [west, north, 45.0], [west, south, 45.0],
        ]]
    path = tmp_path / 'reference.json'
    path.write_text(json.dumps(demo_payload), encoding='utf-8')
    return load_scene(path)


def route_measurements(scene):
    """Independent test-side length measurements; never reads simulator internals."""
    cumulative = 0.0
    for edge_id, reverse in scene.route_segments:
        positions = scene.road_coordinates[edge_id]
        if reverse:
            positions = positions[::-1]
        for start, end in zip(positions, positions[1:]):
            length = REFERENCE_GEOD.inv(*start[:2], *end[:2])[2]
            yield cumulative, start, end, length
            cumulative += length


def position(state):
    return state['longitude'], state['latitude'], state['height']


def angle_difference(actual, expected):
    return (actual - expected + 180.0) % 360.0 - 180.0


def test_step_moves_25_kmh_along_route(reference_scene):
    # Degree increments, 3D slope length, wrong units, or accumulated speed error fail.

    simulator = motion_module().RouteSimulator(reference_scene)
    for seconds in range(1, 9):
        simulator.step()
        state = simulator.get_state()
        distance = 6378137.0 * math.radians(state['longitude'])
        assert abs(distance - seconds * 25.0 / 3.6) <= 1e-6
        assert abs(state['latitude']) < 1e-12
        assert state['heading'] == pytest.approx(90.0, abs=1e-8)
        assert state['soc'] == pytest.approx(90.0 - 0.1 * seconds)


def test_geodesic_interpolation_and_height():
    # Linear lon/lat, wrong height fraction, and back azimuth fail physical checks.
    scene = load_scene(DEFAULT_SCENE_PATH)
    for cumulative, start, end, length in route_measurements(scene):
        for fraction in (0.27, 0.5, 0.89):
            simulator = motion_module().RouteSimulator(scene, speed_kmh=3.6)
            simulator.step(cumulative + fraction * length)
            state = simulator.get_state()
            measured = REFERENCE_GEOD.inv(*start[:2], *position(state)[:2])[2]
            remaining = REFERENCE_GEOD.inv(*position(state)[:2], *end[:2])[2]
            assert abs(measured - fraction * length) <= 0.01
            assert abs(measured + remaining - length) <= 0.01
            assert state['height'] == pytest.approx(
                (1.0 - fraction) * start[2] + fraction * end[2], rel=0, abs=1e-6,
            )
            forward = REFERENCE_GEOD.inv(*position(state)[:2], *end[:2])[0] % 360
            assert abs(angle_difference(state['heading'], forward)) <= 1e-5
            assert 0.0 <= state['heading'] < 360.0


def test_node_uses_outgoing_heading(reference_scene):
    # bisect_left, back azimuth, and zero-offset round trips lose exact nodes.
    for scene in (reference_scene, load_scene(DEFAULT_SCENE_PATH)):
        for cumulative, start, end, _ in route_measurements(scene):
            if cumulative == 0.0:
                continue
            simulator = motion_module().RouteSimulator(scene, speed_kmh=3.6)
            simulator.step(cumulative)
            state = simulator.get_state()
            assert position(state) == start
            forward = REFERENCE_GEOD.inv(*start[:2], *end[:2])[0] % 360
            assert abs(angle_difference(state['heading'], forward)) < 1e-8
    cardinal = {'N2': 0.0, 'N3': 270.0, 'N4': 180.0, 'N5': 180.0, 'N6': 180.0}
    for cumulative, start, _, _ in route_measurements(reference_scene):
        for node, expected in cardinal.items():
            if start == reference_scene.node_coordinates[node]:
                simulator = motion_module().RouteSimulator(reference_scene, speed_kmh=3.6)
                simulator.step(cumulative)
                assert abs(angle_difference(simulator.get_state()['heading'], expected)) < 1e-5


def route_length(scene):
    last = list(route_measurements(scene))[-1]
    return last[0] + last[3]


def reference_position(scene, distance):
    # Linear scan reference is independent of the simulator's indexed lookup.
    remainder = distance % route_length(scene)
    for cumulative, start, end, length in route_measurements(scene):
        if cumulative + length > remainder:
            offset = remainder - cumulative
            azimuth = REFERENCE_GEOD.inv(*start[:2], *end[:2])[0]
            lon, lat, _ = REFERENCE_GEOD.fwd(*start[:2], azimuth, offset)
            height = start[2] + (end[2] - start[2]) * (offset / length)
            return lon, lat, height
    raise AssertionError('Reference remainder was outside the closed route')


def test_step_crosses_segments_and_multiple_laps(reference_scene):
    # Single-segment updates or per-frame lon/lat increments cannot cross corners/laps.
    simulator = motion_module().RouteSimulator(reference_scene, speed_kmh=3.6)
    first_road = reference_scene.road_coordinates['ROAD_001']
    first_length = sum(REFERENCE_GEOD.inv(*a[:2], *b[:2])[2] for a, b in zip(first_road, first_road[1:]))
    elapsed = 0.0
    for dt in (16.3, first_length + 8.2, 2 * route_length(reference_scene) + 19.1):
        simulator.step(dt)
        elapsed += dt
        expected = reference_position(reference_scene, elapsed)
        actual = position(simulator.get_state())
        assert REFERENCE_GEOD.inv(*actual[:2], *expected[:2])[2] <= 1e-6
        assert actual[2] == pytest.approx(expected[2], rel=0, abs=1e-6)
    # This case stays on the equator after two complete laps, permitting a formula oracle.
    simulator = motion_module().RouteSimulator(reference_scene, speed_kmh=3.6)
    simulator.step(2 * route_length(reference_scene) + 19.1)
    assert 6378137.0 * math.radians(simulator.get_state()['longitude']) == pytest.approx(19.1, abs=1e-6)


def test_closed_route_limits_converge_to_n1():
    # A dropped closure, end-of-route teleport, or bad height slope fails both limits.
    scene = load_scene(DEFAULT_SCENE_PATH)
    lengths = list(route_measurements(scene))
    total = route_length(scene)
    n1 = scene.node_coordinates['N1']
    errors = []
    for epsilon in (0.1, 0.01):
        side_errors = []
        for distance, segment in ((total - epsilon, lengths[-1]), (epsilon, lengths[0])):
            simulator = motion_module().RouteSimulator(scene, speed_kmh=3.6)
            simulator.step(distance)
            actual = position(simulator.get_state())
            horizontal = REFERENCE_GEOD.inv(*n1[:2], *actual[:2])[2]
            slope = abs(segment[2][2] - segment[1][2]) / segment[3]
            assert horizontal <= epsilon + 0.001
            assert abs(actual[2] - n1[2]) <= slope * epsilon + 1e-6
            side_errors.append(horizontal)
        errors.append(side_errors)
    assert all(small < large for small, large in zip(errors[1], errors[0]))
    simulator = motion_module().RouteSimulator(scene, speed_kmh=3.6)
    simulator.step(total)
    assert position(simulator.get_state()) == n1
    forward = REFERENCE_GEOD.inv(*lengths[0][1][:2], *lengths[0][2][:2])[0] % 360
    assert simulator.get_state()['heading'] == pytest.approx(forward, abs=1e-10)


def test_route_reverses_entire_coordinate_sequence(tmp_path, demo_payload):
    # Reversing just endpoints, omitting heights, or sorting roads gives wrong motion.
    demo_payload['preset_route']['segments'] = [
        {'edge_id': f'ROAD_{i:03d}', 'reverse': True} for i in range(6, 0, -1)
    ]
    path = tmp_path / 'reversed.json'
    path.write_text(json.dumps(demo_payload), encoding='utf-8')
    scene = load_scene(path)
    simulator = motion_module().RouteSimulator(scene, speed_kmh=3.6)
    assert position(simulator.get_state()) == scene.node_coordinates['N1']
    for cumulative, start, end, length in route_measurements(scene):
        simulator = motion_module().RouteSimulator(scene, speed_kmh=3.6)
        simulator.step(cumulative + 0.37 * length)
        actual = position(simulator.get_state())
        assert REFERENCE_GEOD.inv(*start[:2], *actual[:2])[2] == pytest.approx(0.37 * length, abs=0.01)
        assert actual[2] == pytest.approx(start[2] + 0.37 * (end[2] - start[2]), abs=1e-6)
        heading = REFERENCE_GEOD.inv(*actual[:2], *end[:2])[0] % 360
        assert abs(angle_difference(simulator.get_state()['heading'], heading)) <= 1e-5


@pytest.fixture
def controlled_clock(monkeypatch):
    class Clock:
        current = datetime(2026, 10, 10, 1, 0, 0, tzinfo=UTC)

        @classmethod
        def now(cls, tz):
            return cls.current.astimezone(tz)

    monkeypatch.setattr(motion_module(), 'datetime', Clock)
    return Clock


INVALID_PARAMETERS = [
    pytest.param(-1, id='negative'), pytest.param(True, id='bool'),
    pytest.param('1', id='string'), pytest.param(None, id='none'),
    pytest.param(float('nan'), id='nan'), pytest.param(float('inf'), id='inf'),
    pytest.param(float('-inf'), id='negative-inf'),
    pytest.param(10**400, id='unrepresentable-integer'),
]


@pytest.mark.parametrize('dt', [pytest.param(0, id='zero'), *INVALID_PARAMETERS, pytest.param(1e308, id='product-overflow')])
def test_dt_zero_and_invalid_parameters(dt, reference_scene, controlled_clock):
    # An invalid/no-op call must preserve public state AND the next valid motion.
    module = motion_module()
    simulator = module.RouteSimulator(reference_scene)
    control = module.RouteSimulator(reference_scene)
    simulator.step(2.75)
    control.step(2.75)
    before = simulator.get_state()
    controlled_clock.current = datetime(2026, 10, 10, 1, 0, 1, tzinfo=UTC)
    if dt == 0:
        assert simulator.step(dt) is None
    else:
        with pytest.raises(module.RouteMotionError):
            simulator.step(dt)
    assert simulator.get_state() == before
    simulator.step(0.4)
    control.step(0.4)
    assert simulator.get_state() == control.get_state()


@pytest.mark.parametrize('speed', INVALID_PARAMETERS)
def test_constructor_rejects_invalid_speed(speed, reference_scene):
    with pytest.raises(motion_module().RouteMotionError):
        motion_module().RouteSimulator(reference_scene, speed_kmh=speed)


def test_finite_speed_product_overflow_is_atomic(reference_scene, controlled_clock):
    # Overflowing speed*dt must not reach modulo or commit hidden progress.
    module = motion_module()
    simulator = module.RouteSimulator(reference_scene, speed_kmh=1e308)
    control = module.RouteSimulator(reference_scene, speed_kmh=1e308)
    simulator.step(1e-307)
    control.step(1e-307)
    before = simulator.get_state()
    with pytest.raises(module.RouteMotionError):
        simulator.step(10.0)
    assert simulator.get_state() == before
    simulator.step(1e-307)
    control.step(1e-307)
    assert simulator.get_state() == control.get_state()


def test_zero_speed_and_soc_floor(reference_scene, controlled_clock):
    simulator = motion_module().RouteSimulator(reference_scene, speed_kmh=0)
    initial = simulator.get_state()
    controlled_clock.current = datetime(2026, 10, 10, 1, 0, 2, tzinfo=UTC)
    simulator.step(2.0)
    state = simulator.get_state()
    assert position(state) == position(initial)
    assert state['heading'] == initial['heading']
    assert state['soc'] == pytest.approx(89.8)
    assert state['timestamp'] == '2026-10-10T01:00:02+00:00'
    assert state['speed'] == 0.0
    for dt in (1000.0, 1e308):
        simulator.step(dt)
        state = simulator.get_state()
        assert state['soc'] == pytest.approx(0.0)
        assert position(state) == position(initial)
        assert state['status'] == 'running'
        assert state['load'] == 65.0
    moving = motion_module().RouteSimulator(reference_scene)
    moving.step(1000.0)
    assert moving.get_state()['soc'] == pytest.approx(0.0)
    assert moving.get_state()['status'] == 'running'


def test_readonly_snapshot_and_utc_clock(reference_scene, controlled_clock):
    # Getter side effects, shared dictionaries, and naive/stale timestamps fail.
    simulator = motion_module().RouteSimulator(reference_scene)
    before = simulator.get_state()
    changed = simulator.get_state()
    changed.update(longitude=999.0, soc=-9.0, timestamp='invalid', status='changed')
    controlled_clock.current = datetime(2026, 10, 10, 1, 0, 3, tzinfo=UTC)
    for _ in range(10):
        assert simulator.get_state() == before
    simulator.step(1.25)
    after = simulator.get_state()
    assert before['timestamp'] == '2026-10-10T01:00:00+00:00'
    assert after['timestamp'] == '2026-10-10T01:00:03+00:00'
    timestamp = datetime.fromisoformat(after['timestamp'])
    assert timestamp.tzinfo is not None and timestamp.utcoffset().total_seconds() == 0
    assert after['soc'] == pytest.approx(89.875)
    assert simulator.get_state() == after


@pytest.mark.parametrize('fault', ['nan-length', 'infinite-length', 'zero-length', 'negative-length', 'nan-bearing', 'total-overflow', 'nonincreasing-total'])
def test_invalid_compiled_lengths_are_atomic(fault, reference_scene, monkeypatch):
    # Numerical defense only: validated scenes never intentionally contain bad lengths.
    class FaultyGeod:
        count = 0

        def inv(self, *args):
            self.count += 1
            azimuth, back, length = REFERENCE_GEOD.inv(*args)
            if fault == 'nan-bearing':
                azimuth = float('nan')
            elif fault == 'total-overflow':
                length = 1.7e308
            elif fault == 'nonincreasing-total':
                length = 1e100 if self.count == 1 else 1.0
            else:
                length = {'nan-length': float('nan'), 'infinite-length': float('inf'),
                          'zero-length': 0.0, 'negative-length': -1.0}[fault]
            return azimuth, back, length

    module = motion_module()
    monkeypatch.setattr(importlib.import_module('backend.simulation.route_geometry'), '_GEOD', FaultyGeod())
    with pytest.raises(module.RouteMotionError):
        module.RouteSimulator(reference_scene)


@pytest.mark.parametrize('coordinate,bad', [(0, float('nan')), (1, float('inf')), (2, float('-inf'))], ids=['longitude-nan', 'latitude-inf', 'heading-inf'])
def test_nonfinite_candidate_preserves_state_and_progress(coordinate, bad, reference_scene, controlled_clock, monkeypatch):
    # Precommitting mileage or any candidate value breaks recovery against the control.
    module = motion_module()
    simulator = module.RouteSimulator(reference_scene)
    control = module.RouteSimulator(reference_scene)
    simulator.step(3.25)
    control.step(3.25)
    before = simulator.get_state()
    controlled_clock.current = datetime(2026, 10, 10, 1, 0, 4, tzinfo=UTC)

    class FaultyGeod:
        def fwd(self, *args, **kwargs):
            result = list(REFERENCE_GEOD.fwd(*args, **kwargs))
            result[coordinate] = bad
            return tuple(result)

    with monkeypatch.context() as patch:
        patch.setattr(importlib.import_module('backend.simulation.route_geometry'), '_GEOD', FaultyGeod())
        with pytest.raises(module.RouteMotionError):
            simulator.step(5.5)
        assert simulator.get_state() == before
    simulator.step(0.7)
    control.step(0.7)
    assert simulator.get_state() == control.get_state()


def test_progress_addition_overflow_is_atomic(reference_scene, controlled_clock, monkeypatch):
    # Both operands are finite, but existing positive mileage plus advance overflows.
    module = motion_module()

    class LargeLengthGeod:
        def inv(self, *args):
            azimuth, back, _ = REFERENCE_GEOD.inv(*args)
            return azimuth, back, 1e305

        def fwd(self, lon, lat, azimuth, distance, **kwargs):
            return REFERENCE_GEOD.fwd(lon, lat, azimuth, distance % 4.0, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(importlib.import_module('backend.simulation.route_geometry'), '_GEOD', LargeLengthGeod())
        simulator = module.RouteSimulator(reference_scene, speed_kmh=3.6)
        control = module.RouteSimulator(reference_scene, speed_kmh=3.6)
        # Exact count of processed small segments determines the intentionally huge loop.
        prior = 0.9 * len(list(route_measurements(reference_scene))) * 1e305
        simulator.step(prior)
        control.step(prior)
        before = simulator.get_state()
        with pytest.raises(module.RouteMotionError):
            simulator.step(1.79e308)
        assert simulator.get_state() == before
        simulator.step(1e305)
        control.step(1e305)
        assert simulator.get_state() == control.get_state()
