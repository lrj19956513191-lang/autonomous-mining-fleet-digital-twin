"""Real SQLite integration at the sole successful fleet commit boundary."""
import asyncio
import json
import sqlite3
from dataclasses import asdict

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend.tests.test_scene_api import (
    controlled_background_clock, release_background_tick, wait_for_background_sleep,
)
from backend.tests.test_vehicle_websocket import receive_json_with_timeout

LIMIT = 16 * 1024 * 1024


@pytest.fixture
def recording_env(monkeypatch, tmp_path, isolate_history_environment):
    monkeypatch.setenv("PHASE2D_HISTORY_DIR", str(tmp_path))
    monkeypatch.setenv("PHASE2D_HISTORY_MAX_DB_BYTES", str(LIMIT))
    monkeypatch.delenv("PHASE2D_CODE_REVISION", raising=False)
    return tmp_path / "fleet-history.sqlite3"


def rows(path, sql="SELECT * FROM history_snapshots ORDER BY sequence"):
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(sql)]


def test_initial_and_each_commit_record_once_without_clients(
    monkeypatch, recording_env, controlled_background_clock,
):
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        assert main.app.state.history_recorder.get_status().last_persisted_sequence == 0
        captured = [client.get('/api/fleet').json()]
        for _ in range(3):
            release_background_tick(client, controlled_background_clock)
            captured.append(client.get('/api/fleet').json())
        # Only reads, including new/legacy clients, must not produce recording entries.
        with client.websocket_connect('/ws/fleet') as fleet_ws:
            with client.websocket_connect('/ws/vehicles') as legacy_ws:
                assert receive_json_with_timeout(fleet_ws) == captured[-1]
                assert receive_json_with_timeout(legacy_ws) == captured[-1]['vehicles'][0]
                for _ in range(3):
                    assert client.get('/api/fleet').json() == captured[-1]
                    assert client.get('/api/vehicles/TRUCK_001').json() == captured[-1]['vehicles'][0]
        scene = main.app.state.scene.get_payload()
        recorder = main.app.state.history_recorder
    stored = rows(recording_env)
    assert [row['sequence'] for row in stored] == [0, 1, 2, 3]
    assert [json.loads(row['payload_json']) for row in stored] == captured
    metadata = rows(recording_env, "SELECT * FROM history_sessions")[0]
    assert metadata['state'] == 'COMPLETED'
    assert metadata['snapshot_count'] == 4
    assert metadata['session_id'] == captured[0]['session_id']
    assert json.loads(metadata['scene_json']) == scene
    assert json.loads(metadata['config_json']) == [asdict(c) for c in main.DEFAULT_VEHICLE_CONFIGS]
    assert metadata['code_revision'] is None
    assert recorder.get_status().last_persisted_sequence == 3
    assert not recorder._thread.is_alive()

@pytest.mark.parametrize('limit', [None, '', '1', '-16777216', '16777217', '16.0', 'true', ' 16777216'])
def test_config_disabled_missing_or_invalid_limit(monkeypatch, tmp_path, limit):
    from backend.history.settings import load_history_settings
    monkeypatch.setenv('PHASE2D_HISTORY_DIR', str(tmp_path / 'unused'))
    if limit is None:
        monkeypatch.delenv('PHASE2D_HISTORY_MAX_DB_BYTES', raising=False)
    else:
        monkeypatch.setenv('PHASE2D_HISTORY_MAX_DB_BYTES', limit)
    with TestClient(main.app) as client:
        assert client.get('/health').json() == {'status': 'healthy'}
        rec = main.app.state.history_recorder
        assert rec.get_status().state == 'DISABLED_CONFIG'
        assert rec._thread is None
    assert not (tmp_path / 'unused').exists()
    assert load_history_settings({}).max_db_bytes is None


@pytest.mark.parametrize('directory', ['', '.', '../history', 'relative/path'])
def test_config_disabled_relative_directory(monkeypatch, directory, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('PHASE2D_HISTORY_DIR', directory)
    monkeypatch.setenv('PHASE2D_HISTORY_MAX_DB_BYTES', str(LIMIT))
    with TestClient(main.app) as client:
        assert client.get('/health').status_code == 200
        assert main.app.state.history_recorder.get_status().state == 'DISABLED_CONFIG'
    assert list(tmp_path.iterdir()) == []


def test_cwd_and_scene_binding(monkeypatch, recording_env, controlled_background_clock, tmp_path):
    from backend.history.settings import DEFAULT_HISTORY_DIR, load_history_settings
    assert DEFAULT_HISTORY_DIR.is_absolute()
    monkeypatch.chdir(tmp_path)
    assert load_history_settings({}).directory == DEFAULT_HISTORY_DIR
    revision = 'a' * 40
    monkeypatch.setenv('PHASE2D_CODE_REVISION', revision)
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        actual = client.get('/api/scene').json()
        initial = client.get('/api/fleet').json()
    metadata = rows(recording_env, 'SELECT * FROM history_sessions')[0]
    assert metadata['code_revision'] == revision
    assert json.loads(metadata['scene_json']) == actual
    assert metadata['session_id'] == initial['session_id']
    road = next(f for f in actual['features']['features'] if f['id'] == 'ROAD_001')
    assert len(road['geometry']['coordinates']) > 3
    assert metadata['snapshot_count'] == 1


def test_startup_timeout_live_continues_and_late_ack_cannot_reactivate(
    monkeypatch, recording_env, controlled_background_clock,
):
    import threading
    from backend.history.store import HistoryStore
    original_begin = HistoryStore.begin
    original_recorder = main.HistoryRecorder
    entered, release = threading.Event(), threading.Event()
    def blocked_begin(store, *args):
        entered.set()
        assert release.wait(5)
        return original_begin(store, *args)
    def timed_recorder(*args):
        rec = original_recorder(*args)
        rec._start_timeout = 0
        return rec
    monkeypatch.setattr(HistoryStore, 'begin', blocked_begin)
    monkeypatch.setattr(main, 'HistoryRecorder', timed_recorder)
    try:
        with TestClient(main.app) as client:
            wait_for_background_sleep(client, controlled_background_clock)
            rec = main.app.state.history_recorder
            assert rec.get_status().error_code == 'START_TIMEOUT'
            assert entered.wait(3)
            release_background_tick(client, controlled_background_clock)
            assert client.get('/api/fleet').json()['sequence'] == 1
            assert client.get('/health').status_code == 200
            release.set()
            client.portal.call(rec.finish, 'NORMAL_SHUTDOWN')
            assert not rec._thread.is_alive()
            assert rec.get_status().state == 'FAILED'
            assert rec.get_status().last_offered_sequence == 0
    finally:
        release.set()
    stored = rows(recording_env)
    assert [r['sequence'] for r in stored] == [0]
    assert rows(recording_env, 'SELECT state FROM history_sessions')[0]['state'] == 'FAILED'


@pytest.mark.parametrize('stage', ['seq0', 'append'])
def test_real_sqlite_failure_live_continues(
    monkeypatch, recording_env, controlled_background_clock, stage,
):
    from backend.history.store import HistoryStore
    real_begin = HistoryStore.begin
    def failing_begin(store, context, initial):
        if stage == 'seq0':
            store._db.execute("CREATE TRIGGER fail_initial BEFORE INSERT ON history_snapshots BEGIN SELECT RAISE(ABORT,'seq0 disk failure'); END")
        result = real_begin(store, context, initial)
        if stage == 'append':
            store._db.execute("CREATE TRIGGER fail_next BEFORE INSERT ON history_snapshots WHEN NEW.sequence=1 BEGIN SELECT RAISE(ABORT,'append disk failure'); END")
        return result
    monkeypatch.setattr(HistoryStore, 'begin', failing_begin)
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        rec = main.app.state.history_recorder
        for _ in range(3):
            release_background_tick(client, controlled_background_clock)
        client.portal.call(rec.finish, 'NORMAL_SHUTDOWN')
        assert rec.get_status().state == 'FAILED'
        assert client.get('/api/fleet').json()['sequence'] == 3
        assert client.get('/health').status_code == 200
        assert not main.app.state.simulation_unavailable
        assert rec.diagnostics
    assert [r['sequence'] for r in rows(recording_env)] == ([] if stage == 'seq0' else [0])
    if stage == 'append':
        assert rows(recording_env, 'SELECT state FROM history_sessions')[0]['state'] == 'FAILED'


def test_queue_full_live_continues(monkeypatch, recording_env, controlled_background_clock):
    import threading
    from dataclasses import replace
    from backend.history.store import HistoryStore
    from backend.history.settings import load_history_settings
    entered, release = threading.Event(), threading.Event()
    original = HistoryStore.append
    def blocked(store, snapshot):
        entered.set()
        assert release.wait(5)
        return original(store, snapshot)
    monkeypatch.setattr(HistoryStore, 'append', blocked)
    monkeypatch.setattr(main, 'load_history_settings', lambda env: replace(load_history_settings(env), queue_capacity=2))
    try:
        with TestClient(main.app) as client:
            wait_for_background_sleep(client, controlled_background_clock)
            rec = main.app.state.history_recorder
            release_background_tick(client, controlled_background_clock)
            assert entered.wait(3)
            for _ in range(4):
                release_background_tick(client, controlled_background_clock)
            assert client.get('/api/fleet').json()['sequence'] == 5
            assert client.get('/health').status_code == 200
            assert rec.get_status().error_code == 'QUEUE_FULL'
            assert rec.get_status().last_offered_sequence == 3
            release.set()
    finally:
        release.set()
    assert [r['sequence'] for r in rows(recording_env)] == [0, 1, 2, 3]
    assert rows(recording_env, 'SELECT state FROM history_sessions')[0]['state'] == 'FAILED'


def test_motion_failure_recording_ends_without_candidate(
    monkeypatch, recording_env, controlled_background_clock,
):
    from starlette.websockets import WebSocketDisconnect
    from backend.simulation.fleet_config import FleetSimulationError
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        release_background_tick(client, controlled_background_clock)
        committed = client.get('/api/fleet').json()
        rec = main.app.state.history_recorder
        def fail(*args, **kwargs):
            raise FleetSimulationError('candidate failed')
        monkeypatch.setattr(main.app.state.fleet_simulator, 'step', fail)
        with client.websocket_connect('/ws/fleet') as fleet_ws:
            with client.websocket_connect('/ws/vehicles') as old_ws:
                assert receive_json_with_timeout(fleet_ws) == committed
                assert receive_json_with_timeout(old_ws) == committed['vehicles'][0]
                client.portal.call(controlled_background_clock[1].put_nowait, None)
                async def done():
                    await asyncio.wait_for(main.app.state.telemetry_task, 3)
                client.portal.call(done)
                for ws in (fleet_ws, old_ws):
                    with pytest.raises(WebSocketDisconnect) as fault:
                        ws.receive_json()
                    assert fault.value.code == 1011
        assert main.app.state.fleet_simulator.get_snapshot() == committed
        for path in ('/health', '/api/fleet', '/api/vehicles/TRUCK_001'):
            assert client.get(path).status_code == 503
        assert client.get('/api/scene').status_code == 200
        assert rec.get_status().state == 'FAILED'
        assert rec.get_status().last_persisted_sequence == 1
    assert [r['sequence'] for r in rows(recording_env)] == [0, 1]
    metadata = rows(recording_env, 'SELECT * FROM history_sessions')[0]
    assert metadata['state'] == 'FAILED'
    assert metadata['failure_code'] == 'MOTION_FAULT'


def test_shutdown_order_late_offers_cannot_restart(monkeypatch, recording_env, controlled_background_clock):
    events = []
    real_finish = main.HistoryRecorder.finish
    real_shutdown = main.StreamSupervisor.shutdown
    async def finish(rec, reason):
        assert main.app.state.telemetry_task.done()
        events.append('producer-stopped')
        await real_finish(rec, reason)
        events.append('history-finished')
    async def shutdown(supervisor):
        events.append('streams-shutdown')
        await real_shutdown(supervisor)
    monkeypatch.setattr(main.HistoryRecorder, 'finish', finish)
    monkeypatch.setattr(main.StreamSupervisor, 'shutdown', shutdown)
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        for _ in range(3):
            release_background_tick(client, controlled_background_clock)
        rec = main.app.state.history_recorder
        snapshot = client.get('/api/fleet').json()
    thread = rec._thread
    assert events == ['producer-stopped', 'history-finished', 'streams-shutdown']
    assert rec.get_status().state == 'COMPLETED'
    assert rec.get_status().last_persisted_sequence == 3
    assert not thread.is_alive()
    snapshot['sequence'] += 1
    snapshot['simulation_time_seconds'] += 1
    assert not rec.offer(snapshot)
    asyncio.run(rec.start(snapshot))
    asyncio.run(rec.finish('NORMAL_SHUTDOWN'))
    assert rec._thread is thread
    assert not thread.is_alive()
    assert len(rows(recording_env)) == 4


def test_shutdown_cleanup_survives_producer_exception(monkeypatch, recording_env):
    entered = asyncio.Event()
    async def broken_producer(*args):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            raise RuntimeError('producer cancellation cleanup failed')
    monkeypatch.setattr(main, '_update_vehicle_state', broken_producer)
    with pytest.raises(RuntimeError, match='producer cancellation cleanup failed'):
        with TestClient(main.app) as client:
            client.portal.call(entered.wait)
            rec = main.app.state.history_recorder
            supervisor = main.app.state.stream_supervisor
    # An unexpected producer teardown error must not skip writer and stream cleanup.
    assert not rec._thread.is_alive()
    assert rec.get_status().state == 'FAILED'
    assert supervisor._updates._closing



def test_offer_precedes_same_commit_notification(monkeypatch, recording_env, controlled_background_clock):
    notified = []
    real_notify = main.FleetUpdates.notify
    async def observe(updates):
        committed = main.app.state.fleet_simulator.get_snapshot()
        assert main.app.state.history_recorder.get_status().last_offered_sequence == committed['sequence']
        notified.append(committed)
        await real_notify(updates)
    monkeypatch.setattr(main.FleetUpdates, 'notify', observe)
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        for _ in range(3):
            release_background_tick(client, controlled_background_clock)
    saved = rows(recording_env)
    assert [json.loads(r['payload_json']) for r in saved[1:]] == notified


def test_shutdown_unconfirmed_does_not_claim_release_and_still_closes_streams(
    monkeypatch, recording_env, controlled_background_clock,
):
    import threading
    from backend.history.store import HistoryStore
    original_append = HistoryStore.append
    entered, release = threading.Event(), threading.Event()
    def blocked(store, snapshot):
        entered.set()
        assert release.wait(5)
        return original_append(store, snapshot)
    monkeypatch.setattr(HistoryStore, 'append', blocked)
    try:
        with TestClient(main.app) as client:
            wait_for_background_sleep(client, controlled_background_clock)
            rec = main.app.state.history_recorder
            rec._finish_timeout = 0
            release_background_tick(client, controlled_background_clock)
            assert entered.wait(3)
            supervisor = main.app.state.stream_supervisor
        assert rec.get_status().state == 'FAILED'
        assert rec.get_status().error_code == 'SHUTDOWN_UNCONFIRMED'
        assert rec._thread.is_alive()
        assert supervisor._updates._closing
        assert main.app.state.telemetry_task.cancelled()
        assert rec.diagnostics
    finally:
        release.set()
        rec._finish_timeout = 5
        asyncio.run(rec.finish('NORMAL_SHUTDOWN'))
    assert not rec._thread.is_alive()
    assert rec.get_status().state == 'FAILED'


@pytest.mark.parametrize('revision', [None, 'not-a-git-sha', 'B' * 40, 'c' * 40])
def test_context_revision_is_explicit_not_invented(monkeypatch, recording_env, controlled_background_clock, revision):
    if revision is not None:
        monkeypatch.setenv('PHASE2D_CODE_REVISION', revision)
    with TestClient(main.app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
    expected = revision if revision == 'c' * 40 else None
    assert rows(recording_env, 'SELECT code_revision FROM history_sessions')[0]['code_revision'] == expected


def test_motion_fault_notifies_ws_while_writer_is_blocked(
    monkeypatch, recording_env, controlled_background_clock,
):
    import threading
    from backend.history.store import HistoryStore
    from starlette.websockets import WebSocketDisconnect
    original_append = HistoryStore.append
    entered, release = threading.Event(), threading.Event()
    def blocked(store, snapshot):
        entered.set()
        assert release.wait(5)
        return original_append(store, snapshot)
    monkeypatch.setattr(HistoryStore, 'append', blocked)
    try:
        with TestClient(main.app) as client:
            wait_for_background_sleep(client, controlled_background_clock)
            release_background_tick(client, controlled_background_clock)
            assert entered.wait(3)
            rec = main.app.state.history_recorder
            def fail(*args, **kwargs):
                raise ValueError('motion failed while writer blocked')
            monkeypatch.setattr(main.app.state.fleet_simulator, 'step', fail)
            with client.websocket_connect('/ws/fleet') as ws:
                assert receive_json_with_timeout(ws)['sequence'] == 1
                client.portal.call(controlled_background_clock[1].put_nowait, None)
                async def closed():
                    return await asyncio.wait_for(ws._send_rx.receive(), 1)
                message = client.portal.call(closed)
                assert message['type'] == 'websocket.close'
                assert message['code'] == 1011
                assert client.get('/health').status_code == 503
                assert rec.get_status().error_code == 'MOTION_FAULT'
                assert rec._thread.is_alive()
                assert not main.app.state.telemetry_task.done()
                release.set()
                async def done():
                    await asyncio.wait_for(main.app.state.telemetry_task, 3)
                client.portal.call(done)
    finally:
        release.set()
    assert [r['sequence'] for r in rows(recording_env)] == [0, 1]
    assert rows(recording_env, 'SELECT failure_code FROM history_sessions')[0]['failure_code'] == 'MOTION_FAULT'


def test_shutdown_stops_producer_before_blocked_queue_drain(
    monkeypatch, recording_env, controlled_background_clock,
):
    import threading
    from backend.history.store import HistoryStore
    entered, release = threading.Event(), threading.Event()
    real_append = HistoryStore.append
    def blocked(store, snapshot):
        entered.set()
        assert release.wait(5)
        return real_append(store, snapshot)
    monkeypatch.setattr(HistoryStore, 'append', blocked)
    async def scenario():
        manager = main.lifespan(main.app)
        await manager.__aenter__()
        producer = main.app.state.telemetry_task
        rec = main.app.state.history_recorder
        try:
            assert await asyncio.wait_for(controlled_background_clock[0].get(), 1) == 1.0
            for _ in range(3):
                controlled_background_clock[1].put_nowait(None)
                assert await asyncio.wait_for(controlled_background_clock[0].get(), 1) == 1.0
            assert await asyncio.to_thread(entered.wait, 3)
            closing = asyncio.create_task(manager.__aexit__(None, None, None))
            async def stopping():
                while rec.get_status().state != 'STOPPING':
                    await asyncio.sleep(0)
            await asyncio.wait_for(stopping(), 1)
            assert producer.cancelled()
            assert rec._thread.is_alive()
            assert not closing.done()
            assert not rec.offer(main.app.state.fleet_simulator.get_snapshot())
            release.set()
            await asyncio.wait_for(closing, 3)
            assert rec.get_status().state == 'COMPLETED'
            assert not rec._thread.is_alive()
        finally:
            release.set()
            await manager.__aexit__(None, None, None)
    asyncio.run(scenario())
    assert [r['sequence'] for r in rows(recording_env)] == [0, 1, 2, 3]


def test_recording_configuration_default_is_disabled():
    import os
    keys = ('PHASE2D_HISTORY_DIR', 'PHASE2D_HISTORY_MAX_DB_BYTES', 'PHASE2D_CODE_REVISION')
    remaining_keys = [key for key in keys if key in os.environ]
    assert remaining_keys == []
    # Only the actual recording keys may be cleared, not an unrelated test marker.
    assert os.environ.get('PHASE2D_TEST_SENTINEL', 'preserve') == 'preserve'
    with TestClient(main.app) as client:
        assert client.get('/health').status_code == 200
        rec = main.app.state.history_recorder
        assert rec.get_status().state == 'DISABLED_CONFIG'
        assert rec._thread is None


def test_inherited_environment_subprocess_isolation(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path
    forbidden = tmp_path / 'inherited-business-directory'
    env = os.environ.copy()
    env.update(PHASE2D_HISTORY_DIR=str(forbidden),
               PHASE2D_HISTORY_MAX_DB_BYTES=str(LIMIT),
               PHASE2D_CODE_REVISION='a' * 40,
               PHASE2D_TEST_SENTINEL='preserve')
    result = subprocess.run(
        [sys.executable, '-m', 'pytest', str(Path(__file__).resolve()), '-q',
         '-k', 'configuration_default_is_disabled or initial_and_each_commit_record_once_without_clients',
         '--basetemp', str(tmp_path / 'child-pytest')],
        cwd=Path(__file__).resolve().parents[2], env=env, capture_output=True,
        text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '2 passed' in result.stdout
    assert not forbidden.exists()
