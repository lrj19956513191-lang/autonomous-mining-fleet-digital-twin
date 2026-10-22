"""Version predicates over the fleet's committed state, with no snapshot cache."""

import asyncio
from collections.abc import Callable

from backend.simulation.fleet import FleetSimulator


class FleetUnavailableError(RuntimeError):
    """The simulation producer failed and cannot publish more snapshots."""


class StreamShutdown(RuntimeError):
    """The application's streams are closing normally."""


class FleetUpdates:
    def __init__(self, fleet: FleetSimulator, *, is_unavailable: Callable[[], bool]) -> None:
        self._fleet = fleet
        self._is_unavailable = is_unavailable
        self._condition = asyncio.Condition()
        self._closing = False

    async def notify(self) -> None:
        async with self._condition:
            self._condition.notify_all()

    async def wait_after(self, last_sent_sequence: int) -> dict[str, object]:
        async with self._condition:
            while True:
                if self._is_unavailable():
                    raise FleetUnavailableError('Vehicle simulation unavailable')
                if self._closing:
                    raise StreamShutdown('Application is shutting down')
                snapshot = self._fleet.get_snapshot()
                if snapshot['sequence'] > last_sent_sequence:
                    return snapshot
                await self._condition.wait()

    async def wait_terminal(self) -> None:
        async with self._condition:
            await self._condition.wait_for(lambda: self._is_unavailable() or self._closing)

    async def begin_shutdown(self) -> None:
        async with self._condition:
            self._closing = True
            self._condition.notify_all()
