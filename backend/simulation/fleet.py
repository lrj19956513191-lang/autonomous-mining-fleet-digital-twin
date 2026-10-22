"""A fleet advances by replacing one deeply immutable committed snapshot."""

import math
import re
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from datetime import datetime as _CalendarDateTime
from fractions import Fraction

from backend.scene.loader import LoadedScene
from backend.simulation.fleet_config import (
    FleetSimulationError, VehicleConfig, _number, _running_seconds_exact, soc_after,
    _status_at_exact, validate_vehicle_configs,
)
from backend.simulation.route_geometry import (
    RouteMotionError, RouteSample, advance_route, compile_route, sample_route,
)

_MAX_SEQUENCE = 9007199254740991
_TIME_BUDGET = Fraction(1, 100_000_000)
_DISTANCE_BUDGET = Fraction(1, 100_000)


@dataclass(frozen=True, slots=True)
class _Vehicle:
    vehicle_id: str
    progress_m: float
    mileage_m: float
    sample: RouteSample
    speed: float
    soc: float
    load: float
    status: str
    mileage_exact: Fraction = Fraction(0)
    distance_error: Fraction = Fraction(0)
    soc_exact: Fraction = Fraction(0)
    soc_error: Fraction = Fraction(0)


@dataclass(frozen=True, slots=True)
class _Committed:
    session_id: str
    sequence: int
    timestamp: str
    simulation_time_seconds: float
    vehicles: tuple[_Vehicle, ...]
    time_exact: Fraction = Fraction(0)


def _certify(value: float, exact: Fraction, budget: Fraction, name: str,
             uncertainty: Fraction = Fraction(0)) -> None:
    value = _number(value, name)
    if abs(Fraction(value) - exact) + uncertainty > budget:
        raise FleetSimulationError(f'{name} exceeds the representable error budget')


def _timestamp() -> str:
    value = datetime.now(UTC).isoformat()
    if not isinstance(value, str) or re.fullmatch(
        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        r'(\.[0-9]{1,6})?\+00:00', value,
    ) is None:
        raise FleetSimulationError('timestamp must be an ISO UTC timestamp')
    try:
        _CalendarDateTime.fromisoformat(value)
    except ValueError as cause:
        raise FleetSimulationError('timestamp must be a valid calendar date') from cause
    return value


def _validate_vehicle(vehicle: _Vehicle, length: float) -> None:
    progress = _number(vehicle.progress_m, 'progress')
    _number(vehicle.mileage_m, 'mileage')
    if progress >= length:
        raise FleetSimulationError('progress must lie on the closed route')
    if not isinstance(vehicle.sample, RouteSample):
        raise FleetSimulationError('candidate must contain a RouteSample')
    sample = vehicle.sample
    longitude = _number(sample.longitude, 'longitude', nonnegative=False)
    latitude = _number(sample.latitude, 'latitude', nonnegative=False)
    _number(sample.height, 'height', nonnegative=False)
    heading = _number(sample.heading, 'heading')
    speed = _number(vehicle.speed, 'speed')
    soc = _number(vehicle.soc, 'SOC')
    _number(vehicle.load, 'load', nonnegative=False)
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90 or heading >= 360:
        raise FleetSimulationError('candidate coordinate or heading is out of range')
    if soc > 100 or vehicle.status not in ('running', 'stopped'):
        raise FleetSimulationError('candidate SOC or status is invalid')
    if vehicle.status == 'stopped' and speed != 0:
        raise FleetSimulationError('stopped vehicle must have zero speed')


class FleetSimulator:
    def __init__(self, scene: LoadedScene, *,
                 vehicle_configs: tuple[VehicleConfig, ...], session_id: str) -> None:
        if not isinstance(session_id, str) or re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
            session_id,
        ) is None:
            raise FleetSimulationError('session_id must be a canonical lowercase UUIDv4')
        validate_vehicle_configs(vehicle_configs)
        self._configs = deepcopy(vehicle_configs)
        try:
            self._route = compile_route(scene)
            vehicles = []
            for config in self._configs:
                progress = self._route.length_m * config.initial_progress_fraction
                _certify(progress, Fraction(self._route.length_m) * Fraction(config.initial_progress_fraction),
                         _DISTANCE_BUDGET, 'initial progress')
                status = _status_at_exact(config.parking, Fraction(0))
                speed = float(config.cruise_speed_kmh) if status == 'running' else 0.0
                vehicle = _Vehicle(
                    config.vehicle_id, progress, 0.0, sample_route(self._route, progress),
                    speed, float(config.initial_soc),
                    float(config.load), status, soc_exact=Fraction(config.initial_soc),
                )
                _validate_vehicle(vehicle, self._route.length_m)
                vehicles.append(vehicle)
            committed = _Committed(session_id, 0, _timestamp(), 0.0, tuple(vehicles))
        except (RouteMotionError, OverflowError, TypeError) as cause:
            raise FleetSimulationError(str(cause)) from cause
        self._committed = committed

    @staticmethod
    def _vehicle_payload(vehicle: _Vehicle, timestamp: str) -> dict[str, object]:
        return {
            'vehicle_id': vehicle.vehicle_id, 'timestamp': timestamp,
            'longitude': vehicle.sample.longitude, 'latitude': vehicle.sample.latitude,
            'height': vehicle.sample.height, 'heading': vehicle.sample.heading,
            'speed': vehicle.speed, 'soc': vehicle.soc, 'load': vehicle.load,
            'status': vehicle.status,
        }

    def get_snapshot(self) -> dict[str, object]:
        committed = self._committed
        return {
            'schema_version': 1, 'session_id': committed.session_id,
            'sequence': committed.sequence, 'timestamp': committed.timestamp,
            'simulation_time_seconds': committed.simulation_time_seconds,
            'vehicles': [self._vehicle_payload(v, committed.timestamp) for v in committed.vehicles],
        }

    def get_vehicle_state(self, vehicle_id: str) -> dict[str, object]:
        committed = self._committed
        for vehicle in committed.vehicles:
            if vehicle.vehicle_id == vehicle_id:
                return self._vehicle_payload(vehicle, committed.timestamp)
        raise KeyError(vehicle_id)

    def step(self, dt: float = 1.0) -> None:
        dt = _number(dt, 'dt')
        if dt == 0.0:
            return
        previous = self._committed
        if previous.sequence >= _MAX_SEQUENCE:
            raise FleetSimulationError('sequence limit reached')
        try:
            exact_end = previous.time_exact + Fraction(dt)
            end = float(exact_end)
            if not math.isfinite(end) or end <= previous.simulation_time_seconds:
                raise FleetSimulationError('positive dt must produce finite, increasing time')
            _certify(end, exact_end, _TIME_BUDGET, 'accumulated simulation time')
            vehicles = tuple(self._candidate(config, vehicle, previous, dt, exact_end)
                             for config, vehicle in zip(self._configs, previous.vehicles))
            candidate = _Committed(previous.session_id, previous.sequence + 1,
                                   _timestamp(), end, vehicles, exact_end)
        except (RouteMotionError, OverflowError, TypeError) as cause:
            raise FleetSimulationError(str(cause)) from cause
        self._committed = candidate

    def _candidate(self, config: VehicleConfig, vehicle: _Vehicle,
                   previous: _Committed, dt: float, end: Fraction) -> _Vehicle:
        running = _number(_running_seconds_exact(config.parking, previous.time_exact, dt),
                          'running seconds')
        if running > dt:
            raise FleetSimulationError('running seconds must lie in [0, dt]')
        # The exact cumulative time drives both integration and endpoint state.
        # Only the integral result rounds to binary64 (at most half an ULP);
        # carry that uncertainty across commits without translating the start.
        integral_error = Fraction(0)
        if config.parking is not None:
            integral_error = Fraction(math.ulp(running)) / 2
        speed_mps = Fraction(config.cruise_speed_kmh) / Fraction(18, 5)
        distance_exact = speed_mps * Fraction(running)
        distance = config.cruise_speed_kmh / 3.6 * running
        _certify(distance, distance_exact, _DISTANCE_BUDGET, 'distance')
        mileage = vehicle.mileage_m + distance
        mileage_exact = vehicle.mileage_exact + distance_exact
        distance_error = vehicle.distance_error + speed_mps * integral_error
        _certify(mileage, mileage_exact, _DISTANCE_BUDGET, 'accumulated mileage', distance_error)
        if running == 0.0:
            progress, sample = vehicle.progress_m, vehicle.sample
        else:
            progress, sample = advance_route(self._route, vehicle.progress_m, distance)
        progress = _number(progress, 'progress')
        length = Fraction(self._route.length_m)
        expected_progress = (Fraction(self._route.length_m * config.initial_progress_fraction)
                             + mileage_exact) % length
        delta = abs(Fraction(progress) - expected_progress)
        if progress >= self._route.length_m or min(delta, abs(length - delta)) + distance_error > _DISTANCE_BUDGET:
            raise FleetSimulationError('closed route progress exceeds the representable error budget')
        soc = soc_after(vehicle.soc, config.soc_rate, running)
        soc_exact = max(Fraction(0), vehicle.soc_exact - Fraction(config.soc_rate) * Fraction(running))
        soc_error = vehicle.soc_error + Fraction(config.soc_rate) * integral_error
        _certify(soc, soc_exact, _TIME_BUDGET, 'accumulated SOC', soc_error)
        status = _status_at_exact(config.parking, end)
        candidate = replace(vehicle, progress_m=progress, mileage_m=mileage,
                            mileage_exact=mileage_exact, distance_error=distance_error,
                            sample=sample, soc=soc, soc_exact=soc_exact, soc_error=soc_error,
                            status=status, speed=float(config.cruise_speed_kmh) if status == 'running' else 0.0)
        _validate_vehicle(candidate, self._route.length_m)
        return candidate
