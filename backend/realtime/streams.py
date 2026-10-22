"""Connection-owned WebSocket I/O over the fleet's public update predicates."""

import asyncio
from dataclasses import dataclass, field
import logging
from typing import Literal

from fastapi import WebSocket, WebSocketDisconnect

from backend.realtime.fleet_updates import FleetUnavailableError, FleetUpdates, StreamShutdown


logger = logging.getLogger(__name__)
_TERMINATION_SECONDS = 5.0


@dataclass(eq=False)
class _Connection:
    socket: WebSocket
    finished: asyncio.Future = field(default_factory=asyncio.Future)
    owned: tuple[asyncio.Task, ...] = ()
    cleanup: asyncio.Task | None = None
    last_sent_sequence: int = -1
    disconnected: bool = False


class StreamSupervisor:
    def __init__(self, updates: FleetUpdates) -> None:
        self._updates = updates
        self._connections: set[_Connection] = set()
        self.unreleased_tasks: set[asyncio.Task] = set()

    async def _send(self, connection: _Connection, mode: str) -> None:
        socket = connection.socket
        while True:
            snapshot = await self._updates.wait_after(
                connection.last_sent_sequence if mode == 'fleet' else -1,
            )
            if mode == 'vehicle':
                snapshot = next(v for v in snapshot['vehicles'] if v['vehicle_id'] == 'TRUCK_001')
            # No await between these validity checks and starting this frame.
            if connection.disconnected:
                return
            await socket.send_json(snapshot)
            if mode == 'fleet':
                connection.last_sent_sequence = snapshot['sequence']
            else:
                try:
                    async with asyncio.timeout(1.0):
                        await asyncio.Event().wait()
                except TimeoutError:
                    pass

    async def _receive(self, connection: _Connection) -> None:
        try:
            while True:
                message = await connection.socket.receive()
                if message['type'] == 'websocket.disconnect':
                    return
        finally:
            connection.disconnected = True

    def _observe_finished(self, task: asyncio.Task) -> None:
        self.unreleased_tasks.discard(task)
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                logger.warning('WebSocket resource %s failed: %r', task.get_name(), error)

    def _report_unreleased(self, tasks: set[asyncio.Task]) -> None:
        for task in tasks:
            if not task.done():
                self.unreleased_tasks.add(task)
                task.add_done_callback(self._observe_finished)
                logger.error('WebSocket unreleased resource: %s', task.get_name())

    async def _terminate(self, connection: _Connection, code: int, deadline: float) -> None:
        remaining = lambda: max(0.0, deadline - asyncio.get_running_loop().time())
        for task in connection.owned:
            if not task.done():
                task.cancel()
        done, pending = await asyncio.wait(connection.owned, timeout=remaining())
        for task in done:
            self._observe_finished(task)
        if pending:
            self._report_unreleased(pending)
            logger.error('WebSocket close skipped: I/O owners remain unreleased')
            return
        # Closing is another writer: only begin after every data owner ended.
        close = asyncio.create_task(connection.socket.close(code=code), name='stream-close')
        done, pending = await asyncio.wait({close}, timeout=remaining())
        if pending:
            logger.warning('WebSocket close exceeded termination budget')
            close.cancel()
            # Give cooperative cancellation its loop turn, without a fresh budget.
            done, pending = await asyncio.wait({close}, timeout=remaining())
        for task in done:
            self._observe_finished(task)
        self._report_unreleased(pending)

    def _begin_termination(self, connection: _Connection, code: int) -> asyncio.Task:
        if connection.cleanup is None:
            deadline = asyncio.get_running_loop().time() + _TERMINATION_SECONDS
            connection.cleanup = asyncio.create_task(
                self._terminate(connection, code, deadline), name='stream-cleanup',
            )
        return connection.cleanup

    async def serve(self, socket: WebSocket, *, mode: Literal['fleet', 'vehicle']) -> None:
        await socket.accept()
        connection = _Connection(socket)
        self._connections.add(connection)
        connection.owned = (
            asyncio.create_task(self._send(connection, mode), name='stream-sender'),
            asyncio.create_task(self._receive(connection), name='stream-receiver'),
            asyncio.create_task(self._updates.wait_terminal(), name='stream-terminal'),
        )
        code = 1000
        cancelled = None
        try:
            done, _ = await asyncio.wait(connection.owned, return_when=asyncio.FIRST_COMPLETED)
            if connection.owned[2] in done:
                await self._updates.wait_after(-1)
            for task in done:
                task.result()
        except FleetUnavailableError:
            code = 1011
        except (StreamShutdown, WebSocketDisconnect, OSError, RuntimeError):
            pass
        except Exception:
            logger.exception('WebSocket connection failed')
        except asyncio.CancelledError as error:
            cancelled = error
        finally:
            cleanup = self._begin_termination(connection, code)
            # Parent cancellation must not cancel the bounded collection/close owner.
            while True:
                try:
                    await asyncio.shield(cleanup)
                    break
                except asyncio.CancelledError as error:
                    cancelled = cancelled or error
            self._connections.discard(connection)
            connection.finished.set_result(None)
        if cancelled is not None:
            raise cancelled

    async def shutdown(self) -> None:
        await self._updates.begin_shutdown()
        connections = tuple(self._connections)
        if connections:
            _, pending = await asyncio.wait(
                {connection.finished for connection in connections}, timeout=_TERMINATION_SECONDS,
            )
            for connection in connections:
                if connection.finished in pending:
                    logger.error('WebSocket connection cleanup remains unfinished at shutdown')
                    resources = set(connection.owned)
                    if connection.cleanup is not None:
                        resources.add(connection.cleanup)
                    self._report_unreleased(resources)
