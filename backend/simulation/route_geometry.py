"""Pure compilation, sampling and advancement of processed WGS84 scene routes."""

import math
from bisect import bisect_right
from dataclasses import dataclass

from pyproj import Geod

from backend.scene.loader import LoadedScene, Position

_GEOD = Geod(ellps='WGS84')


class RouteMotionError(ValueError):
    """A route compilation or candidate motion is numerically invalid."""


@dataclass(frozen=True, slots=True)
class CompiledRoute:
    length_m: float
    segments: tuple[tuple[Position, Position, float, float], ...]
    cumulative_m: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class RouteSample:
    longitude: float
    latitude: float
    height: float
    heading: float


def _parameter(value, name):
    if type(value) not in (int, float):
        raise RouteMotionError(f'{name} must be a finite nonnegative number')
    try:
        number = float(value)
    except OverflowError as exc:
        raise RouteMotionError(f'{name} is not representable as a finite float') from exc
    if not math.isfinite(number) or number < 0.0:
        raise RouteMotionError(f'{name} must be a finite nonnegative number')
    return number


def compile_route(scene: LoadedScene) -> CompiledRoute:
    """Compile already processed coordinates without modifying or subdividing them."""
    segments = []
    cumulative = [0.0]
    for edge_id, reverse in scene.route_segments:
        coordinates = scene.road_coordinates[edge_id]
        if reverse:
            coordinates = coordinates[::-1]
        for start, end in zip(coordinates, coordinates[1:]):
            azimuth, _, length = _GEOD.inv(*start[:2], *end[:2])
            if not math.isfinite(length) or length <= 0.0 or not math.isfinite(azimuth):
                raise RouteMotionError(
                    'compiled length and bearing must be finite; length must be positive'
                )
            total = cumulative[-1] + length
            if not math.isfinite(total) or total <= cumulative[-1]:
                raise RouteMotionError('cumulative route length must be finite and strictly increasing')
            segments.append((start, end, length, azimuth % 360.0))
            cumulative.append(total)
    if not segments:
        raise RouteMotionError('compiled route must contain positive length segments')
    return CompiledRoute(cumulative[-1], tuple(segments), tuple(cumulative))


def sample_route(route: CompiledRoute, distance_m: float) -> RouteSample:
    """Sample cyclic mileage; exact nodes retain the next outgoing tangent."""
    distance = _parameter(distance_m, 'distance_m') % route.length_m
    index = bisect_right(route.cumulative_m, distance) - 1
    start, end, length, azimuth = route.segments[index]
    offset = distance - route.cumulative_m[index]
    fraction = offset / length
    if offset == 0.0:
        lon, lat, heading = start[0], start[1], azimuth
    else:
        lon, lat, heading = _GEOD.fwd(
            *start[:2], azimuth, offset, return_back_azimuth=False,
        )
    sample = RouteSample(
        longitude=lon, latitude=lat,
        height=(1.0 - fraction) * start[2] + fraction * end[2],
        heading=heading % 360.0,
    )
    if not all(math.isfinite(value) for value in (
        sample.longitude, sample.latitude, sample.height, sample.heading,
    )):
        raise RouteMotionError('candidate route sample must contain finite numbers')
    return sample


def advance_route(
    route: CompiledRoute, progress_m: float, distance_m: float,
) -> tuple[float, RouteSample]:
    """Calculate a candidate progress/sample pair without owning consumer state."""
    progress = _parameter(progress_m, 'progress_m') + _parameter(distance_m, 'distance_m')
    if not math.isfinite(progress):
        raise RouteMotionError('motion progress must be finite')
    distance = progress % route.length_m
    return distance, sample_route(route, distance)
