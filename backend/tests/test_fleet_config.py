"""Fleet configuration and parking contracts with an independent interval oracle."""

import importlib
import math
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import pytest


def fleet_module():
    return importlib.import_module('backend.simulation.fleet_config')


def test_defaults_and_config_validation():
    # Wrong defaults, mutable config, partial IDs or permissive numeric validation fail.
    module = fleet_module()
    configs = module.DEFAULT_VEHICLE_CONFIGS
    assert isinstance(configs, tuple)
    assert [(v.vehicle_id, v.route_id, v.initial_progress_fraction,
             v.cruise_speed_kmh, v.initial_soc, v.load, v.soc_rate) for v in configs] == [
        ('TRUCK_001', 'ROUTE_001', 0.0, 25.0, 90.0, 65.0, 0.1),
        ('TRUCK_002', 'ROUTE_001', 1 / 3, 25.0, 80.0, 40.0, 0.1),
        ('TRUCK_003', 'ROUTE_001', 2 / 3, 25.0, 70.0, 80.0, 0.1),
    ]
    assert configs[0].parking is None
    assert configs[1].parking == module.ParkingWindow(120.0, 60.0, 15.0)
    assert configs[2].parking == module.ParkingWindow(120.0, 90.0, 20.0)
    assert module.validate_vehicle_configs(configs) is None
    five = configs + tuple(replace(configs[0], vehicle_id=f'TRUCK_{i:03d}') for i in (4, 5))
    assert module.validate_vehicle_configs(five) is None
    assert module.validate_vehicle_configs((replace(configs[0], cruise_speed_kmh=0,
                                                    soc_rate=0, initial_soc=0, load=-4),)) is None
    assert module.validate_vehicle_configs((replace(configs[0], initial_soc=100),)) is None
    with pytest.raises(FrozenInstanceError):
        configs[0].load = 4
    with pytest.raises(FrozenInstanceError):
        configs[1].parking.start_seconds = 4
    for invalid in ((), configs[1:], configs + (configs[0],), list(configs), (object(),)):
        with pytest.raises(module.FleetSimulationError):
            module.validate_vehicle_configs(invalid)
    for field, values in {
        'vehicle_id': ('TRUCK_01', 'TRUCK_0001', 'TRUCK_001\n', 'TRUCK_001 ', 1, 'TRUCK_１２３'),
        'route_id': ('ROUTE_002', 'ROUTE_001\n', None),
        'initial_progress_fraction': (-0.1, 1, True, '0', math.nan, math.inf),
        'cruise_speed_kmh': (-1, True, '25', math.nan, math.inf),
        'initial_soc': (-1, 101, True, '90', math.nan, math.inf),
        'load': (True, '65', math.nan, math.inf),
        'soc_rate': (-1, True, '0.1', math.nan, math.inf),
        'parking': (False, (), object()),
    }.items():
        for value in values:
            with pytest.raises(module.FleetSimulationError):
                module.validate_vehicle_configs((replace(configs[0], **{field: value}),))
    for window in (module.ParkingWindow(0, 0, 1), module.ParkingWindow(-1, 0, 1),
                   module.ParkingWindow(120, -1, 1), module.ParkingWindow(120, 0, 0),
                   module.ParkingWindow(120, 110, 11), module.ParkingWindow(120, 0, -1)):
        with pytest.raises(module.FleetSimulationError):
            module.validate_vehicle_configs((replace(configs[0], parking=window),))
    for field in ('period_seconds', 'start_seconds', 'duration_seconds'):
        for value in (True, '1', math.nan, math.inf):
            with pytest.raises(module.FleetSimulationError):
                module.validate_vehicle_configs((replace(configs[0], parking=replace(
                    configs[1].parking, **{field: value})),))
    huge = replace(configs[0], load=10**1000)
    with pytest.raises(module.FleetSimulationError) as exc:
        module.validate_vehicle_configs((huge,))
    assert isinstance(exc.value.__cause__, OverflowError)


def decimal_running_reference(window, start, dt):
    # Enumerate intersecting stopped intervals in Decimal; never use production
    # prefix/decomposition logic or production status to derive the expectation.
    from decimal import Decimal, ROUND_FLOOR, localcontext

    with localcontext() as context:
        context.prec = 80
        t, span = Decimal.from_float(float(start)), Decimal.from_float(float(dt))
        period = Decimal.from_float(float(window.period_seconds))
        parking_start = Decimal.from_float(float(window.start_seconds))
        duration = Decimal.from_float(float(window.duration_seconds))
        end, stopped = t + span, Decimal(0)
        first = int((t / period).to_integral_value(rounding=ROUND_FLOOR))
        last = int((end / period).to_integral_value(rounding=ROUND_FLOOR))
        for cycle in range(first, last + 1):
            stop_start = cycle * period + parking_start
            stopped += max(Decimal(0), min(end, stop_start + duration) - max(t, stop_start))
        return float(span - stopped)


def test_running_duration_boundaries_and_repeated_cycles():
    # Start/endpoint-only integration, closed parking ends or hardcoded periods fail.
    module = fleet_module()
    window2, window3 = (v.parking for v in module.DEFAULT_VEHICLE_CONFIGS[1:])
    for window, intervals in (
        (window2, ((59, 1, 1), (60, 1, 0), (74, 1, 0), (75, 1, 1), (58, 19, 4))),
        (window3, ((89, 1, 1), (90, 1, 0), (109, 1, 0), (110, 1, 1))),
    ):
        for start, dt, expected in intervals:
            assert module.running_seconds(window, start, dt) == expected
            assert module.running_seconds(window, start + 120, dt) == expected
        for start, dt in ((0, 360), (58, 419), (117, 3601), (240, 120), (75, 45)):
            assert module.running_seconds(window, start, dt) == decimal_running_reference(window, start, dt)
    assert module.status_at(window2, 59) == 'running'
    assert module.status_at(window2, 60) == 'stopped'
    assert module.status_at(window2, 74) == 'stopped'
    assert module.status_at(window2, 75) == 'running'
    assert module.status_at(window3, 90) == 'stopped'
    assert module.status_at(window3, 110) == 'running'
    assert module.status_at(window2, 180) == 'stopped'
    assert module.status_at(window2, 195) == 'running'
    assert module.status_at(None, 0) == 'running'
    assert module.running_seconds(None, 60, 12000000) == 12000000
    assert module.running_seconds(window2, 0, 12000000) == 10500000
    assert module.running_seconds(window3, 0, 12000000) == 10000000
    for window in (module.ParkingWindow(7, 0, 7), module.ParkingWindow(7, 0, 2),
                   module.ParkingWindow(7, 5, 2)):
        for start, dt in ((0, 1), (5, 5), (6, 19), (1, 35)):
            assert module.running_seconds(window, start, dt) == decimal_running_reference(window, start, dt)


@pytest.mark.parametrize('start,dt', [(0.2, 0.1), (59.9, 0.2), (74.9, 0.2),
                                     (1000019.9, 0.2), (1000000.2, 0.1), (60, 0)])
def test_fractional_time_precision(start, dt):
    # Losing small dt at large t or subtracting huge prefixes fails this oracle.
    module = fleet_module()
    for window in (module.DEFAULT_VEHICLE_CONFIGS[1].parking,
                   module.ParkingWindow(0.7, 0.2, 0.1)):
        actual = module.running_seconds(window, start, dt)
        assert 0 <= actual <= dt
        assert actual == pytest.approx(decimal_running_reference(window, start, dt), rel=0, abs=1e-10)
    assert module.running_seconds(None, start, dt) == dt


@pytest.mark.parametrize('value', [True, '1', None, math.nan, math.inf, -math.inf, -1, 10**1000])
def test_precision_rejects_invalid_time(value):
    module = fleet_module()
    for window in (None, module.DEFAULT_VEHICLE_CONFIGS[1].parking):
        with pytest.raises(module.FleetSimulationError):
            module.running_seconds(window, value, 1)
        with pytest.raises(module.FleetSimulationError):
            module.running_seconds(window, 0, value)
        with pytest.raises(module.FleetSimulationError):
            module.status_at(window, value)


@pytest.mark.parametrize('start,dt', [(2**53, 1), (1e308, 1e308), (1e10, 0.1)])
def test_precision_rejects_unrepresentable_time_sum(start, dt):
    module = fleet_module()
    for window in (None, module.DEFAULT_VEHICLE_CONFIGS[1].parking):
        with pytest.raises(module.FleetSimulationError):
            module.running_seconds(window, start, dt)


def test_precision_rejects_running_roundoff_outside_time_budget():
    module = fleet_module()
    # Exact binary 1/3 times 1e9 produces a running total whose nearest float
    # differs by >1e-8s, although the time sum itself is exact and increasing.
    with pytest.raises(module.FleetSimulationError):
        module.running_seconds(module.ParkingWindow(1, 0, 1 / 3), 0, 1e9)
    # Rounding must not make an invalid parking window appear to fit.
    bad = module.ParkingWindow(1, 1, 1e-20)
    for operation in (lambda: module.running_seconds(bad, 0, 1),
                      lambda: module.status_at(bad, 0),
                      lambda: module.validate_vehicle_configs((replace(
                          module.DEFAULT_VEHICLE_CONFIGS[0], parking=bad),))):
        with pytest.raises(module.FleetSimulationError):
            operation()


def test_fractional_time_precision_and_soc():
    # SOC must consume only real running seconds and never mutate input load.
    module = fleet_module()
    config = module.DEFAULT_VEHICLE_CONFIGS[1]
    assert module.soc_after(80, 0.1, module.running_seconds(config.parking, 58, 19)) == pytest.approx(79.6, rel=0, abs=1e-8)
    assert module.soc_after(80, 0.1, module.running_seconds(config.parking, 60, 15)) == 80
    assert module.soc_after(0, 0.1, 1) == 0
    assert module.soc_after(1, 0.1, 100) == 0
    assert module.soc_after(80, 0, 1e100) == 80
    assert module.soc_after(80, 0.1, 0) == 80
    assert config.load == 40
    long_run = module.running_seconds(config.parking, 58, 419)
    short_run, soc, t = 0.0, 80.0, 58.0
    for _ in range(4190):
        running = module.running_seconds(config.parking, t, 0.1)
        short_run += running
        soc = module.soc_after(soc, 0.1, running)
        t += 0.1
    assert short_run == pytest.approx(long_run, rel=0, abs=1e-8)
    assert soc == pytest.approx(module.soc_after(80, 0.1, long_run), rel=0, abs=1e-8)
    for argument in ('soc', 'rate', 'running'):
        for bad in (True, '1', None, math.nan, math.inf, -math.inf, -1, 10**1000):
            values = dict(soc=80, rate=0.1, running=1)
            values[argument] = bad
            with pytest.raises(module.FleetSimulationError):
                module.soc_after(**values)
    with pytest.raises(module.FleetSimulationError):
        module.soc_after(101, 0.1, 1)
    with pytest.raises(module.FleetSimulationError):
        module.soc_after(1, 1e308, 1e308)
    with pytest.raises(module.FleetSimulationError) as exc:
        module.soc_after(80, 10**1000, 1)
    assert isinstance(exc.value.__cause__, OverflowError)


def test_precision_rejects_lossy_integer_conversion():
    module = fleet_module()
    # A representable time sum cannot certify the original integer after a
    # silent int-to-float conversion has already removed one simulated second.
    lossy = 2**53 + 1
    for operation in (lambda: module.running_seconds(None, lossy, 2),
                      lambda: module.running_seconds(None, 0, lossy),
                      lambda: module.status_at(module.DEFAULT_VEHICLE_CONFIGS[1].parking, lossy)):
        with pytest.raises(module.FleetSimulationError):
            operation()


@pytest.mark.parametrize('value', [Fraction(0), Fraction(1), Fraction(3, 10)])
def test_public_time_helpers_reject_fraction_inputs(value):
    # Internal rational time support must not widen the public int/float contract.
    module = fleet_module()
    for parking in (None, module.DEFAULT_VEHICLE_CONFIGS[1].parking):
        for action in (lambda: module.running_seconds(parking, value, 1),
                       lambda: module.running_seconds(parking, 0, value),
                       lambda: module.status_at(parking, value)):
            with pytest.raises(module.FleetSimulationError):
                action()
