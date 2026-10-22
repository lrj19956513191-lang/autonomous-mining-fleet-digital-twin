import asyncio
from contextlib import ExitStack
import json
import threading

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient

import backend.main as main
from backend.main import app
from backend.simulation.fleet_config import FleetSimulationError
from backend.tests.test_scene_api import controlled_background_clock, wait_for_background_sleep
from backend.tests.test_vehicle_websocket import receive_json_with_timeout


@pytest.fixture
def paused_fleet_clock(monkeypatch):
    async def paused_background(*args):
        await asyncio.Event().wait()
    monkeypatch.setattr(main, '_update_vehicle_state', paused_background)


def commit(client, dt=1.0):
    async def advance():
        app.state.fleet_simulator.step(dt)
        await app.state.fleet_updates.notify()
    client.portal.call(advance)


def test_first_frame_commit_race(paused_fleet_clock):
    entered = threading.Event()
    gate = asyncio.Event()

    async def delayed_app(scope, receive, send):
        async def delayed_send(message):
            if scope.get('path') == '/ws/fleet' and message['type'] == 'websocket.send':
                if json.loads(message['text'])['sequence'] == 0:
                    entered.set()
                    await gate.wait()
            await send(message)
        await app(scope, receive, delayed_send)

    with TestClient(delayed_app) as client:
        with client.websocket_connect('/ws/fleet') as websocket:
            assert entered.wait(1)
            commit(client)
            client.portal.call(gate.set)
            first = receive_json_with_timeout(websocket)
            second = receive_json_with_timeout(websocket)
            assert first['sequence'] == 0
            assert second['sequence'] == 1
            assert second['simulation_time_seconds'] == 1.0
            assert first['session_id'] == second['session_id']


def test_multiclient_consistency_and_read_isolation(paused_fleet_clock):
    with TestClient(app) as client:
        with ExitStack() as stack:
            fleets = [stack.enter_context(client.websocket_connect('/ws/fleet')) for _ in range(2)]
            legacy = stack.enter_context(client.websocket_connect('/ws/vehicles'))
            before_reads = app.state.fleet_simulator.get_snapshot()
            fleet_frames = [receive_json_with_timeout(ws) for ws in fleets]
            legacy_frame = receive_json_with_timeout(legacy)
            assert fleet_frames == [before_reads, before_reads]
            assert legacy_frame == next(v for v in fleet_frames[0]['vehicles'] if v['vehicle_id'] == 'TRUCK_001')
            assert before_reads == app.state.fleet_simulator.get_snapshot()
            task = app.state.telemetry_task
            commit(client)
            expected = client.get('/api/fleet').json()
            assert [receive_json_with_timeout(ws) for ws in fleets] == [expected, expected]
            assert receive_json_with_timeout(legacy) == expected['vehicles'][0]
            assert expected['sequence'] == 1
            assert app.state.telemetry_task is task
            assert not task.done()
            assert before_reads['sequence'] == 0


def test_slow_sender_consistency_takes_latest_without_blocking_others(paused_fleet_clock):
    blocked = threading.Event()
    gate = asyncio.Event()
    slow_claimed = False

    async def delayed_app(scope, receive, send):
        nonlocal slow_claimed
        slow = scope.get('path') == '/ws/fleet' and not slow_claimed
        if slow:
            slow_claimed = True

        async def delayed_send(message):
            if slow and message['type'] == 'websocket.send' and json.loads(message['text'])['sequence'] == 1:
                blocked.set()
                await gate.wait()
            await send(message)
        await app(scope, receive, delayed_send)

    with TestClient(delayed_app) as client:
        with client.websocket_connect('/ws/fleet') as slow:
            assert receive_json_with_timeout(slow)['sequence'] == 0
            with client.websocket_connect('/ws/fleet') as fast:
                assert receive_json_with_timeout(fast)['sequence'] == 0
                commit(client)
                assert blocked.wait(1)
                assert receive_json_with_timeout(fast)['sequence'] == 1
                for sequence in (2, 3):
                    commit(client)
                    assert receive_json_with_timeout(fast)['sequence'] == sequence
                client.portal.call(gate.set)
                last_sent_sequence = receive_json_with_timeout(slow)['sequence']
                latest = receive_json_with_timeout(slow)
                assert last_sent_sequence == 1
                assert latest['sequence'] > last_sent_sequence
                assert latest['sequence'] == 3
                assert latest == client.get('/api/fleet').json()


def test_condition_race_predicate_early_spurious_and_terminal(paused_fleet_clock):
    with TestClient(app) as client:
        async def exercise():
            updates = getattr(app.state, 'fleet_updates', None)
            assert updates is not None
            initial = await updates.wait_after(-1)
            assert initial['sequence'] == 0
            initial['vehicles'].clear()
            waiting = asyncio.create_task(updates.wait_after(0))
            terminal = asyncio.create_task(updates.wait_terminal())
            await updates.notify()
            await asyncio.sleep(0)
            assert not waiting.done()
            assert not terminal.done()
            app.state.fleet_simulator.step(1.0)
            # Predicate sees the commit even before its notify is delivered.
            early = await asyncio.wait_for(updates.wait_after(0), 1)
            assert early['sequence'] == 1
            assert len(early['vehicles']) == 3
            await updates.notify()
            assert (await asyncio.wait_for(waiting, 1))['sequence'] == 1
            assert not terminal.done()
            waiting = asyncio.create_task(updates.wait_after(1))
            await asyncio.sleep(0)
            await updates.begin_shutdown()
            with pytest.raises(main.StreamShutdown):
                await waiting
            await asyncio.wait_for(terminal, 1)
            with pytest.raises(main.StreamShutdown):
                await updates.wait_after(-1)
        client.portal.call(exercise)


@pytest.mark.parametrize('failed_index', [0, 1, 2], ids=['first', 'middle', 'last'])
def test_fault_closes_active_and_new_fleet_and_legacy_sockets(
    monkeypatch, controlled_background_clock, failed_index,
):
    with TestClient(app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        initial = app.state.fleet_simulator.get_snapshot()
        with ExitStack() as stack:
            active = [stack.enter_context(client.websocket_connect(path)) for path in ('/ws/fleet', '/ws/vehicles')]
            assert receive_json_with_timeout(active[0]) == initial
            assert receive_json_with_timeout(active[1]) == initial['vehicles'][0]
            simulator = app.state.fleet_simulator
            real_candidate = simulator._candidate

            def fail_candidate(config, *args):
                if config.vehicle_id == f'TRUCK_{failed_index + 1:03d}':
                    raise FleetSimulationError('controlled candidate failure')
                return real_candidate(config, *args)

            monkeypatch.setattr(simulator, '_candidate', fail_candidate)
            client.portal.call(controlled_background_clock[1].put_nowait, None)

            async def wait_fault():
                await asyncio.wait_for(app.state.telemetry_task, 1)
            client.portal.call(wait_fault)
            assert simulator.get_snapshot() == initial
            for path in ('/ws/fleet', '/ws/vehicles'):
                active.append(stack.enter_context(client.websocket_connect(path)))
            for websocket in active:
                async def receive_close():
                    return await asyncio.wait_for(websocket._send_rx.receive(), 1.5)
                message = websocket.portal.call(receive_close)
                assert message['type'] == 'websocket.close', message
                assert message['code'] == 1011
            assert client.get('/api/scene').status_code == 200


def test_fault_condition_wakes_terminal_and_version_waiters(monkeypatch, controlled_background_clock):
    with TestClient(app) as client:
        wait_for_background_sleep(client, controlled_background_clock)

        async def exercise():
            updates = app.state.fleet_updates
            version = asyncio.create_task(updates.wait_after(0))
            terminal = asyncio.create_task(updates.wait_terminal())
            await asyncio.sleep(0)

            def failed_step(dt=1.0):
                raise FleetSimulationError('fault notification')
            monkeypatch.setattr(app.state.fleet_simulator, 'step', failed_step)
            controlled_background_clock[1].put_nowait(None)
            await asyncio.wait_for(app.state.telemetry_task, 1)
            try:
                await asyncio.wait_for(terminal, 1)
                with pytest.raises(main.FleetUnavailableError):
                    await asyncio.wait_for(version, 1)
            finally:
                version.cancel()
                terminal.cancel()
                await asyncio.gather(version, terminal, return_exceptions=True)
            # Fault wins even if a version was committed but not sent.
            with pytest.raises(main.FleetUnavailableError):
                await updates.wait_after(-1)
        client.portal.call(exercise)


@pytest.mark.parametrize('path,handler', [('/ws/fleet', main.fleet_websocket), ('/ws/vehicles', main.vehicle_websocket)])
def test_network_send_failure_is_not_a_simulation_fault(paused_fleet_clock, path, handler):
    with TestClient(app) as client:
        async def exercise():
            simulator = app.state.fleet_simulator
            before = simulator.get_snapshot()
            connected = False

            async def receive():
                nonlocal connected
                if not connected:
                    connected = True
                    return {'type': 'websocket.connect'}
                await asyncio.Event().wait()

            async def failing_send(message):
                if message['type'] == 'websocket.send':
                    raise OSError('transport failed')

            websocket = WebSocket({'type': 'websocket', 'path': path}, receive, failing_send)
            await asyncio.wait_for(handler(websocket), 1)
            assert simulator.get_snapshot() == before
            assert not app.state.simulation_unavailable
            assert not app.state.telemetry_task.done()
            simulator.step(1.0)
            await app.state.fleet_updates.notify()
            assert simulator.get_snapshot()['sequence'] == 1
        client.portal.call(exercise)
        assert client.get('/health').status_code == 200
        with client.websocket_connect('/ws/fleet') as healthy:
            assert receive_json_with_timeout(healthy)['sequence'] == 1
