"""Recorder tests use actual SQLite and controlled thread/async boundaries."""
import asyncio
import json
import sqlite3
import threading
from copy import deepcopy
from pathlib import Path

import pytest

from backend.history.models import HistorySettings, RecordingContext
from backend.history.recorder import HistoryRecorder
from backend.history.store import HistoryStore
from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS

SESSION = "22345678-1234-4abc-8abc-123456789abc"
STAMP = "2026-10-18T08:00:00+00:00"
LIMIT = 16 * 1024 * 1024


@pytest.fixture
def initial():
    return {
        "schema_version": 1, "session_id": SESSION, "sequence": 0,
        "timestamp": STAMP, "simulation_time_seconds": 0.0,
        "vehicles": [
            {"vehicle_id": f"TRUCK_{i:03}", "timestamp": STAMP,
             "longitude": 116.39, "latitude": 39.90, "height": 50.0,
             "heading": 45.0, "speed": 25.0, "soc": float(100 - i * 10),
             "load": 65.0, "status": "running"} for i in range(1, 4)
        ],
    }


@pytest.fixture
def setup(tmp_path):
    context = RecordingContext(SESSION, STAMP, load_scene(DEFAULT_SCENE_PATH).get_payload(),
                               DEFAULT_VEHICLE_CONFIGS, None)
    return HistorySettings(tmp_path, LIMIT), context


def snapshot(initial, sequence):
    value = deepcopy(initial)
    value["sequence"] = sequence
    value["simulation_time_seconds"] = float(sequence)
    return value


def read_rows(settings, sql):
    with sqlite3.connect(settings.directory / "fleet-history.sqlite3") as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(sql)]


async def reached(event):
    async def wait():
        while not event.is_set():
            await asyncio.sleep(0)
    await asyncio.wait_for(wait(), 3)


def test_seq0_persisted_before_recording_and_one_owner(setup, initial, monkeypatch):
    settings, context = setup
    entered, release = threading.Event(), threading.Event()
    original = HistoryStore.begin
    owners = []
    def controlled(store, context, value):
        owners.append(threading.get_ident())
        entered.set()
        assert release.wait(5)
        original(store, context, value)
    monkeypatch.setattr(HistoryStore, "begin", controlled)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        start = asyncio.create_task(rec.start(initial))
        try:
            await reached(entered)
            status = rec.get_status()
            assert status.state == "STARTING"
            assert status.last_persisted_sequence is None
            assert not rec.offer(snapshot(initial, 1))
            # A real event-loop callback runs while the storage worker is blocked.
            tick = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(tick.set_result, "loop-alive")
            assert await tick == "loop-alive"
            release.set()
            await start
            assert rec.get_status().state == "RECORDING"
            assert rec.get_status().last_persisted_sequence == 0
            assert read_rows(settings, "SELECT sequence FROM history_snapshots") == [{"sequence": 0}]
            assert len(owners) == 1 and owners[0] != threading.get_ident()
        finally:
            release.set()
            await start
            await rec.finish("NORMAL_SHUTDOWN")
    asyncio.run(scenario())


def test_shutdown_drains_and_releases_sqlite_and_os_lock(setup, initial):
    settings, context = setup
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        assert rec.offer(snapshot(initial, 2))
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "COMPLETED"
        assert rec.get_status().last_persisted_sequence == 2
        assert read_rows(settings, "SELECT state,snapshot_count FROM history_sessions") == [
            {"state": "COMPLETED", "snapshot_count": 3}]
        assert not rec._thread.is_alive()
        other = HistoryStore(settings.directory / "fleet-history.sqlite3", max_db_bytes=LIMIT)
        other.close()
    asyncio.run(scenario())

def block_first_append(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = HistoryStore.append
    def controlled(store, value):
        if value["sequence"] == 1:
            entered.set()
            assert release.wait(5)
        original(store, value)
    monkeypatch.setattr(HistoryStore, "append", controlled)
    return entered, release


def test_overflow_stops_only_recording_preserves_prefix(setup, initial, monkeypatch):
    from dataclasses import replace
    settings, context = setup
    settings = replace(settings, queue_capacity=2)
    entered, release = block_first_append(monkeypatch)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        try:
            assert rec.offer(snapshot(initial, 1))
            await reached(entered)
            assert rec.offer(snapshot(initial, 2))
            assert rec.offer(snapshot(initial, 3))
            assert not rec.offer(snapshot(initial, 4))
            assert not rec.offer(snapshot(initial, 5))
            assert rec.get_status().state == "FAILED"
            assert rec.get_status().last_offered_sequence == 3
            assert rec.get_status().last_persisted_sequence == 0
            heartbeat = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(heartbeat.set_result, 1)
            assert await heartbeat == 1
        finally:
            release.set()
            await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().last_persisted_sequence == 3
        assert read_rows(settings, "SELECT sequence FROM history_snapshots ORDER BY sequence") == [
            {"sequence": i} for i in range(4)]
        assert read_rows(settings, "SELECT state FROM history_sessions") == [{"state": "FAILED"}]
    asyncio.run(scenario())


def test_snapshot_detached_before_worker_append(setup, initial, monkeypatch):
    settings, context = setup
    entered, release = block_first_append(monkeypatch)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        offered = snapshot(initial, 1)
        expected = deepcopy(offered)
        try:
            assert rec.offer(offered)
            await reached(entered)
            offered["sequence"] = 88
            offered["vehicles"][0]["longitude"] = 1
        finally:
            release.set()
            await rec.finish("NORMAL_SHUTDOWN")
        saved = read_rows(settings, "SELECT payload_json FROM history_snapshots WHERE sequence=1")[0]
        assert json.loads(saved["payload_json"]) == expected
    asyncio.run(scenario())


@pytest.mark.parametrize("sequence,time", [(0, 1), (2, 2), (1, 0), (True, 1)])
def test_offer_rejects_order_and_closes_gate(setup, initial, sequence, time):
    settings, context = setup
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        bad = snapshot(initial, 1)
        bad["sequence"], bad["simulation_time_seconds"] = sequence, time
        try:
            assert not rec.offer(bad)
            assert rec.get_status().state == "FAILED"
            assert not rec.offer(snapshot(initial, 1))
        finally:
            await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().last_persisted_sequence == 0
    asyncio.run(scenario())


@pytest.mark.parametrize("failed_mark", [False, True])
def test_write_failure_real_sqlite_and_failed_marker(setup, initial, monkeypatch, failed_mark):
    settings, context = setup
    original = HistoryStore.begin
    failed_write = threading.Event()
    def controlled(store, context, value):
        original(store, context, value)
        store._db.execute("""CREATE TRIGGER reject_packet BEFORE INSERT ON history_snapshots
            WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'packet-failure'); END""")
        if failed_mark:
            store._db.execute("""CREATE TRIGGER reject_failed BEFORE UPDATE ON history_sessions
                WHEN NEW.state='FAILED' BEGIN SELECT RAISE(ABORT,'marker-failure'); END""")
    original_append = HistoryStore.append
    def observed(store, value):
        try:
            original_append(store, value)
        except Exception:
            failed_write.set()
            raise
    monkeypatch.setattr(HistoryStore, "begin", controlled)
    monkeypatch.setattr(HistoryStore, "append", observed)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        try:
            assert rec.offer(snapshot(initial, 1))
            assert rec.offer(snapshot(initial, 2))
            await reached(failed_write)
        finally:
            await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().last_persisted_sequence == 1
        assert not rec.offer(snapshot(initial, 3))
        assert read_rows(settings, "SELECT sequence FROM history_snapshots ORDER BY sequence") == [
            {"sequence": 0}, {"sequence": 1}]
        assert read_rows(settings, "SELECT state FROM history_sessions") == [
            {"state": "RECORDING" if failed_mark else "FAILED"}]
        errors = rec.diagnostics
        assert any(isinstance(error.__cause__, sqlite3.Error) for error in errors)
        if failed_mark:
            assert len(errors) >= 2
    asyncio.run(scenario())


@pytest.mark.parametrize("kind", ["vehicles", "bytes", "metadata"])
def test_payload_bound_fails_without_false_recording(setup, initial, kind):
    settings, context = setup
    value = deepcopy(initial)
    if kind == "vehicles":
        value["vehicles"] = [dict(initial["vehicles"][0], vehicle_id=f"TRUCK_{i:03}")
                             for i in range(101)]
    elif kind == "bytes":
        value["vehicles"] = [dict(initial["vehicles"][0], vehicle_id=f"TRUCK_{i:03}",
                                  height=10**300, load=10**300) for i in range(100)]
    else:
        scene = load_scene(DEFAULT_SCENE_PATH).get_payload()
        scene["padding"] = "x" * (4 * 1024 * 1024)
        context = RecordingContext(SESSION, STAMP, scene, DEFAULT_VEHICLE_CONFIGS, None)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(value)
        try:
            assert rec.get_status().state == "FAILED"
            assert rec.get_status().last_persisted_sequence is None
        finally:
            await rec.finish("NORMAL_SHUTDOWN")
    asyncio.run(scenario())


def test_shutdown_motion_fault_drains_and_duplicate_finish_is_stable(setup, initial):
    settings, context = setup
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await asyncio.gather(rec.finish("MOTION_FAULT"), rec.finish("NORMAL_SHUTDOWN"))
        first = rec.get_status()
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status() == first
        assert first.state == "FAILED"
        assert first.last_persisted_sequence == 1
        assert read_rows(settings, "SELECT state,failure_code FROM history_sessions") == [
            {"state": "FAILED", "failure_code": "MOTION_FAULT"}]
    asyncio.run(scenario())

def test_startup_timeout_late_ack_never_revives(setup, initial, monkeypatch):
    settings, context = setup
    entered, release = threading.Event(), threading.Event()
    original = HistoryStore.begin
    def blocked(store, ctx, value):
        entered.set()
        assert release.wait(5)
        original(store, ctx, value)
    monkeypatch.setattr(HistoryStore, "begin", blocked)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        rec._start_timeout = 0  # Blocked ack guarantees deterministic budget exhaustion.
        start = asyncio.create_task(rec.start(initial))
        try:
            await reached(entered)
            await asyncio.wait_for(start, 1)
            assert rec.get_status().state == "FAILED"
            assert rec.get_status().error_code == "START_TIMEOUT"
            assert rec.get_status().last_persisted_sequence is None
            assert not rec.offer(snapshot(initial, 1))
        finally:
            release.set()
            await start
            await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().last_persisted_sequence == 0
        assert not rec._thread.is_alive()
        assert read_rows(settings, "SELECT state FROM history_sessions") == [{"state": "FAILED"}]
    asyncio.run(scenario())


def test_shutdown_unconfirmed_preserves_owner_then_final_exit(setup, initial, monkeypatch):
    from backend.history.models import HistoryError
    settings, context = setup
    entered, release = block_first_append(monkeypatch)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await reached(entered)
        try:
            rec._finish_timeout = 0
            await rec.finish("NORMAL_SHUTDOWN")
            assert rec.get_status().state == "FAILED"
            assert rec.get_status().error_code == "SHUTDOWN_UNCONFIRMED"
            assert rec.get_status().last_persisted_sequence == 0
            assert rec._thread.is_alive()
            with pytest.raises(HistoryError) as error:
                HistoryStore(settings.directory / "fleet-history.sqlite3", max_db_bytes=LIMIT)
            assert error.value.code == "WRITER_LOCKED"
            assert not rec.offer(snapshot(initial, 2))
        finally:
            release.set()
            rec._finish_timeout = 5
            await rec.finish("NORMAL_SHUTDOWN")
        assert not rec._thread.is_alive()
        assert rec.get_status().state == "FAILED"  # No false recovery to COMPLETED.
        assert rec.get_status().last_persisted_sequence == 1
        other = HistoryStore(settings.directory / "fleet-history.sqlite3", max_db_bytes=LIMIT)
        other.close()
    asyncio.run(scenario())


def test_start_cancellation_stops_late_startup(setup, initial, monkeypatch):
    settings, context = setup
    entered, release = threading.Event(), threading.Event()
    original = HistoryStore.begin
    def blocked(store, ctx, value):
        entered.set()
        assert release.wait(5)
        original(store, ctx, value)
    monkeypatch.setattr(HistoryStore, "begin", blocked)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        start = asyncio.create_task(rec.start(initial))
        try:
            await reached(entered)
            start.cancel()
            with pytest.raises(asyncio.CancelledError):
                await start
            assert rec.get_status().state == "FAILED"
            assert rec.get_status().error_code == "START_CANCELLED"
        finally:
            release.set()
            await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
    asyncio.run(scenario())


def test_shutdown_cancellation_keeps_worker_cleanup_independent(setup, initial, monkeypatch):
    settings, context = setup
    entered, release = block_first_append(monkeypatch)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await reached(entered)
        finish = asyncio.create_task(rec.finish("NORMAL_SHUTDOWN"))
        try:
            # One loop turn starts finish and closes its ingress gate.
            await asyncio.sleep(0)
            finish.cancel()
            with pytest.raises(asyncio.CancelledError):
                await finish
            assert not rec.offer(snapshot(initial, 2))
            assert not rec._done.cancelled()
        finally:
            release.set()
            await rec.finish("NORMAL_SHUTDOWN")
        assert not rec._thread.is_alive()
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().error_code == "SHUTDOWN_CANCELLED"
    asyncio.run(scenario())


@pytest.mark.parametrize("quota,capacity", [(None, 128), (True, 128), (LIMIT, 0), (LIMIT, True)])
def test_disabled_config_never_creates_storage(setup, initial, quota, capacity):
    from dataclasses import replace
    settings, context = setup
    settings = replace(settings, directory=settings.directory / "must-not-create",
                       max_db_bytes=quota, queue_capacity=capacity)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "DISABLED_CONFIG"
        assert not rec.get_status().enabled
        assert not settings.directory.exists()
        assert rec._thread is None
    asyncio.run(scenario())


def test_finish_before_start_and_repeated_start_never_create_second_writer(setup, initial):
    settings, context = setup
    async def scenario():
        rec = HistoryRecorder(settings, context)
        rec._finish_timeout = 0
        await asyncio.wait_for(rec.finish("NORMAL_SHUTDOWN"), 1)
        await rec.start(initial)
        assert rec.get_status().state == "FAILED"
        assert rec._thread is None
        assert not (settings.directory / "fleet-history.sqlite3").exists()
    asyncio.run(scenario())


def test_synchronous_worker_reentry_does_not_self_join(setup, initial, monkeypatch):
    settings, context = setup
    original = HistoryStore.begin
    calls = []
    holder = {}
    def controlled(store, ctx, value):
        original(store, ctx, value)
        calls.append(threading.get_ident())
        async def reenter():
            await holder["rec"].finish("MOTION_FAULT")
            await holder["rec"].start(value)
        asyncio.run(reenter())
    monkeypatch.setattr(HistoryStore, "begin", controlled)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        holder["rec"] = rec
        try:
            await asyncio.wait_for(rec.start(initial), 1)
        finally:
            await asyncio.wait_for(rec.finish("NORMAL_SHUTDOWN"), 1)
        assert rec.get_status().state == "FAILED"
        assert len(calls) == 1
    asyncio.run(scenario())

@pytest.mark.parametrize("exit_code", ["controlled worker exit", 13])
def test_worker_baseexception_cannot_false_complete(setup, initial, monkeypatch, exit_code):
    settings, context = setup
    original = HistoryStore.append
    fatal = SystemExit(exit_code)
    def interrupted(store, value):
        if value["sequence"] == 1:
            raise fatal
        original(store, value)
    monkeypatch.setattr(HistoryStore, "append", interrupted)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().last_persisted_sequence == 0
        assert any(error is fatal for error in rec.diagnostics)
        assert rec.get_status().error_code == "WRITE_FAILED"
        assert read_rows(settings, "SELECT state FROM history_sessions") == [{"state": "FAILED"}]
    asyncio.run(scenario())


def test_shutdown_drains_queue_accounting(setup, initial):
    settings, context = setup
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec._queue.unfinished_tasks == 0
    asyncio.run(scenario())


def test_secondary_failed_marker_and_close_errors_are_retained(setup, initial, monkeypatch):
    settings, context = setup
    begin = HistoryStore.begin
    close = HistoryStore.close
    secondary = OSError("controlled close diagnostic")
    def controlled(store, ctx, value):
        begin(store, ctx, value)
        store._db.execute("""CREATE TRIGGER reject_packet BEFORE INSERT ON history_snapshots
            WHEN NEW.sequence=1 BEGIN SELECT RAISE(ABORT,'packet-failure'); END""")
        store._db.execute("""CREATE TRIGGER reject_failed BEFORE UPDATE ON history_sessions
            WHEN NEW.state='FAILED' BEGIN SELECT RAISE(ABORT,'marker-failure'); END""")
    def uncertain_close(store):
        close(store)  # Use real connection release, then inject diagnostic uncertainty.
        raise secondary
    monkeypatch.setattr(HistoryStore, "begin", controlled)
    monkeypatch.setattr(HistoryStore, "close", uncertain_close)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().last_persisted_sequence == 0
        assert secondary in rec.diagnostics
        assert sum(isinstance(error.__cause__, sqlite3.Error) for error in rec.diagnostics) == 2
        assert read_rows(settings, "SELECT state FROM history_sessions") == [{"state": "RECORDING"}]
    asyncio.run(scenario())


def test_startup_real_sqlite_failure_has_no_seq0_ack(setup, initial, monkeypatch):
    settings, context = setup
    create = HistoryStore.__init__
    def controlled(store, *args, **kwargs):
        create(store, *args, **kwargs)
        store._db.execute("""CREATE TRIGGER reject_initial BEFORE INSERT ON history_snapshots
            BEGIN SELECT RAISE(ABORT,'initial-failure'); END""")
    monkeypatch.setattr(HistoryStore, "__init__", controlled)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().state == "FAILED"
        assert rec.get_status().last_persisted_sequence is None
        assert any(isinstance(error.__cause__, sqlite3.Error) for error in rec.diagnostics)
        assert read_rows(settings, "SELECT * FROM history_sessions") == []
    asyncio.run(scenario())


def test_encoding_and_sql_are_owned_by_one_worker(setup, initial, monkeypatch):
    import backend.history.models as models
    import backend.history.store as storage
    settings, context = setup
    owners = []
    encode = models.canonical_json
    create = HistoryStore.__init__
    def encoded(value):
        owners.append(threading.get_ident())
        return encode(value)
    def created(store, *args, **kwargs):
        owners.append(threading.get_ident())
        create(store, *args, **kwargs)
    monkeypatch.setattr(models, "canonical_json", encoded)
    monkeypatch.setattr(storage, "canonical_json", encoded)
    monkeypatch.setattr(HistoryStore, "__init__", created)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        assert rec._start_timeout == 2 and rec._finish_timeout == 5
        assert rec._queue.maxsize == 128
        await asyncio.gather(rec.start(initial), rec.start(initial))
        thread = rec._thread
        assert rec.offer(snapshot(initial, 1))
        await asyncio.gather(rec.finish("NORMAL_SHUTDOWN"), rec.finish("NORMAL_SHUTDOWN"))
        old = rec.get_status()
        await rec.start(initial)
        await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status() == old
        assert rec._thread is thread and not thread.is_alive()
        assert set(owners) == {thread.ident}
        assert thread.ident != threading.get_ident()
        from dataclasses import FrozenInstanceError
        with pytest.raises(FrozenInstanceError):
            old.state = "RECORDING"
    asyncio.run(scenario())

def sized_snapshot(initial, sequence, target):
    value = snapshot(initial, sequence)
    value["vehicles"] = [
        dict(initial["vehicles"][0], vehicle_id=f"TRUCK_{i:03}", height=1, load=1)
        for i in range(100)]
    def byte_size():
        return len(json.dumps(value, ensure_ascii=False, sort_keys=True,
                              separators=(",", ":"), allow_nan=False).encode("utf-8"))
    remaining = target - byte_size()
    assert remaining >= 0
    for vehicle in value["vehicles"]:
        for field in ("height", "load"):
            digits = min(remaining, 299)
            vehicle[field] = 10**digits
            remaining -= digits
    assert remaining == 0 and byte_size() == target
    return value


@pytest.mark.parametrize("size,accepted", [(65535, True), (65536, True), (65537, False)])
def test_offer_payload_exact_byte_boundary_closes_gate_immediately(
        setup, initial, monkeypatch, size, accepted):
    settings, context = setup
    entered, release = block_first_append(monkeypatch)
    value = sized_snapshot(initial, 2, size)
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        assert rec.offer(snapshot(initial, 1))
        await reached(entered)
        try:
            assert rec.offer(value) is accepted
            assert rec.get_status().state == ("RECORDING" if accepted else "FAILED")
            if not accepted:
                assert rec.get_status().error_code == "PAYLOAD_LIMIT"
                assert not rec.offer(snapshot(initial, 2))
                assert rec.get_status().last_offered_sequence == 1
        finally:
            release.set()
            await rec.finish("NORMAL_SHUTDOWN")
        assert rec.get_status().last_persisted_sequence == (2 if accepted else 1)
        assert read_rows(settings, "SELECT state FROM history_sessions") == [
            {"state": "COMPLETED" if accepted else "FAILED"}]
    asyncio.run(scenario())


@pytest.mark.parametrize("field", ["session_id", "timestamp", "vehicle_id", "status"])
def test_offer_rejects_string_subclass_size_ambiguity(setup, initial, field):
    settings, context = setup
    class AmbiguousLength(str):
        def __len__(self):
            return 0
    async def scenario():
        rec = HistoryRecorder(settings, context)
        await rec.start(initial)
        value = snapshot(initial, 1)
        if field in ("session_id", "timestamp"):
            value[field] = AmbiguousLength(value[field])
        else:
            value["vehicles"][0][field] = AmbiguousLength(value["vehicles"][0][field])
        try:
            assert not rec.offer(value)
            assert rec.get_status().state == "FAILED"
        finally:
            await rec.finish("NORMAL_SHUTDOWN")
    asyncio.run(scenario())
