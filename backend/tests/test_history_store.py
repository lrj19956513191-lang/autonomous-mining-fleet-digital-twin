"""Behavioral storage tests: real SQLite, process locks, isolated temporary paths."""
import hashlib
import json
import sqlite3
from copy import deepcopy
from pathlib import Path

import pytest

from backend.history.models import HistoryError, RecordingContext
from backend.history.store import HistoryStore
from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.simulation.fleet import FleetSimulator
from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS

SESSION = "12345678-1234-4abc-8abc-123456789abc"
STAMP = "2026-10-18T08:00:00+00:00"
LIMIT = 16 * 1024 * 1024


@pytest.fixture
def example():
    scene = load_scene(DEFAULT_SCENE_PATH)
    snapshot = FleetSimulator(scene, vehicle_configs=DEFAULT_VEHICLE_CONFIGS,
                              session_id=SESSION).get_snapshot()
    snapshot["timestamp"] = STAMP
    for vehicle in snapshot["vehicles"]:
        vehicle["timestamp"] = STAMP
    context = RecordingContext(SESSION, STAMP, scene.get_payload(),
                               DEFAULT_VEHICLE_CONFIGS, "3" * 40)
    return context, snapshot


def rows(path, sql, parameters=()):
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(sql, parameters)]


def test_begin_commits_metadata_and_seq0_together(tmp_path, example):
    context, snapshot = example
    path = tmp_path / "fleet-history.sqlite3"
    store = HistoryStore(path, max_db_bytes=LIMIT)
    try:
        store.begin(context, snapshot)
        meta = rows(path, "SELECT * FROM history_sessions")[0]
        saved = rows(path, "SELECT * FROM history_snapshots")[0]
        assert meta["session_id"] == SESSION
        assert meta["state"] == "RECORDING"
        assert meta["snapshot_count"] == 1
        assert meta["last_sequence"] == 0
        assert meta["first_simulation_time"] == meta["last_simulation_time"] == 0
        assert meta["ended_utc"] is None
        assert json.loads(meta["scene_json"]) == load_scene(DEFAULT_SCENE_PATH).get_payload()
        assert json.loads(saved["payload_json"]) == snapshot
        assert saved["sequence"] == 0
        assert saved["payload_sha256"] == hashlib.sha256(
            saved["payload_json"].encode("utf-8")).hexdigest()
    finally:
        store.close()


def test_begin_failure_rolls_back_metadata_and_can_retry(tmp_path, example):
    context, snapshot = example
    path = tmp_path / "fleet-history.sqlite3"
    store = HistoryStore(path, max_db_bytes=LIMIT)
    try:
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TRIGGER fail_initial BEFORE INSERT ON history_snapshots
                          BEGIN SELECT RAISE(ABORT, 'injected initial failure'); END""")
        with pytest.raises(HistoryError) as failure:
            store.begin(context, snapshot)
        assert isinstance(failure.value.__cause__, sqlite3.Error)
        assert rows(path, "SELECT * FROM history_sessions") == []
        assert rows(path, "SELECT * FROM history_snapshots") == []
        with sqlite3.connect(path) as db:
            db.execute("DROP TRIGGER fail_initial")
        store.begin(context, snapshot)
        assert len(rows(path, "SELECT * FROM history_sessions")) == 1
    finally:
        store.close()

def next_snapshot(snapshot, sequence=1, time=1.0):
    value = deepcopy(snapshot)
    value["sequence"] = sequence
    value["simulation_time_seconds"] = time
    return value


@pytest.mark.parametrize("field,value", [
    ("schema_version", True), ("schema_version", 2),
    ("sequence", True), ("sequence", 0.0), ("sequence", -1),
    ("sequence", 9007199254740992), ("session_id", "not-a-uuid"),
    ("session_id", "12345678-1234-4abc-8abc-123456789abd"),
    ("simulation_time_seconds", True), ("simulation_time_seconds", float("nan")),
    ("simulation_time_seconds", float("inf")), ("simulation_time_seconds", 1),
    ("timestamp", "2026-02-30T00:00:00+00:00"),
    ("timestamp", "2026-10-18T08:00:00"), ("timestamp", STAMP + "\n"),
    ("vehicles", {}), ("vehicles", [None]),
])
def test_strict_values_reject_bad_snapshot(tmp_path, example, field, value):
    context, snapshot = example
    snapshot[field] = value
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        with pytest.raises(HistoryError):
            store.begin(context, snapshot)
        assert rows(store.path, "SELECT * FROM history_sessions") == []
    finally:
        store.close()


@pytest.mark.parametrize("field,value", [
    ("longitude", float("nan")), ("height", float("inf")), ("speed", True),
    ("longitude", 181), ("latitude", -91), ("heading", 360),
    ("speed", -1), ("soc", 101), ("load", "65"),
    ("vehicle_id", "TRUCK_001\n"), ("status", "offline"),
    ("timestamp", "2026-10-18T08:00:01+00:00"),
])
def test_strict_values_vehicle_fields(tmp_path, example, field, value):
    context, snapshot = example
    snapshot["vehicles"][0][field] = value
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        with pytest.raises(HistoryError):
            store.begin(context, snapshot)
    finally:
        store.close()


@pytest.mark.parametrize("mutation", ["extra", "missing", "duplicate", "stopped_speed"])
def test_strict_values_structure(tmp_path, example, mutation):
    context, snapshot = example
    if mutation == "extra":
        snapshot["debug"] = 1
    elif mutation == "missing":
        del snapshot["vehicles"][0]["load"]
    elif mutation == "duplicate":
        snapshot["vehicles"].append(deepcopy(snapshot["vehicles"][0]))
    else:
        snapshot["vehicles"][0]["status"] = "stopped"
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        with pytest.raises(HistoryError):
            store.begin(context, snapshot)
    finally:
        store.close()


def test_strict_values_duplicate_json_keys():
    from backend.history.models import parse_json
    for text in ('{"sequence":0,"sequence":1}', '{"x":{"a":1,"a":2}}',
                 '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}', '{'):
        with pytest.raises(HistoryError):
            parse_json(text)


def test_metadata_hashes_and_external_context_isolation(tmp_path, example):
    context, snapshot = example
    scene = load_scene(DEFAULT_SCENE_PATH).get_payload()
    expected_scene = deepcopy(scene)
    context = RecordingContext(SESSION, STAMP, scene, DEFAULT_VEHICLE_CONFIGS, "3" * 40)
    scene["features"]["features"].clear()
    with pytest.raises(TypeError):
        context.scene_payload["mine_id"] = "changed"
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, snapshot)
        meta = rows(store.path, "SELECT * FROM history_sessions")[0]
        assert json.loads(meta["scene_json"]) == expected_scene
        for prefix in ("scene", "config"):
            encoded = meta[prefix + "_json"]
            independent = json.dumps(json.loads(encoded), ensure_ascii=False,
                                     sort_keys=True, separators=(",", ":"), allow_nan=False)
            assert encoded == independent
            assert meta[prefix + "_sha256"] == hashlib.sha256(encoded.encode()).hexdigest()
        assert json.loads(meta["config_json"])[1]["parking"]["start_seconds"] == 60.0
    finally:
        store.close()


def test_metadata_snapshot_is_captured_before_sql_events(tmp_path, example):
    context, snapshot = example
    expected = deepcopy(snapshot)
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        # A real SQLite callback mutates the caller-owned object between the two INSERTs.
        store._db.create_function("mutate_caller", 0,
                                  lambda: snapshot.update(sequence=99) or 0)
        store._db.executescript("""CREATE TRIGGER mutate BEFORE INSERT ON history_sessions
                                  BEGIN SELECT mutate_caller(); END;""")
        store.begin(context, snapshot)
        saved = rows(store.path, "SELECT * FROM history_snapshots")[0]
        assert saved["sequence"] == 0
        assert json.loads(saved["payload_json"]) == expected
        assert snapshot["sequence"] == 99  # The callback really ran.
    finally:
        store.close()


def test_append_atomic_valid_progress_and_utc_correction(tmp_path, example):
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        snapshot = next_snapshot(initial)
        snapshot["timestamp"] = "2026-10-18T07:59:59+00:00"
        for vehicle in snapshot["vehicles"]:
            vehicle["timestamp"] = snapshot["timestamp"]
        store.append(snapshot)
        meta = rows(store.path, "SELECT * FROM history_sessions")[0]
        assert (meta["snapshot_count"], meta["last_sequence"], meta["last_simulation_time"]) == (2, 1, 1)
        assert json.loads(rows(store.path, "SELECT payload_json FROM history_snapshots WHERE sequence=1")[0]["payload_json"]) == snapshot
    finally:
        store.close()


@pytest.mark.parametrize("sequence,time", [(0, 1), (2, 1), (1, 0), (1, -1), (True, 1), (1, float("inf"))])
def test_append_atomic_rejects_invalid_progress(tmp_path, example, sequence, time):
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        with pytest.raises(HistoryError):
            store.append(next_snapshot(initial, sequence, time))
        assert rows(store.path, "SELECT snapshot_count,last_sequence FROM history_sessions") == [
            {"snapshot_count": 1, "last_sequence": 0}]
        assert len(rows(store.path, "SELECT * FROM history_snapshots")) == 1
    finally:
        store.close()


def test_append_atomic_update_failure_rolls_back_insert(tmp_path, example):
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        with sqlite3.connect(store.path) as db:
            db.execute("""CREATE TRIGGER fail_update BEFORE UPDATE ON history_sessions
                          BEGIN SELECT RAISE(ABORT, 'counter failure'); END""")
        with pytest.raises(HistoryError) as error:
            store.append(next_snapshot(initial))
        assert isinstance(error.value.__cause__, sqlite3.Error)
        assert rows(store.path, "SELECT sequence FROM history_snapshots") == [{"sequence": 0}]
        assert rows(store.path, "SELECT snapshot_count FROM history_sessions") == [{"snapshot_count": 1}]
        with sqlite3.connect(store.path) as db:
            db.execute("DROP TRIGGER fail_update")
        store.append(next_snapshot(initial))
        assert len(rows(store.path, "SELECT * FROM history_snapshots")) == 2
    finally:
        store.close()

@pytest.mark.parametrize("quota", [None, True, 1.5, -1, LIMIT - 1, LIMIT + 1])
def test_quota_version_invalid_quota_does_not_create_directory(tmp_path, quota):
    directory = tmp_path / "not-created"
    with pytest.raises(HistoryError):
        HistoryStore(directory / "db", max_db_bytes=quota)
    assert not directory.exists()


@pytest.mark.parametrize("version,foreign_schema", [(7, False), (0, True)])
def test_quota_version_refuses_existing_database_without_overwrite(tmp_path, version, foreign_schema):
    path = tmp_path / "db"
    with sqlite3.connect(path) as db:
        db.execute(f"PRAGMA user_version={version}")
        if foreign_schema:
            db.execute("CREATE TABLE foreign_table (value TEXT)")
            db.execute("INSERT INTO foreign_table VALUES ('preserve')")
    before = path.read_bytes()
    with pytest.raises(HistoryError):
        HistoryStore(path, max_db_bytes=LIMIT)
    assert path.read_bytes() == before


def test_quota_version_real_sqlite_full_preserves_last_commit(tmp_path, example):
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        assert store._db.execute("PRAGMA max_page_count").fetchone()[0] * store._db.execute(
            "PRAGMA page_size").fetchone()[0] == LIMIT
        assert store._db.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert store._db.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert store._db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        # Real disk-page pressure, not a mock SQLITE_FULL.
        store._db.execute("CREATE TABLE padding (data BLOB)")
        store._db.execute("INSERT INTO padding VALUES (zeroblob(?))", (LIMIT - 512 * 1024,))
        last = 0
        for sequence in range(1, 65):
            snapshot = next_snapshot(initial, sequence, float(sequence))
            snapshot["vehicles"] = [dict(initial["vehicles"][0], vehicle_id=f"TRUCK_{i:03}")
                                    for i in range(100)]
            try:
                store.append(snapshot)
                last = sequence
            except HistoryError as error:
                assert isinstance(error.__cause__, sqlite3.Error)
                assert error.__cause__.sqlite_errorcode == sqlite3.SQLITE_FULL
                break
        else:
            pytest.fail("Real SQLite never enforced the database size limit")
        assert store.path.stat().st_size <= LIMIT
        assert rows(store.path, "SELECT last_sequence,snapshot_count FROM history_sessions") == [
            {"last_sequence": last, "snapshot_count": last + 1}]
        assert rows(store.path, "SELECT MAX(sequence) AS n FROM history_snapshots") == [{"n": last}]
    finally:
        store.close()


def test_quota_version_existing_oversized_database_is_not_truncated(tmp_path, example):
    context, initial = example
    path = tmp_path / "db"
    store = HistoryStore(path, max_db_bytes=2 * LIMIT)
    store.begin(context, initial)
    store._db.execute("CREATE TABLE padding (data BLOB)")
    store._db.execute("INSERT INTO padding VALUES (zeroblob(?))", (LIMIT + 100000,))
    store.close()
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(HistoryError):
        HistoryStore(path, max_db_bytes=LIMIT)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_writer_lock_actual_other_process_cannot_open_or_recover(tmp_path, example):
    import subprocess
    import sys
    context, initial = example
    path = tmp_path / "db"
    store = HistoryStore(path, max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        child = """import sys
from pathlib import Path
from backend.history.models import HistoryError
from backend.history.store import HistoryStore
try:
    store=HistoryStore(Path(sys.argv[1]),max_db_bytes=int(sys.argv[2]))
except HistoryError as error:
    print(error.code)
else:
    store.close()
    print('UNEXPECTED_OPEN')
"""
        result = subprocess.run([sys.executable, "-B", "-c", child, str(path), str(LIMIT)],
                                capture_output=True, text=True, timeout=8)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "WRITER_LOCKED"
        assert rows(path, "SELECT state,ended_utc FROM history_sessions") == [
            {"state": "RECORDING", "ended_utc": None}]
    finally:
        store.close()
    # After actual owner release, opening is allowed.
    reopened = HistoryStore(path, max_db_bytes=LIMIT)
    reopened.close()


def test_recover_after_actual_owner_process_termination(tmp_path, example):
    import subprocess
    import sys
    context, snapshot = example
    path = tmp_path / "db"
    child = """import json,sys,os
from pathlib import Path
from backend.history.models import RecordingContext
from backend.history.store import HistoryStore
from backend.scene.loader import DEFAULT_SCENE_PATH,load_scene
from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS
snapshot=json.loads(sys.stdin.readline())
context=RecordingContext(snapshot['session_id'],snapshot['timestamp'],
load_scene(DEFAULT_SCENE_PATH).get_payload(),DEFAULT_VEHICLE_CONFIGS,None)
store=HistoryStore(Path(sys.argv[1]),max_db_bytes=int(sys.argv[2]))
store.begin(context,snapshot)
print('READY',flush=True)
sys.stdin.readline()
os._exit(73)
"""
    process = subprocess.Popen([sys.executable, "-B", "-c", child, str(path), str(LIMIT)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True)
    try:
        process.stdin.write(json.dumps(snapshot) + "\n")
        process.stdin.flush()
        # communicate timeout bounds the setup; a reader thread prevents blocking readline.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(process.stdout.readline)
            try:
                assert pending.result(timeout=8).strip() == "READY"
            finally:
                if not pending.done():
                    process.terminate()
        process.stdin.write("CRASH\n")
        process.stdin.flush()
        assert process.wait(timeout=5) == 73  # Actual lock owner exited without close().
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()
    store = HistoryStore(path, max_db_bytes=LIMIT)
    try:
        assert rows(path, "SELECT state FROM history_sessions") == [{"state": "RECORDING"}]
        store.recover()
        meta = rows(path, "SELECT * FROM history_sessions")[0]
        assert meta["state"] == "INTERRUPTED"
        assert meta["failure_code"] == "UNCLEAN_SHUTDOWN"
        assert meta["ended_utc"] is not None
        assert meta["snapshot_count"] == 1
        assert json.loads(rows(path, "SELECT payload_json FROM history_snapshots")[0]["payload_json"]) == snapshot
        ended = meta["ended_utc"]
        store.recover()
        assert rows(path, "SELECT ended_utc FROM history_sessions") == [{"ended_utc": ended}]
    finally:
        store.close()


def test_recover_preserves_completed_and_failed_sessions(tmp_path, example):
    context, snapshot = example
    path = tmp_path / "db"
    store = HistoryStore(path, max_db_bytes=LIMIT)
    store.begin(context, snapshot)
    store.finish("COMPLETED", None)
    before = rows(path, "SELECT * FROM history_sessions")
    with pytest.raises(HistoryError):
        store.append(next_snapshot(snapshot))
    with pytest.raises(HistoryError):
        store.finish("FAILED", "MOTION_FAULT")
    store.close()
    store = HistoryStore(path, max_db_bytes=LIMIT)
    try:
        store.recover()
        assert rows(path, "SELECT * FROM history_sessions") == before
    finally:
        store.close()


def test_recover_failed_finish_is_atomic(tmp_path, example):
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        with sqlite3.connect(store.path) as db:
            db.execute("""CREATE TRIGGER fail_finish BEFORE UPDATE ON history_sessions
                          BEGIN SELECT RAISE(ABORT, 'finish failure'); END""")
        with pytest.raises(HistoryError) as error:
            store.finish("FAILED", "MOTION_FAULT")
        assert isinstance(error.value.__cause__, sqlite3.Error)
        assert rows(store.path, "SELECT state,ended_utc FROM history_sessions") == [
            {"state": "RECORDING", "ended_utc": None}]
        with sqlite3.connect(store.path) as db:
            db.execute("DROP TRIGGER fail_finish")
        store.finish("FAILED", "MOTION_FAULT")
        assert rows(store.path, "SELECT state,failure_code FROM history_sessions") == [
            {"state": "FAILED", "failure_code": "MOTION_FAULT"}]
    finally:
        store.close()

def test_append_atomic_rejects_unrepresentable_index_time(tmp_path, example):
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        store.begin(context, initial)
        # Finite as float, but cannot preserve the indexed integer's exact value.
        with pytest.raises(HistoryError):
            store.append(next_snapshot(initial, 1, 10**100))
        assert rows(store.path, "SELECT last_sequence FROM history_sessions") == [{"last_sequence": 0}]
    finally:
        store.close()


def test_write_failure_disk_probe_diagnostic_and_retry(tmp_path, example, monkeypatch):
    import backend.history.store as module
    context, initial = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        real = module.shutil.disk_usage
        def denied(_):
            raise OSError("injected disk probe failure")
        monkeypatch.setattr(module.shutil, "disk_usage", denied)
        with pytest.raises(HistoryError) as error:
            store.begin(context, initial)
        assert isinstance(error.value.__cause__, OSError)
        assert rows(store.path, "SELECT * FROM history_sessions") == []
        monkeypatch.setattr(module.shutil, "disk_usage", real)
        store.begin(context, initial)
    finally:
        store.close()


def test_strict_values_invalid_utf8_is_structured():
    from backend.history.models import canonical_json
    with pytest.raises(HistoryError):
        canonical_json({"bad": "\ud800"})


def test_owner_thread_and_closed_operations(tmp_path, example):
    from concurrent.futures import ThreadPoolExecutor
    context, snapshot = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            for action in (lambda: store.begin(context, snapshot), store.recover, store.close):
                with pytest.raises(HistoryError) as error:
                    pool.submit(action).result(timeout=3)
                assert error.value.code == "WRONG_THREAD"
        store.begin(context, snapshot)
    finally:
        store.close()
    store.close()
    with pytest.raises(HistoryError):
        store.append(next_snapshot(snapshot))


def test_close_failure_keeps_lock_until_successful_release(tmp_path, example):
    context, snapshot = example
    store = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    store.begin(context, snapshot)
    real = store._db
    class CloseFailure:
        def close(self):
            raise sqlite3.OperationalError("injected close failure")
    store._db = CloseFailure()
    try:
        with pytest.raises(HistoryError) as error:
            store.close()
        assert error.value.code == "CLEANUP_UNCONFIRMED"
        assert isinstance(error.value.__cause__, sqlite3.Error)
        with pytest.raises(HistoryError) as locked:
            HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
        assert locked.value.code == "WRITER_LOCKED"
    finally:
        store._db = real
        store.close()
    reopened = HistoryStore(tmp_path / "db", max_db_bytes=LIMIT)
    reopened.close()
