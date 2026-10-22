import asyncio
from contextlib import ExitStack
from dataclasses import replace
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend.main import app
from backend.simulation.fleet_config import FleetSimulationError
from backend.tests.test_scene_api import (
    controlled_background_clock, patch_main_clock,
    release_background_tick, wait_for_background_sleep,
)
from backend.tests.test_vehicle_websocket import receive_json_with_timeout


def test_fleet_http_endpoint_reads_same_commit(monkeypatch):
    async def paused_background(*args):
        await asyncio.Event().wait()

    monkeypatch.setattr('backend.main._update_vehicle_state', paused_background)
    with TestClient(app) as client:
        response = client.get('/api/fleet')
        assert response.status_code == 200
        fleet = response.json()
        assert set(fleet) == {
            'schema_version', 'session_id', 'sequence', 'timestamp',
            'simulation_time_seconds', 'vehicles',
        }
        assert fleet['schema_version'] == 1
        assert fleet['sequence'] == 0
        assert fleet['simulation_time_seconds'] == 0
        assert [v['vehicle_id'] for v in fleet['vehicles']] == ['TRUCK_001', 'TRUCK_002', 'TRUCK_003']
        legacy = client.get('/api/vehicles/TRUCK_001').json()
        assert legacy == fleet['vehicles'][0]
        assert len(legacy) == 10
        assert all(v['timestamp'] == fleet['timestamp'] for v in fleet['vehicles'])
        fleet['vehicles'][0]['soc'] = -1
        fleet['vehicles'].clear()
        assert client.get('/api/fleet').json()['vehicles'][0] == legacy
        simulator = app.state.fleet_simulator
        before = simulator.get_snapshot()
        copy = simulator.get_snapshot()
        copy['vehicles'][0]['longitude'] = 0
        assert simulator.get_snapshot() == before
        client.portal.call(simulator.step, 1.0)
        updated = client.get('/api/fleet').json()
        assert updated['sequence'] == 1
        assert updated['simulation_time_seconds'] == 1.0
        assert client.get('/api/vehicles/TRUCK_001').json() == updated['vehicles'][0]
        assert before['sequence'] == 0
        assert before['vehicles'][0]['soc'] == 90.0
        for path in ('/', '/health', '/docs', '/api/scene'):
            assert client.get(path).status_code == 200


def test_startup_session_and_single_clock(monkeypatch):
    constructors, steps, tasks, sessions = [], [], [], []
    real_constructor = main.FleetSimulator

    def counted_constructor(scene, **kwargs):
        constructors.append(scene)
        simulator = real_constructor(scene, **kwargs)
        real_step = simulator.step

        def counted_step(dt=1.0):
            steps.append(dt)
            return real_step(dt)

        monkeypatch.setattr(simulator, 'step', counted_step)
        return simulator

    monkeypatch.setattr(main, 'FleetSimulator', counted_constructor)
    for startup in range(2):
        entered, permits = asyncio.Queue(), asyncio.Queue()

        async def controlled_sleep(seconds):
            entered.put_nowait(seconds)
            await permits.get()

        patch_main_clock(monkeypatch, sleep=controlled_sleep)
        controlled_background_clock = entered, permits
        with TestClient(app) as client:
            wait_for_background_sleep(client, controlled_background_clock)
            task = app.state.telemetry_task
            tasks.append(task)
            snapshot = client.get('/api/fleet').json()
            sessions.append(snapshot['session_id'])
            assert UUID(snapshot['session_id']).version == 4
            assert snapshot['sequence'] == 0
            assert snapshot['simulation_time_seconds'] == 0.0
            with ExitStack() as stack:
                websocket = stack.enter_context(client.websocket_connect('/ws/vehicles'))
                fleets = [stack.enter_context(client.websocket_connect('/ws/fleet')) for _ in range(2)]
                assert receive_json_with_timeout(websocket) == snapshot['vehicles'][0]
                assert [receive_json_with_timeout(ws) for ws in fleets] == [snapshot, snapshot]
                for _ in range(3):
                    assert client.get('/api/fleet').json() == snapshot
                    assert client.get('/api/vehicles/TRUCK_001').json() == snapshot['vehicles'][0]
                assert steps == [1.0] * startup
                release_background_tick(client, controlled_background_clock)
                latest = client.get('/api/fleet').json()
                assert latest['sequence'] == 1
                assert latest['simulation_time_seconds'] == 1.0
                assert [v['soc'] for v in latest['vehicles']] == pytest.approx([89.9, 79.9, 69.9])
                assert [receive_json_with_timeout(ws) for ws in fleets] == [latest, latest]
                late = stack.enter_context(client.websocket_connect('/ws/fleet'))
                assert receive_json_with_timeout(late) == latest
                assert steps == [1.0] * (startup + 1)
                assert app.state.telemetry_task is task
                # Reads after t0 capture latest; they never reset the clock.
                for _ in range(3):
                    assert client.get('/api/fleet').json() == latest
                assert not task.done()
        assert task.cancelled()
        assert not app.state.simulation_unavailable
    assert sessions[0] != sessions[1]
    assert len(constructors) == 2
    assert tasks[0] is not tasks[1]


@pytest.mark.parametrize('failure', ['config', 'constructor'])
def test_startup_invalid_inputs_create_no_clock(monkeypatch, failure):
    started = []

    def forbidden_background(*args):
        started.append(args)
        raise AssertionError('invalid startup started a clock')

    monkeypatch.setattr(main, '_update_vehicle_state', forbidden_background)
    if failure == 'config':
        monkeypatch.setattr(main, 'DEFAULT_VEHICLE_CONFIGS', (
            replace(main.DEFAULT_VEHICLE_CONFIGS[0], cruise_speed_kmh=-1),
        ))
    else:
        def rejected_constructor(scene, **kwargs):
            raise FleetSimulationError('initial candidate rejected')
        monkeypatch.setattr(main, 'FleetSimulator', rejected_constructor)
    with pytest.raises(FleetSimulationError):
        with TestClient(app):
            pytest.fail('startup yielded despite invalid inputs')
    assert not started


@pytest.mark.parametrize('failed_index', [0, 1, 2], ids=['first', 'middle', 'last'])
def test_calculation_fault_propagates_without_partial_commit(
    monkeypatch, controlled_background_clock, caplog, failed_index,
):
    with TestClient(app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        simulator = app.state.fleet_simulator
        initial = simulator.get_snapshot()
        scene = client.get('/api/scene').json()
        real_candidate = simulator._candidate
        attempted = []

        def fail_candidate(config, *args):
            attempted.append(config.vehicle_id)
            if config.vehicle_id == f'TRUCK_{failed_index + 1:03d}':
                raise FleetSimulationError('controlled candidate failure')
            return real_candidate(config, *args)

        monkeypatch.setattr(simulator, '_candidate', fail_candidate)
        client.portal.call(controlled_background_clock[1].put_nowait, None)

        async def wait_fault():
            await asyncio.wait_for(app.state.telemetry_task, 1)
        client.portal.call(wait_fault)
        assert attempted == [f'TRUCK_{i + 1:03d}' for i in range(failed_index + 1)]
        assert simulator.get_snapshot() == initial
        assert simulator.get_vehicle_state('TRUCK_001') == initial['vehicles'][0]
        assert app.state.simulation_unavailable
        assert not app.state.telemetry_task.cancelled()
        for _ in range(2):
            for path in ('/api/fleet', '/api/vehicles/TRUCK_001', '/health'):
                assert client.get(path).status_code == 503
            assert client.get('/api/scene').json() == scene
            assert simulator.get_snapshot() == initial
        errors = [record for record in caplog.records if record.levelname == 'ERROR']
        assert len(errors) == 1
        assert str(errors[0].exc_info[1]) == 'controlled candidate failure'
