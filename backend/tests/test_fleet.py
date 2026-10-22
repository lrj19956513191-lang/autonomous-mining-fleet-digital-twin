"""Fleet contracts: complete snapshots, atomic candidates and physical motion."""

import importlib
import importlib.util
import math
from dataclasses import FrozenInstanceError, replace
from datetime import UTC, datetime
from fractions import Fraction

import pytest

from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS, FleetSimulationError, ParkingWindow
from backend.simulation.route_geometry import compile_route, sample_route
from backend.simulation.route_motion import RouteSimulator
from backend.tests.test_route_geometry import ecef
from backend.tests.test_route_motion import reference_scene, reference_position, route_length

SESSION = '11111111-1111-4111-8111-111111111111'
ROOT_FIELDS = {'schema_version', 'session_id', 'sequence', 'timestamp',
               'simulation_time_seconds', 'vehicles'}
VEHICLE_FIELDS = {'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height',
                  'heading', 'speed', 'soc', 'load', 'status'}


def fleet_module():
    assert importlib.util.find_spec('backend.simulation.fleet') is not None, 'FleetSimulator is missing'
    return importlib.import_module('backend.simulation.fleet')


def make_fleet(scene=None, configs=DEFAULT_VEHICLE_CONFIGS):
    return fleet_module().FleetSimulator(scene or load_scene(DEFAULT_SCENE_PATH),
                                        vehicle_configs=configs, session_id=SESSION)


def assert_position(state, expected):
    actual = ecef(state['longitude'], state['latitude'], state['height'])
    assert math.dist(actual, ecef(*expected)) <= 1e-4


def test_initial_fleet_uses_shared_route(monkeypatch):
    # Recompiling per car, incorrect defaults or leaking mutable responses breaks this.
    module = fleet_module()
    scene = load_scene(DEFAULT_SCENE_PATH)
    calls = []
    real_compile = module.compile_route

    def counted_compile(value):
        calls.append(value)
        return real_compile(value)

    monkeypatch.setattr(module, 'compile_route', counted_compile)
    fleet = make_fleet(scene)
    snap = fleet.get_snapshot()
    assert calls == [scene]
    assert set(snap) == ROOT_FIELDS
    assert snap['schema_version'] == 1
    assert snap['session_id'] == SESSION
    assert snap['sequence'] == 0
    assert snap['simulation_time_seconds'] == 0.0
    assert {v['timestamp'] for v in snap['vehicles']} == {snap['timestamp']}
    assert datetime.fromisoformat(snap['timestamp']).utcoffset().total_seconds() == 0
    route = real_compile(scene)
    for index, vehicle in enumerate(snap['vehicles']):
        expected = sample_route(route, route.length_m * index / 3)
        assert set(vehicle) == VEHICLE_FIELDS
        assert vehicle['vehicle_id'] == f'TRUCK_{index + 1:03}'
        assert_position(vehicle, (expected.longitude, expected.latitude, expected.height))
        assert vehicle['heading'] == pytest.approx(expected.heading)
        assert (vehicle['speed'], vehicle['soc'], vehicle['load'], vehicle['status']) == (
            25.0, (90.0, 80.0, 70.0)[index], (65.0, 40.0, 80.0)[index], 'running')
    assert tuple(snap['vehicles'][0][key] for key in ('longitude', 'latitude', 'height')) == scene.node_coordinates['N1']
    assert fleet.get_vehicle_state('TRUCK_001') == snap['vehicles'][0]
    original = fleet.get_snapshot()
    snap['vehicles'][0]['soc'] = -1
    snap['vehicles'].append({'vehicle_id': 'FAKE'})
    fleet.get_vehicle_state('TRUCK_002')['load'] = -1
    assert fleet.get_snapshot() == original
    with pytest.raises(KeyError):
        fleet.get_vehicle_state('TRUCK_999')


def test_initial_config_geometry_and_committed_records_are_deeply_immutable():
    fleet = make_fleet()
    with pytest.raises((FrozenInstanceError, AttributeError)):
        fleet._committed.sequence = 7
    with pytest.raises((FrozenInstanceError, AttributeError)):
        fleet._committed.vehicles[0].soc = 7
    with pytest.raises(TypeError):
        fleet._committed.vehicles[0] = fleet._committed.vehicles[1]
    with pytest.raises(TypeError):
        fleet._route.segments[0][0][0] = 0
    with pytest.raises((FrozenInstanceError, AttributeError)):
        fleet._configs[1].parking.duration_seconds = 1
    original = fleet.get_snapshot()
    # Even a caller deliberately bypassing frozen config protection cannot alias us.
    configs = tuple(replace(c, parking=replace(c.parking) if c.parking else None)
                    for c in DEFAULT_VEHICLE_CONFIGS)
    other = make_fleet(configs=configs)
    object.__setattr__(configs[0], 'initial_soc', 0)
    object.__setattr__(configs[1].parking, 'duration_seconds', 120)
    assert other.get_snapshot() == {**original, 'timestamp': other.get_snapshot()['timestamp'],
                                  'vehicles': [{**v, 'timestamp': other.get_snapshot()['timestamp']}
                                               for v in original['vehicles']]}


@pytest.mark.parametrize('session', [None, '', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', SESSION + '\n',
                                   '11111111-1111-1111-8111-111111111111',
                                   '11111111-1111-4111-7111-111111111111'])
def test_initial_rejects_noncanonical_uuid4_session(session):
    with pytest.raises(FleetSimulationError):
        fleet_module().FleetSimulator(load_scene(DEFAULT_SCENE_PATH),
            vehicle_configs=DEFAULT_VEHICLE_CONFIGS, session_id=session)



def test_successful_steps_are_one_complete_commit(monkeypatch):
    module = fleet_module()
    ticks = []

    class Clock:
        @staticmethod
        def now(zone):
            assert zone is UTC
            ticks.append(None)
            return datetime(2026, 10, 14, 4, 0, len(ticks), tzinfo=UTC)

    monkeypatch.setattr(module, 'datetime', Clock)
    fleet = make_fleet()
    old = fleet._committed
    initial = fleet.get_snapshot()
    fleet.step()
    snap = fleet.get_snapshot()
    assert snap['sequence'] == 1
    assert snap['simulation_time_seconds'] == 1.0
    assert len(ticks) == 2
    assert {v['timestamp'] for v in snap['vehicles']} == {snap['timestamp']}
    assert snap['timestamp'] != initial['timestamp']
    assert old.sequence == 0 and old.simulation_time_seconds == 0
    assert all(v.mileage_m == 0 for v in old.vehicles)
    for index, vehicle in enumerate(fleet._committed.vehicles):
        assert vehicle.mileage_m == pytest.approx(25 / 3.6)
        assert vehicle.progress_m == pytest.approx(old.vehicles[index].progress_m + 25 / 3.6)
        assert vehicle.soc == pytest.approx((90, 80, 70)[index] - 0.1)
    committed = fleet._committed
    fleet.step(0)
    assert fleet._committed is committed
    assert fleet.get_snapshot() == snap
    assert len(ticks) == 2
    for _ in range(3):
        fleet.get_snapshot()
        fleet.get_vehicle_state('TRUCK_001')
    assert fleet._committed is committed and len(ticks) == 2


@pytest.mark.parametrize('index,start,end,running,status', [
    (1, 59, 60, 1, 'stopped'), (1, 60, 61, 0, 'stopped'),
    (1, 74, 75, 0, 'running'), (1, 75, 76, 1, 'running'),
    (1, 58, 77, 4, 'running'), (2, 89, 90, 1, 'stopped'),
    (2, 90, 91, 0, 'stopped'), (2, 109, 110, 0, 'running'),
    (2, 110, 111, 1, 'running'),
])
def test_parking_boundaries_commit_running_integral(index, start, end, running, status):
    fleet = make_fleet()
    fleet.step(start)
    before = fleet._committed
    fleet.step(end - start)
    after = fleet._committed
    car = after.vehicles[index]
    assert car.mileage_m - before.vehicles[index].mileage_m == pytest.approx(25 / 3.6 * running, abs=1e-10)
    assert car.soc == pytest.approx(before.vehicles[index].soc - 0.1 * running)
    assert car.status == status
    assert car.speed == (0 if status == 'stopped' else 25)
    assert after.vehicles[0].mileage_m - before.vehicles[0].mileage_m == pytest.approx(25 / 3.6 * (end - start))
    assert after.sequence == 2 and after.simulation_time_seconds == end
    if running == 0:
        assert car.sample is before.vehicles[index].sample
        assert car.progress_m == before.vehicles[index].progress_m
        assert car.soc == before.vehicles[index].soc


def test_commit_uses_copied_config_and_soc_zero_keeps_running():
    configs = tuple(replace(c, parking=replace(c.parking) if c.parking else None)
                    for c in DEFAULT_VEHICLE_CONFIGS)
    fleet = make_fleet(configs=configs)
    object.__setattr__(configs[0], 'cruise_speed_kmh', 0)
    object.__setattr__(configs[1].parking, 'duration_seconds', 120)
    fleet.step(61)
    assert fleet.get_vehicle_state('TRUCK_002')['soc'] == pytest.approx(74.0)
    assert fleet._committed.vehicles[0].mileage_m == pytest.approx(61 * 25 / 3.6)
    fleet.step(1000)
    assert fleet.get_vehicle_state('TRUCK_001')['soc'] == 0
    assert fleet.get_vehicle_state('TRUCK_001')['status'] == 'running'
    assert fleet.get_vehicle_state('TRUCK_001')['speed'] == 25


def assert_atomic_failure(fleet, action):
    before = fleet._committed
    snapshot = fleet.get_snapshot()
    individual = [fleet.get_vehicle_state(v['vehicle_id']) for v in snapshot['vehicles']]
    with pytest.raises(FleetSimulationError):
        action()
    assert fleet._committed is before
    assert fleet.get_snapshot() == snapshot
    assert [fleet.get_vehicle_state(v['vehicle_id']) for v in snapshot['vehicles']] == individual
    assert tuple(v.mileage_m for v in fleet._committed.vehicles) == tuple(v.mileage_m for v in before.vehicles)


@pytest.mark.parametrize('index', [0, 1, 2])
@pytest.mark.parametrize('boundary', ['_running_seconds_exact', 'advance_route', 'soc_after', '_status_at_exact'])
def test_fault_in_first_middle_last_candidate_is_atomic(monkeypatch, index, boundary):
    module = fleet_module()
    fleet = make_fleet()
    fleet.step(1)
    real = getattr(module, boundary)
    calls = []

    def fault(*args):
        current = len(calls)
        calls.append(args)
        # Reading during candidate construction must see the complete previous commit.
        assert fleet.get_snapshot()['sequence'] == 1
        if current == index:
            raise module.RouteMotionError('injected real computation boundary failure')
        return real(*args)

    monkeypatch.setattr(module, boundary, fault)
    assert_atomic_failure(fleet, lambda: fleet.step(0.3))
    assert len(calls) == index + 1
    monkeypatch.setattr(module, boundary, real)
    fleet.step(0.3)
    assert fleet.get_snapshot()['sequence'] == 2


@pytest.mark.parametrize('index', [0, 1, 2])
@pytest.mark.parametrize('field,value', [
    ('longitude', float('nan')), ('longitude', 181), ('latitude', -91),
    ('height', float('inf')), ('height', True), ('heading', 360), ('heading', -1),
])
def test_invalid_sample_candidate_is_atomic(monkeypatch, index, field, value):
    module = fleet_module()
    fleet = make_fleet()
    real = module.advance_route
    count = 0

    def bad(*args):
        nonlocal count
        progress, sample = real(*args)
        current, count = count, count + 1
        return (progress, replace(sample, **{field: value})) if current == index else (progress, sample)

    monkeypatch.setattr(module, 'advance_route', bad)
    assert_atomic_failure(fleet, lambda: fleet.step(1))


@pytest.mark.parametrize('index', [0, 1, 2])
@pytest.mark.parametrize('boundary,value', [
    ('_running_seconds_exact', float('nan')), ('_running_seconds_exact', -0.1),
    ('_running_seconds_exact', 2), ('_running_seconds_exact', True),
    ('soc_after', float('nan')), ('soc_after', -1), ('soc_after', 101),
    ('soc_after', True), ('_status_at_exact', 'unknown'),
])
def test_invalid_integral_candidate_is_atomic(monkeypatch, index, boundary, value):
    module = fleet_module()
    fleet = make_fleet()
    real = getattr(module, boundary)
    count = 0

    def bad(*args):
        nonlocal count
        current, count = count, count + 1
        return value if current == index else real(*args)

    monkeypatch.setattr(module, boundary, bad)
    assert_atomic_failure(fleet, lambda: fleet.step(1))


@pytest.mark.parametrize('dt', [-1, float('nan'), float('inf'), True, None, '1', 2**53 + 1])
def test_invalid_dt_is_atomic(dt):
    fleet = make_fleet()
    assert_atomic_failure(fleet, lambda: fleet.step(dt))


@pytest.mark.parametrize('kind', ['time_overflow', 'time_not_increasing', 'time_precision',
                                  'distance_overflow', 'distance_precision', 'mileage_overflow',
                                  'soc_overflow', 'sequence_limit'])
def test_invalid_candidate_and_overflow_are_atomic(kind):
    configs = DEFAULT_VEHICLE_CONFIGS
    if kind in ('distance_overflow', 'distance_precision'):
        configs = (replace(configs[0], cruise_speed_kmh=1e308 if kind == 'distance_overflow' else 1e16),) + configs[1:]
    if kind == 'mileage_overflow':
        configs = (replace(configs[0], cruise_speed_kmh=18.0),) + configs[1:]
    if kind == 'soc_overflow':
        configs = (replace(configs[0], soc_rate=1e308),) + configs[1:]
    fleet = make_fleet(configs=configs)
    dt = 1.0
    if kind == 'time_overflow':
        fleet._committed = replace(fleet._committed, simulation_time_seconds=1e308, time_exact=Fraction(1e308))
        dt = 1e308
    elif kind == 'time_not_increasing':
        fleet._committed = replace(fleet._committed, simulation_time_seconds=2**53, time_exact=Fraction(2**53))
    elif kind == 'time_precision':
        fleet._committed = replace(fleet._committed, simulation_time_seconds=1e9, time_exact=Fraction(1e9))
        dt = 0.3
    elif kind in ('distance_overflow', 'soc_overflow'):
        dt = 100
    elif kind == 'mileage_overflow':
        first = replace(fleet._committed.vehicles[0], mileage_m=1.7976931348623157e308, mileage_exact=Fraction(1.7976931348623157e308))
        fleet._committed = replace(fleet._committed, vehicles=(first,) + fleet._committed.vehicles[1:])
        dt = float(2**1020)
    elif kind == 'sequence_limit':
        fleet._committed = replace(fleet._committed, sequence=9007199254740991)
    assert_atomic_failure(fleet, lambda: fleet.step(dt))


@pytest.mark.parametrize('stamp', ['2026-02-30T04:00:00+00:00', '2026-10-14T04:00:00',
                                  '2026-10-14T04:00:00+01:00', '2026-10-14T04:00:00+00:00\n'])
def test_invalid_timestamp_is_atomic(monkeypatch, stamp):
    fleet = make_fleet()

    class BadClock:
        @staticmethod
        def now(zone):
            return BadClock()

        def isoformat(self):
            return stamp

    monkeypatch.setattr(fleet_module(), 'datetime', BadClock)
    assert_atomic_failure(fleet, lambda: fleet.step(1))


@pytest.mark.parametrize('index', [0, 1, 2])
@pytest.mark.parametrize('progress', [float('nan'), -1, 1e100, True])
def test_invalid_progress_candidate_is_atomic(monkeypatch, index, progress):
    module = fleet_module()
    fleet = make_fleet()
    real = module.advance_route
    count = 0

    def bad(*args):
        nonlocal count
        wrapped, sample = real(*args)
        current, count = count, count + 1
        return (progress if current == index else wrapped), sample

    monkeypatch.setattr(module, 'advance_route', bad)
    assert_atomic_failure(fleet, lambda: fleet.step(1))



def independent_running(duration, stop, length):
    # Test oracle deliberately enumerates stop windows; production uses O(1) cycles.
    stopped = sum(max(0, min(duration, cycle + stop + length) - (cycle + stop))
                  for cycle in range(0, math.ceil(duration), 120))
    return duration - stopped


@pytest.mark.parametrize('parts', [(1.0,) * 480 + (0.375,), (0.3,) * 1201,
                                  (0.1, 0.2, 0.3, 0.4, 0.7) * 250])
def test_long_short_steps_equivalent(parts):
    scene = load_scene(DEFAULT_SCENE_PATH)
    one, many = make_fleet(scene), make_fleet(scene)
    duration = float(sum(map(Fraction, parts)))
    one.step(duration)
    for part in parts:
        many.step(part)
    long, short = one.get_snapshot(), many.get_snapshot()
    assert abs(long['simulation_time_seconds'] - short['simulation_time_seconds']) <= 1e-8
    expected_running = (duration, independent_running(duration, 60, 15),
                        independent_running(duration, 90, 20))
    length = route_length(scene)
    for index, (a, b) in enumerate(zip(long['vehicles'], short['vehicles'])):
        running = expected_running[index]
        expected_distance = 25 / 3.6 * running
        expected_progress = (length * index / 3 + expected_distance) % length
        for fleet, state in ((one, a), (many, b)):
            assert fleet._committed.vehicles[index].mileage_m == pytest.approx(expected_distance, abs=1e-5)
            actual_progress = fleet._committed.vehicles[index].progress_m
            delta = abs(actual_progress - expected_progress)
            assert min(delta, length - delta) <= 1e-5
            assert state['soc'] == pytest.approx(max(0, (90, 80, 70)[index] - 0.1 * running), abs=1e-8)
            assert_position(state, reference_position(scene, length * index / 3 + expected_distance))
        assert math.dist(ecef(*(a[key] for key in ('longitude', 'latitude', 'height'))),
                         ecef(*(b[key] for key in ('longitude', 'latitude', 'height')))) <= 1e-4
        assert a['status'] == b['status'] and a['speed'] == b['speed']
    assert long['sequence'] == 1 and short['sequence'] == len(parts)


def test_physical_equator_steps_equivalent(reference_scene):
    # Analytic equatorial arc and linear height oracle use no Geod sampling.
    configs = tuple(replace(c, initial_progress_fraction=0, cruise_speed_kmh=(6, 12, 18)[i],
                            parking=None) for i, c in enumerate(DEFAULT_VEHICLE_CONFIGS))
    fleet = make_fleet(reference_scene, configs)
    fleet.step(7)
    fleet.step(0.3)
    for index, vehicle in enumerate(fleet.get_snapshot()['vehicles']):
        distance = (6, 12, 18)[index] / 3.6 * 7.3
        east_length = 6378137.0 * math.radians(0.001)
        assert_position(vehicle, (math.degrees(distance / 6378137.0), 0.0,
                                  50 + 30 * distance / east_length))
        assert vehicle['heading'] == pytest.approx(90.0, abs=1e-8)


def test_legacy_truck_projection_equivalent():
    scene = load_scene(DEFAULT_SCENE_PATH)
    fleet, legacy = make_fleet(scene), RouteSimulator(scene)
    for dt in (0.1, 0.2, 0.3, 59.4, 61, 400.25):
        fleet.step(dt)
        legacy.step(dt)
        a, b = fleet.get_vehicle_state('TRUCK_001'), legacy.get_state()
        for field in ('longitude', 'latitude', 'height', 'heading', 'speed', 'soc', 'load'):
            assert a[field] == pytest.approx(b[field], rel=0, abs=1e-8)
        assert a['vehicle_id'] == b['vehicle_id'] and a['status'] == b['status']



@pytest.mark.parametrize('index', [0, 1, 2])
def test_initial_parking_at_zero_honors_window_and_recovery(index):
    # A constructor hardcoding running disagrees with the same legal window on step.
    defaults = make_fleet().get_snapshot()['vehicles']
    assert [(v['status'], v['speed'], v['soc'], v['load']) for v in defaults] == [
        ('running', 25.0, 90.0, 65.0), ('running', 25.0, 80.0, 40.0),
        ('running', 25.0, 70.0, 80.0),
    ]
    configs = tuple(replace(c, parking=ParkingWindow(120.0, 0.0, 15.0)) if i == index else c
                    for i, c in enumerate(DEFAULT_VEHICLE_CONFIGS))
    fleet = make_fleet(configs=configs)
    vehicle_id = configs[index].vehicle_id
    initial = fleet.get_snapshot()
    initial_vehicle = fleet.get_vehicle_state(vehicle_id)
    assert initial['sequence'] == 0 and initial['simulation_time_seconds'] == 0.0
    assert initial_vehicle['status'] == 'stopped'
    assert initial_vehicle['speed'] == 0.0
    committed = fleet._committed
    fleet.step(0)
    assert fleet._committed is committed and fleet.get_snapshot() == initial
    fleet.step(1)
    stopped = fleet.get_vehicle_state(vehicle_id)
    for field in ('longitude', 'latitude', 'height', 'heading', 'soc', 'load', 'status', 'speed'):
        assert stopped[field] == initial_vehicle[field]
    assert fleet._committed.vehicles[index].mileage_m == 0
    fleet.step(14)
    recovered = fleet.get_vehicle_state(vehicle_id)
    assert recovered['status'] == 'running' and recovered['speed'] == 25.0
    for field in ('longitude', 'latitude', 'height', 'heading', 'soc', 'load'):
        assert recovered[field] == initial_vehicle[field]
    assert fleet._committed.vehicles[index].mileage_m == 0
    fleet.step(1)
    moving = fleet.get_vehicle_state(vehicle_id)
    assert moving['status'] == 'running' and moving['speed'] == 25.0
    assert moving['soc'] == pytest.approx(initial_vehicle['soc'] - 0.1)
    assert fleet._committed.vehicles[index].mileage_m == pytest.approx(25 / 3.6)
    assert fleet.get_snapshot()['sequence'] == 3
    assert fleet.get_snapshot()['simulation_time_seconds'] == 16.0


def exact_fractional_parts(target):
    """The input floats sum to target exactly, rather than approximately in decimal."""
    parts = [0.3] * (int(float(target) / 0.3) - 1)
    remainder = target - sum(map(Fraction, parts), Fraction(0))
    if Fraction(float(remainder)) != remainder:
        # At 110s the first remainder straddles a binary64 binade; one more
        # 0.3 step makes the exact remainder representable, without rounding it.
        parts.append(0.3)
        remainder -= Fraction(0.3)
    parts.append(float(remainder))
    assert sum(map(Fraction, parts), Fraction(0)) == target
    assert all(part > 0 for part in parts)
    return parts


def assert_exact_time_equivalence(target, parts, long_parts=None):
    # Repeated rounded-time addition or using published time for parking breaks this.
    scene = load_scene(DEFAULT_SCENE_PATH)
    one, many = make_fleet(scene), make_fleet(scene)
    long_parts = [float(target)] if long_parts is None else long_parts
    assert sum(map(Fraction, long_parts), Fraction(0)) == target
    for part in long_parts:
        one.step(part)
    for part in parts:
        many.step(part)
    long, short = one.get_snapshot(), many.get_snapshot()
    length = route_length(scene)
    for index, (a, b) in enumerate(zip(long['vehicles'], short['vehicles'])):
        stopped = index > 0 and (60, 90)[index - 1] <= target % 120 < (75, 110)[index - 1]
        expected_status, expected_speed = ('stopped', 0.0) if stopped else ('running', 25.0)
        assert (a['status'], a['speed']) == (expected_status, expected_speed)
        assert (b['status'], b['speed']) == (expected_status, expected_speed)
        running = target if index == 0 else independent_running(target, (60, 90)[index - 1], (15, 20)[index - 1])
        distance = float(Fraction(125, 18) * running)
        expected_progress = (length * index / 3 + distance) % length
        expected_soc = float(max(Fraction(0), Fraction((90, 80, 70)[index]) - Fraction(0.1) * running))
        for fleet, state in ((one, a), (many, b)):
            vehicle = fleet._committed.vehicles[index]
            assert abs(vehicle.mileage_m - distance) <= 1e-5
            delta = abs(vehicle.progress_m - expected_progress)
            assert min(delta, abs(length - delta)) <= 1e-5
            assert abs(state['soc'] - expected_soc) <= 1e-8
            assert_position(state, reference_position(scene, length * index / 3 + distance))
        assert math.dist(ecef(*(a[k] for k in ('longitude', 'latitude', 'height'))),
                         ecef(*(b[k] for k in ('longitude', 'latitude', 'height')))) <= 1e-4
    assert one._committed.time_exact == many._committed.time_exact == target
    assert long['simulation_time_seconds'] == short['simulation_time_seconds'] == float(target)
    assert long['sequence'] == len(long_parts) and short['sequence'] == len(parts)
    for snap in (long, short):
        assert snap['session_id'] == SESSION
        assert {v['timestamp'] for v in snap['vehicles']} == {snap['timestamp']}
        assert datetime.fromisoformat(snap['timestamp']).utcoffset().total_seconds() == 0
    return one, many


@pytest.mark.parametrize('target', [60, 75])
def test_exact_fractional_boundary_reproduction(target):
    target = Fraction(target)
    assert_exact_time_equivalence(target, exact_fractional_parts(target))


@pytest.mark.parametrize('cycle', [0, 1, 3])
@pytest.mark.parametrize('boundary', [60, 75, 90, 110])
@pytest.mark.parametrize('side', [-1, 0, 1])
def test_exact_fractional_repeated_boundaries(cycle, boundary, side):
    target = float(120 * cycle + boundary)
    if side:
        target = math.nextafter(target, math.inf if side > 0 else -math.inf)
    target = Fraction(target)
    assert_exact_time_equivalence(target, exact_fractional_parts(target))


@pytest.mark.parametrize('cycle', [0, 1])
@pytest.mark.parametrize('boundary', [60, 75, 90, 110])
@pytest.mark.parametrize('side', [-1, 1])
def test_exact_endpoint_distinguishes_times_with_same_published_float(cycle, boundary, side):
    # Choosing the published float as the status clock misclassifies one side.
    boundary += 120 * cycle
    offset = Fraction(side, 2**52)
    target = Fraction(boundary) + offset
    assert float(target) == boundary
    coarse = [boundary - 0.5, float(Fraction(1, 2) + offset)]
    assert_exact_time_equivalence(target, exact_fractional_parts(target), coarse)


@pytest.mark.parametrize('index,start,duration', [(1, 60, 15), (2, 90, 20)])
@pytest.mark.parametrize('cycle', [0, 1, 3])
def test_exact_fractional_full_stop_preserves_motion_and_soc(index, start, duration, cycle):
    # A rounded start just before a stop produces a spurious positive running interval.
    fleet = make_fleet()
    target = Fraction(start + 120 * cycle)
    for part in exact_fractional_parts(target):
        fleet.step(part)
    before = fleet._committed
    fleet.step(duration)
    after = fleet._committed
    a, b = before.vehicles[index], after.vehicles[index]
    assert b.sample is a.sample
    assert (b.progress_m, b.mileage_m, b.soc) == (a.progress_m, a.mileage_m, a.soc)
    assert (b.status, b.speed) == ('running', 25.0)
    assert after.time_exact == target + duration
    assert after.simulation_time_seconds == float(target + duration)
    assert after.sequence == before.sequence + 1


def test_fractional_commits_keep_noop_invalid_and_safe_sequence_atomic(monkeypatch):
    # An invalid/zero step must not consume UTC or mutate the precise time source.
    fleet = make_fleet()
    for _ in range(17):
        fleet.step(0.3)
    calls = []

    class Clock:
        @staticmethod
        def now(zone):
            calls.append(zone)
            return datetime.now(zone)

    monkeypatch.setattr(fleet_module(), 'datetime', Clock)
    before = fleet._committed
    snapshot = fleet.get_snapshot()
    for zero in (0, 0.0):
        fleet.step(zero)
        assert fleet._committed is before and fleet.get_snapshot() == snapshot
    for bad in (-1, True, None, '1', math.nan, math.inf, Fraction(1, 2),
                2**53 + 1, 1e308, 2**-100):
        assert_atomic_failure(fleet, lambda: fleet.step(bad))
    assert calls == []
    fleet._committed = replace(before, sequence=9007199254740990)
    fleet.step(0.3)
    assert fleet.get_snapshot()['sequence'] == 9007199254740991
    assert fleet._committed.time_exact == before.time_exact + Fraction(0.3)
    assert calls == [UTC]
    last = fleet._committed
    fleet.step(0)
    assert fleet._committed is last
    assert_atomic_failure(fleet, lambda: fleet.step(0.3))
    assert calls == [UTC]
