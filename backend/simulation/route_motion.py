"""Single-vehicle state adapter over the shared WGS84 route computation."""

import math
from datetime import UTC, datetime

from backend.scene.loader import LoadedScene
from backend.simulation.route_geometry import (
    RouteMotionError, _parameter, advance_route, compile_route, sample_route,
)


class RouteSimulator:
    def __init__(self, scene: LoadedScene, *, speed_kmh: float = 25.0) -> None:
        speed_kmh = _parameter(speed_kmh, 'speed_kmh')
        self._route = compile_route(scene)
        self._distance = 0.0
        sample = sample_route(self._route, 0.0)
        self._state: dict[str, object] = {
            'vehicle_id': 'TRUCK_001',
            'timestamp': datetime.now(UTC).isoformat(),
            'longitude': sample.longitude, 'latitude': sample.latitude, 'height': sample.height,
            'heading': sample.heading, 'speed': float(speed_kmh), 'soc': 90.0,
            'load': 65.0, 'status': 'running',
        }

    def get_state(self) -> dict[str, object]:
        return self._state.copy()

    def step(self, dt: float = 1.0) -> None:
        dt = _parameter(dt, 'dt')
        if dt == 0.0:
            return
        advance = self._state['speed'] / 3.6 * dt
        if not math.isfinite(advance):
            raise RouteMotionError('motion advance must be finite')
        distance, sample = advance_route(self._route, self._distance, advance)
        candidate = self._state.copy()
        candidate.update(
            longitude=sample.longitude, latitude=sample.latitude,
            height=sample.height, heading=sample.heading,
            soc=max(0.0, self._state['soc'] - 0.1 * dt),
            timestamp=datetime.now(UTC).isoformat(),
        )
        numeric_fields = ('longitude', 'latitude', 'height', 'heading', 'speed', 'soc', 'load')
        if not all(math.isfinite(candidate[field]) for field in numeric_fields):
            raise RouteMotionError('candidate motion state must contain finite numbers')
        self._state, self._distance = candidate, distance
