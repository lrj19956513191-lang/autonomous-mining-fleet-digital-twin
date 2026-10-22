"""Immutable fleet configuration and pure simulated-time parking/SOC helpers."""

import math
import re
from dataclasses import dataclass
from fractions import Fraction


_TIME_ERROR_BUDGET = Fraction(1, 100_000_000)


class FleetSimulationError(ValueError):
    """Invalid configuration or a candidate that cannot be represented safely."""


@dataclass(frozen=True, slots=True)
class ParkingWindow:
    period_seconds: float
    start_seconds: float
    duration_seconds: float


@dataclass(frozen=True, slots=True)
class VehicleConfig:
    vehicle_id: str
    route_id: str
    initial_progress_fraction: float
    cruise_speed_kmh: float
    initial_soc: float
    load: float
    soc_rate: float
    parking: ParkingWindow | None


DEFAULT_VEHICLE_CONFIGS: tuple[VehicleConfig, ...] = (
    VehicleConfig('TRUCK_001', 'ROUTE_001', 0.0, 25.0, 90.0, 65.0, 0.1, None),
    VehicleConfig('TRUCK_002', 'ROUTE_001', 1 / 3, 25.0, 80.0, 40.0, 0.1,
                  ParkingWindow(120.0, 60.0, 15.0)),
    VehicleConfig('TRUCK_003', 'ROUTE_001', 2 / 3, 25.0, 70.0, 80.0, 0.1,
                  ParkingWindow(120.0, 90.0, 20.0)),
)


def _number(value: float, name: str, *, nonnegative: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FleetSimulationError(f'{name} must be a finite int or float')
    try:
        number = float(value)
    except (ValueError, OverflowError) as cause:
        raise FleetSimulationError(f'{name} must be representable as float') from cause
    if not math.isfinite(number) or (nonnegative and number < 0):
        raise FleetSimulationError(f'{name} must be finite' + (' and nonnegative' if nonnegative else ''))
    if isinstance(value, int) and number != value:
        raise FleetSimulationError(f'{name} loses precision when converted to float')
    return number


def _parking_values(parking: ParkingWindow) -> tuple[float, float, float]:
    if not isinstance(parking, ParkingWindow):
        raise FleetSimulationError('parking must be a ParkingWindow or None')
    period = _number(parking.period_seconds, 'parking period')
    start = _number(parking.start_seconds, 'parking start')
    duration = _number(parking.duration_seconds, 'parking duration')
    if period <= 0 or duration <= 0 or Fraction(start) + Fraction(duration) > Fraction(period):
        raise FleetSimulationError('parking requires positive period/duration and start + duration <= period')
    return period, start, duration


def validate_vehicle_configs(configs: tuple[VehicleConfig, ...]) -> None:
    """Validate a frozen configuration collection, including its legacy vehicle."""
    if not isinstance(configs, tuple):
        raise FleetSimulationError('vehicle configs must be a tuple')
    seen: set[str] = set()
    for config in configs:
        if not isinstance(config, VehicleConfig):
            raise FleetSimulationError('each vehicle config must be a VehicleConfig')
        if not isinstance(config.vehicle_id, str) or re.fullmatch(r'TRUCK_[0-9]{3}', config.vehicle_id) is None:
            raise FleetSimulationError('vehicle_id must fully match TRUCK_ plus three ASCII digits')
        if config.vehicle_id in seen:
            raise FleetSimulationError('vehicle IDs must be unique')
        seen.add(config.vehicle_id)
        if config.route_id != 'ROUTE_001':
            raise FleetSimulationError('only ROUTE_001 is supported')
        if _number(config.initial_progress_fraction, 'initial progress') >= 1:
            raise FleetSimulationError('initial progress must be in [0, 1)')
        _number(config.cruise_speed_kmh, 'cruise speed')
        if _number(config.initial_soc, 'initial SOC') > 100:
            raise FleetSimulationError('initial SOC must be in [0, 100]')
        _number(config.load, 'load', nonnegative=False)
        _number(config.soc_rate, 'SOC rate')
        if config.parking is not None:
            _parking_values(config.parking)
    if 'TRUCK_001' not in seen:
        raise FleetSimulationError('vehicle configs must include TRUCK_001')


def running_seconds(parking: ParkingWindow | None, start: float, dt: float) -> float:
    """Integrate [start, start + dt) using two local pieces and whole cycles.

    Exact binary-rational local arithmetic avoids both large-prefix cancellation
    and cycle-count rounding. There is no loop proportional to dt/period.
    """
    start = _number(start, 'start')
    dt = _number(dt, 'dt')
    end = start + dt
    if not math.isfinite(end) or (dt > 0 and end <= start):
        raise FleetSimulationError('positive dt must produce a finite, increasing time')
    _check_rounding(end, Fraction(start) + Fraction(dt), _TIME_ERROR_BUDGET, 'time sum')
    return _running_seconds_exact(parking, Fraction(start), dt)


def _running_seconds_exact(parking: ParkingWindow | None, start: Fraction, dt: float) -> float:
    """Integrate from validated exact cumulative time, rounding only the result.

    Callers validate public numbers and certify their published endpoint. Both
    public local intervals and fleet intervals share this one parking algorithm.
    """
    if parking is None:
        return dt
    period_value, stop_value, duration_value = _parking_values(parking)
    period, stop, duration = map(Fraction, (period_value, stop_value, duration_value))
    span = Fraction(dt)
    phase = start % period
    first = min(span, period - phase)

    def local_running(offset: Fraction, length: Fraction) -> Fraction:
        overlap = max(Fraction(0), min(offset + length, stop + duration) - max(offset, stop))
        return length - overlap

    remaining = span - first
    cycles, tail = divmod(remaining, period)
    running = local_running(phase, first) + cycles * (period - duration) + local_running(Fraction(0), tail)
    result = float(running)
    _check_rounding(result, running, _TIME_ERROR_BUDGET, 'running seconds')
    # Nearest rounding is monotone; 0 and dt are representable endpoints.
    # Since exact running lies in [0, dt], so does result: no clamp is needed.
    if not 0 <= result <= dt:
        raise FleetSimulationError('running seconds must be in [0, dt]')
    return result


def status_at(parking: ParkingWindow | None, time: float) -> str:
    """Return the endpoint status; the stopped interval excludes its end."""
    time = _number(time, 'time')
    return _status_at_exact(parking, Fraction(time))


def _status_at_exact(parking: ParkingWindow | None, time: Fraction) -> str:
    """Classify the same exact time used by interval integration."""
    if parking is None:
        return 'running'
    period, start, duration = map(Fraction, _parking_values(parking))
    phase = time % period
    return 'stopped' if start <= phase < start + duration else 'running'



def _check_rounding(result: float, exact: Fraction, budget: Fraction, name: str) -> None:
    """Certify the actual rounding error, stronger than a half-ULP estimate.

    Rational operations are exact. The sole result conversion rounds to nearest
    binary64 (error <= half an ULP). An exact comparison with the original
    rational value also accepts huge but exactly representable values safely.
    """
    if not math.isfinite(result) or abs(Fraction(result) - exact) > budget:
        raise FleetSimulationError(f'{name} exceeds the representable error budget')


def soc_after(soc: float, rate: float, running: float) -> float:
    """Build a finite SOC candidate using actual running seconds, with floor 0."""
    soc = _number(soc, 'SOC')
    rate = _number(rate, 'SOC rate')
    running = _number(running, 'running seconds')
    if soc > 100:
        raise FleetSimulationError('SOC must be in [0, 100]')
    consumed = rate * running
    if not math.isfinite(consumed):
        raise FleetSimulationError('SOC consumption must be finite before applying the floor')
    result = max(0.0, soc - consumed)
    exact = max(Fraction(0), Fraction(soc) - Fraction(rate) * Fraction(running))
    _check_rounding(result, exact, Fraction(1, 100_000_000), 'SOC')
    return result
