"""Connection termination through real ASGI, with bounded cooperative I/O."""

import asyncio
import json

import pytest

import backend.main as main
from backend.simulation.fleet_config import FleetSimulationError
from backend.tests.test_scene_api import patch_main_clock


class SocketProbe:
    """ASGI transport with controllable backpressure and disconnect input."""

    def __init__(self, path, *, block_frame=0):
        self.path = path
        self.block_frame = block_frame
        self.input = asyncio.Queue()
        self.input.put_nowait({'type': 'websocket.connect'})
        self.blocked = asyncio.Event()
        self.release = asyncio.Event()
        self.sent = []
        self.active_writers = 0
        self.concurrent_write = False
        self.send_cancelled = False
        self.receive_cancelled = False
        self.frames = 0

    async def receive(self):
        try:
            return await self.input.get()
        except asyncio.CancelledError:
            self.receive_cancelled = True
            raise

    async def send(self, message):
        self.active_writers += 1
        self.concurrent_write |= self.active_writers > 1
        try:
            if message['type'] == 'websocket.send':
                frame = self.frames
                self.frames += 1
                if frame == self.block_frame:
                    self.blocked.set()
                    try:
                        await self.release.wait()
                    except asyncio.CancelledError:
                        self.send_cancelled = True
                        raise
            self.sent.append(message)
        finally:
            self.active_writers -= 1

    def start(self):
        return asyncio.create_task(main.app({
            'type': 'websocket', 'path': self.path, 'scheme': 'ws',
            'query_string': b'', 'headers': [], 'root_path': '',
            'server': ('testserver', 80), 'client': ('testclient', 50000),
            'subprotocols': [],
        }, self.receive, self.send))


async def bounded_done(task, seconds=0.5):
    done, _ = await asyncio.wait({task}, timeout=seconds)
    assert task in done, 'WebSocket handler did not terminate after terminal notification'
    return task.result()


@pytest.mark.parametrize('path', ['/ws/fleet', '/ws/vehicles'])
def test_blocked_first_send_wakes_on_fault(monkeypatch, path):
    async def exercise():
        permits = asyncio.Queue()
        sleeping = asyncio.Event()

        async def controlled_sleep(seconds):
            assert seconds == 1.0
            sleeping.set()
            await permits.get()

        patch_main_clock(monkeypatch, sleep=controlled_sleep)
        async with main.lifespan(main.app):
            await asyncio.wait_for(sleeping.wait(), 1)
            simulator = main.app.state.fleet_simulator
            committed = simulator.get_snapshot()
            original = simulator._candidate

            def failed_candidate(config, *args):
                if config.vehicle_id == 'TRUCK_003':
                    raise FleetSimulationError('blocked first frame calculation failure')
                return original(config, *args)

            monkeypatch.setattr(simulator, '_candidate', failed_candidate)
            probe = SocketProbe(path)
            handler = probe.start()
            try:
                await asyncio.wait_for(probe.blocked.wait(), 1)
                permits.put_nowait(None)
                await asyncio.wait_for(main.app.state.telemetry_task, 1)
                assert simulator.get_snapshot() == committed
                assert main.app.state.simulation_unavailable
                await bounded_done(handler)
                assert probe.send_cancelled
                assert probe.receive_cancelled
                assert probe.active_writers == 0
                assert not probe.concurrent_write
                assert [m['code'] for m in probe.sent if m['type'] == 'websocket.close'] == [1011]
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)

    asyncio.run(exercise())

@pytest.fixture
def paused_clock(monkeypatch):
    async def paused(*args):
        await asyncio.Event().wait()
    monkeypatch.setattr(main, '_update_vehicle_state', paused)


async def wait_frames(probe, count):
    async def observe():
        while len([m for m in probe.sent if m['type'] == 'websocket.send']) < count:
            await asyncio.sleep(0)
    await asyncio.wait_for(observe(), 1)


@pytest.mark.parametrize('path', ['/ws/fleet', '/ws/vehicles'])
@pytest.mark.parametrize('ending', ['fault', 'shutdown', 'disconnect', 'parent_cancel'])
def test_later_send_shutdown_disconnect_and_close_budget(paused_clock, monkeypatch, path, ending):
    async def exercise():
        async with main.lifespan(main.app):
            probe = SocketProbe(path, block_frame=1)
            handler = probe.start()
            try:
                await wait_frames(probe, 1)
                main.app.state.fleet_simulator.step(1.0)
                await main.app.state.fleet_updates.notify()
                # The legacy consumer owns its independent one-second read interval.
                await asyncio.wait_for(probe.blocked.wait(), 1.5)
                committed = main.app.state.fleet_simulator.get_snapshot()
                if ending == 'fault':
                    main.app.state.simulation_unavailable = True
                    await main.app.state.fleet_updates.notify()
                elif ending == 'shutdown':
                    await main.app.state.stream_supervisor.shutdown()
                    assert handler.done(), 'shutdown returned before its connection was collected'
                elif ending == 'disconnect':
                    probe.input.put_nowait({'type': 'websocket.disconnect', 'code': 1000})
                else:
                    handler.cancel()
                if ending == 'parent_cancel':
                    done, _ = await asyncio.wait({handler}, timeout=0.5)
                    assert handler in done
                    assert handler.cancelled()
                else:
                    await bounded_done(handler)
                assert probe.send_cancelled
                assert probe.receive_cancelled or ending == 'disconnect'
                assert not probe.concurrent_write
                assert probe.active_writers == 0
                assert main.app.state.fleet_simulator.get_snapshot() == committed
                codes = [m['code'] for m in probe.sent if m['type'] == 'websocket.close']
                assert codes == [1011 if ending == 'fault' else 1000]
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
    asyncio.run(exercise())


def test_shutdown_collects_connections_in_parallel(paused_clock):
    async def exercise():
        async with main.lifespan(main.app):
            entered = [asyncio.Event(), asyncio.Event()]
            close_gate = asyncio.Event()
            probes = [SocketProbe('/ws/fleet'), SocketProbe('/ws/vehicles')]
            handlers = []
            for index, probe in enumerate(probes):
                real_send = probe.send
                async def send(message, index=index, real_send=real_send):
                    if message['type'] == 'websocket.close':
                        entered[index].set()
                        await close_gate.wait()
                    await real_send(message)
                probe.send = send
                handlers.append(probe.start())
            shutdown = None
            try:
                await asyncio.gather(*(p.blocked.wait() for p in probes))
                shutdown = asyncio.create_task(main.app.state.stream_supervisor.shutdown())
                await asyncio.wait_for(asyncio.gather(*(e.wait() for e in entered)), 0.5)
                assert not shutdown.done()
                close_gate.set()
                await bounded_done(shutdown)
                await asyncio.gather(*(bounded_done(h) for h in handlers))
                assert all(p.send_cancelled and not p.concurrent_write for p in probes)
            finally:
                close_gate.set()
                for h in handlers:
                    h.cancel()
                await asyncio.gather(*handlers, return_exceptions=True)
                if shutdown is not None:
                    await asyncio.gather(shutdown, return_exceptions=True)
    asyncio.run(exercise())


@pytest.mark.parametrize('close_behavior', ['raise', 'block'])
def test_close_exception_or_budget_is_reported(paused_clock, monkeypatch, caplog, close_behavior):
    async def exercise():
        import backend.realtime.streams as streams
        from types import SimpleNamespace
        # Real event-loop wait, shortened only at the termination I/O boundary.
        # A blocked normal frame has no timeout; only cleanup consumes this budget.
        observed_timeouts = []
        real_wait = asyncio.wait
        async def controlled_wait(tasks, *, timeout=None, return_when=asyncio.ALL_COMPLETED):
            if timeout is not None:
                observed_timeouts.append(timeout)
                timeout = min(timeout, 0.02)
            return await real_wait(tasks, timeout=timeout, return_when=return_when)
        monkeypatch.setattr(streams, 'asyncio', SimpleNamespace(**(vars(asyncio) | {'wait': controlled_wait})))
        async with main.lifespan(main.app):
            probe = SocketProbe('/ws/fleet')
            real_send = probe.send
            close_started = asyncio.Event()
            close_finished = asyncio.Event()
            async def send(message):
                if message['type'] == 'websocket.close':
                    close_started.set()
                    try:
                        if close_behavior == 'raise':
                            raise OSError('close transport unavailable')
                        await asyncio.Event().wait()
                    finally:
                        close_finished.set()
                await real_send(message)
            probe.send = send
            handler = probe.start()
            try:
                await asyncio.wait_for(probe.blocked.wait(), 1)
                main.app.state.simulation_unavailable = True
                await main.app.state.fleet_updates.notify()
                await bounded_done(handler)
                assert close_started.is_set()
                assert close_finished.is_set(), 'cooperative close task remained live'
                assert observed_timeouts and max(observed_timeouts) <= 5.0
                assert any('close' in r.message.lower() for r in caplog.records)
                assert not main.app.state.stream_supervisor.unreleased_tasks
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
    asyncio.run(exercise())


def test_cancel_collection_and_close_share_one_total_budget(paused_clock, monkeypatch):
    async def exercise():
        import backend.realtime.streams as streams
        from types import SimpleNamespace
        clock = [100.0]
        timeouts = []
        real_wait = asyncio.wait
        async def controlled_wait(tasks, *, timeout=None, return_when=asyncio.ALL_COMPLETED):
            if timeout is not None:
                timeouts.append(timeout)
                if len(timeouts) == 1:
                    clock[0] += 4.0
            return await real_wait(tasks, timeout=timeout, return_when=return_when)
        monkeypatch.setattr(streams, 'asyncio', SimpleNamespace(**(vars(asyncio) | {
            'wait': controlled_wait, 'get_running_loop': lambda: SimpleNamespace(time=lambda: clock[0]),
        })))
        async with main.lifespan(main.app):
            probe = SocketProbe('/ws/fleet')
            handler = probe.start()
            try:
                await asyncio.wait_for(probe.blocked.wait(), 1)
                main.app.state.simulation_unavailable = True
                await main.app.state.fleet_updates.notify()
                await bounded_done(handler)
                assert timeouts[0] == pytest.approx(5.0)
                assert timeouts[1] <= 1.0, 'close received a fresh five-second budget'
                assert not main.app.state.stream_supervisor.unreleased_tasks
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
    asyncio.run(exercise())

@pytest.mark.parametrize('resource', ['sender', 'close'])
def test_budget_reports_unreleased_until_resource_really_finishes(paused_clock, monkeypatch, caplog, resource):
    async def exercise():
        import backend.realtime.streams as streams
        from types import SimpleNamespace
        real_wait = asyncio.wait
        async def controlled_wait(tasks, *, timeout=None, return_when=asyncio.ALL_COMPLETED):
            return await real_wait(tasks, timeout=min(timeout, 0.02) if timeout is not None else None,
                                   return_when=return_when)
        monkeypatch.setattr(streams, 'asyncio', SimpleNamespace(**(vars(asyncio) | {'wait': controlled_wait})))
        async with main.lifespan(main.app):
            supervisor = main.app.state.stream_supervisor
            probe = SocketProbe('/ws/fleet')
            real_send = probe.send
            release = asyncio.Event()
            resistant_finished = asyncio.Event()
            async def send(message):
                resistant = (resource == 'sender' and message['type'] == 'websocket.send'
                             or resource == 'close' and message['type'] == 'websocket.close')
                if resistant:
                    if resource == 'sender':
                        probe.blocked.set()
                    try:
                        try:
                            await release.wait()
                        except asyncio.CancelledError:
                            await release.wait()
                    finally:
                        resistant_finished.set()
                    return
                await real_send(message)
            probe.send = send
            handler = probe.start()
            try:
                await asyncio.wait_for(probe.blocked.wait(), 1)
                main.app.state.simulation_unavailable = True
                await main.app.state.fleet_updates.notify()
                await bounded_done(handler)
                pending = supervisor.unreleased_tasks
                assert pending and all(not t.done() for t in pending)
                assert not resistant_finished.is_set()
                assert any('unreleased' in r.message.lower() for r in caplog.records)
                if resource == 'sender':
                    assert not [m for m in probe.sent if m['type'] == 'websocket.close']
                release.set()
                await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), 1)
                await asyncio.sleep(0)
                assert resistant_finished.is_set()
                assert not supervisor.unreleased_tasks
            finally:
                release.set()
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
    asyncio.run(exercise())

@pytest.mark.parametrize('error_type', [OSError, ValueError])
def test_one_failed_sender_does_not_stop_other_clients_or_clock(monkeypatch, error_type):
    async def exercise():
        permits, sleeping = asyncio.Queue(), asyncio.Queue()
        async def controlled_sleep(seconds):
            sleeping.put_nowait(seconds)
            await permits.get()
        patch_main_clock(monkeypatch, sleep=controlled_sleep)
        async with main.lifespan(main.app):
            assert await asyncio.wait_for(sleeping.get(), 1) == 1.0
            failed = SocketProbe('/ws/fleet', block_frame=-1)
            healthy = SocketProbe('/ws/fleet', block_frame=-1)
            original_send = failed.send
            async def send(message):
                if message['type'] == 'websocket.send' and json.loads(message['text'])['sequence'] == 1:
                    raise error_type('one client transport failure')
                await original_send(message)
            failed.send = send
            handlers = [failed.start(), healthy.start()]
            try:
                await asyncio.gather(wait_frames(failed, 1), wait_frames(healthy, 1))
                # Arbitrary messages neither advance simulation nor create a control path.
                for probe in (failed, healthy):
                    probe.input.put_nowait({'type': 'websocket.receive', 'text': 'step'})
                await asyncio.sleep(0)
                assert main.app.state.fleet_simulator.get_snapshot()['sequence'] == 0
                permits.put_nowait(None)
                assert await asyncio.wait_for(sleeping.get(), 1) == 1.0
                await bounded_done(handlers[0])
                await wait_frames(healthy, 2)
                previous = json.loads(healthy.sent[-1]['text'])
                committed = main.app.state.fleet_simulator.get_snapshot()
                assert committed['sequence'] == 1
                assert committed['vehicles'] == previous['vehicles']
                assert main.app.state.simulation_unavailable is False
                assert not main.app.state.telemetry_task.done()
                permits.put_nowait(None)
                assert await asyncio.wait_for(sleeping.get(), 1) == 1.0
                await wait_frames(healthy, 3)
                latest = json.loads(healthy.sent[-1]['text'])
                assert latest['sequence'] > previous['sequence']
                assert latest['vehicles'] == main.app.state.fleet_simulator.get_snapshot()['vehicles']
            finally:
                for h in handlers:
                    h.cancel()
                await asyncio.gather(*handlers, return_exceptions=True)
    asyncio.run(exercise())


def test_slow_sender_keeps_successful_sequence_and_jumps_to_latest(paused_clock):
    async def exercise():
        async with main.lifespan(main.app):
            slow = SocketProbe('/ws/fleet')
            fast = SocketProbe('/ws/fleet', block_frame=-1)
            handlers = [slow.start(), fast.start()]
            try:
                await asyncio.wait_for(slow.blocked.wait(), 1)
                await wait_frames(fast, 1)
                connection = next(c for c in main.app.state.stream_supervisor._connections
                                  if c.last_sent_sequence == -1)
                assert connection.last_sent_sequence == -1
                for sequence in (1, 2, 3):
                    main.app.state.fleet_simulator.step(1)
                    await main.app.state.fleet_updates.notify()
                    await wait_frames(fast, sequence + 1)
                    assert json.loads(fast.sent[-1]['text'])['sequence'] == sequence
                assert connection.last_sent_sequence == -1
                assert slow.frames == 1
                slow.release.set()
                await wait_frames(slow, 2)
                sequences = [json.loads(m['text'])['sequence'] for m in slow.sent if m['type'] == 'websocket.send']
                assert sequences == [0, 3]
                assert connection.last_sent_sequence == 3
                assert main.app.state.simulation_unavailable is False
            finally:
                for h in handlers:
                    h.cancel()
                await asyncio.gather(*handlers, return_exceptions=True)
    asyncio.run(exercise())


def test_disconnect_prevents_frame_when_commit_wakes_sender_in_same_turn(paused_clock):
    async def exercise():
        async with main.lifespan(main.app):
            probe = SocketProbe('/ws/fleet', block_frame=-1)
            handler = probe.start()
            try:
                await wait_frames(probe, 1)
                probe.input.put_nowait({'type': 'websocket.disconnect', 'code': 1000})
                main.app.state.fleet_simulator.step(1)
                await main.app.state.fleet_updates.notify()
                await bounded_done(handler)
                frames = [m for m in probe.sent if m['type'] == 'websocket.send']
                assert len(frames) == 1, 'a new normal frame started after receive observed disconnect'
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
    asyncio.run(exercise())


def test_shutdown_waits_for_own_io_without_waiting_for_asgi_parent(paused_clock):
    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        with client.websocket_connect('/ws/fleet') as socket:
            from backend.tests.test_vehicle_websocket import receive_json_with_timeout
            assert receive_json_with_timeout(socket)['sequence'] == 0
            async def shutdown():
                await asyncio.wait_for(main.app.state.stream_supervisor.shutdown(), 0.5)
                assert not main.app.state.stream_supervisor._connections
                assert not main.app.state.stream_supervisor.unreleased_tasks
            client.portal.call(shutdown)
            async def receive_close():
                return await asyncio.wait_for(socket._send_rx.receive(), 0.5)
            message = socket.portal.call(receive_close)
            assert message['type'] == 'websocket.close'
            assert message['code'] == 1000
