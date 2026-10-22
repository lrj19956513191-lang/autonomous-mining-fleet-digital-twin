"""SQLite transactions and a process-exclusive, thread-owned writer."""
import os
import re
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from backend.history.models import RecordingContext, HistoryError, canonical_json, digest, capture_snapshot

SCHEMA = """
CREATE TABLE history_sessions (
 session_id TEXT PRIMARY KEY NOT NULL,
 storage_version INTEGER NOT NULL CHECK(storage_version=1),
 fleet_schema_version INTEGER NOT NULL CHECK(fleet_schema_version=1),
 state TEXT NOT NULL CHECK(state IN ('RECORDING','COMPLETED','FAILED','INTERRUPTED')),
 started_utc TEXT NOT NULL, ended_utc TEXT,
 code_revision TEXT, scene_json TEXT NOT NULL, config_json TEXT NOT NULL,
 scene_sha256 TEXT NOT NULL, config_sha256 TEXT NOT NULL,
 snapshot_count INTEGER NOT NULL CHECK(snapshot_count>=1),
 last_sequence INTEGER NOT NULL CHECK(last_sequence>=0),
 first_simulation_time REAL NOT NULL CHECK(first_simulation_time=0),
 last_simulation_time REAL NOT NULL,
 failure_code TEXT, failure_message TEXT,
 CHECK ((state='RECORDING' AND ended_utc IS NULL) OR
        (state<>'RECORDING' AND ended_utc IS NOT NULL))
);
CREATE TABLE history_snapshots (
 session_id TEXT NOT NULL REFERENCES history_sessions(session_id),
 sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=9007199254740991),
 simulation_time_seconds REAL NOT NULL, timestamp TEXT NOT NULL,
 payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
 PRIMARY KEY(session_id,sequence)
);
CREATE UNIQUE INDEX history_snapshot_time ON history_snapshots
 (session_id,simulation_time_seconds,sequence);
CREATE INDEX history_session_order ON history_sessions(started_utc DESC,session_id DESC);
PRAGMA user_version=1;
"""


class HistoryStore:
    def __init__(self, path: Path, *, max_db_bytes: int):
        if type(max_db_bytes) is not int or max_db_bytes < 16 * 1024 * 1024 or max_db_bytes % 4096:
            raise HistoryError("INVALID_CONFIG", "Explicit database limit must be a 4096 multiple >=16MiB")
        self.path = Path(path)
        self._owner = threading.get_ident()
        self._db = None
        self._lock_file = None
        self._locked = False
        self._closed = False
        self._session_id = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._acquire_lock()
            if self.path.exists() and self.path.stat().st_size > max_db_bytes:
                raise HistoryError("QUOTA_EXCEEDED", "Existing database exceeds configured limit")
            self._db = sqlite3.connect(self.path, isolation_level=None, timeout=0.2)
            self._db.row_factory = sqlite3.Row
            version = self._db.execute("PRAGMA user_version").fetchone()[0]
            objects = {row[0] for row in self._db.execute(
                "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
            if version not in (0, 1) or version == 0 and objects:
                raise HistoryError("UNSUPPORTED_VERSION", "Database version or ownership is unsupported")
            if version == 1:
                self._validate_schema()
                self._check_integrity()
            if self._db.execute("PRAGMA journal_mode").fetchone()[0] != "delete":
                raise HistoryError("UNSUPPORTED_STORAGE", "History requires DELETE journaling")
            page_size = self._db.execute("PRAGMA page_size").fetchone()[0]
            pages = max_db_bytes // page_size
            actual = self._db.execute(f"PRAGMA max_page_count={pages}").fetchone()[0]
            if actual > pages:
                raise HistoryError("QUOTA_EXCEEDED", "Existing pages exceed configured database limit")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("PRAGMA busy_timeout=200")
            self._check_space()
            if version == 0:
                self._db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nCOMMIT;")
        except (OSError, sqlite3.Error, HistoryError) as cause:
            try:
                self.close()
            except HistoryError as cleanup:
                cause.add_note(str(cleanup))
            if isinstance(cause, HistoryError):
                raise
            raise HistoryError("STORAGE_UNAVAILABLE", "Unable to open history storage") from cause

    def _acquire_lock(self):
        self._lock_file = open(self.path.parent / ".history-writer.lock", "a+b")
        self._lock_file.seek(0, os.SEEK_END)
        if self._lock_file.tell() == 0:
            self._lock_file.write(b"0")
            self._lock_file.flush()
        self._lock_file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as cause:
            raise HistoryError("WRITER_LOCKED", "Another history writer owns this directory") from cause
        self._locked = True

    def _ensure_owner(self):
        if threading.get_ident() != self._owner:
            raise HistoryError("WRONG_THREAD", "History writer must be used by its creating thread")
        if self._closed or self._db is None:
            raise HistoryError("STORE_CLOSED", "History store is closed")

    def _check_space(self):
        try:
            size = self.path.stat().st_size if self.path.exists() else 0
            free = shutil.disk_usage(self.path.parent).free
        except OSError as cause:
            raise HistoryError("DISK_SPACE", "Unable to establish journal headroom") from cause
        if free < size + 16 * 1024 * 1024:
            raise HistoryError("DISK_SPACE", "Insufficient journal headroom")

    def _validate_schema(self):
        expected = {
            "history_sessions": {
                "session_id", "storage_version", "fleet_schema_version", "state",
                "started_utc", "ended_utc", "code_revision", "scene_json", "config_json",
                "scene_sha256", "config_sha256", "snapshot_count", "last_sequence",
                "first_simulation_time", "last_simulation_time", "failure_code", "failure_message"},
            "history_snapshots": {"session_id", "sequence", "simulation_time_seconds",
                                  "timestamp", "payload_json", "payload_sha256"},
        }
        for table, columns in expected.items():
            actual = {row["name"] for row in self._db.execute(f"PRAGMA table_info({table})")}
            if actual != columns:
                raise HistoryError("UNSUPPORTED_VERSION", "History table definition is unsupported")
        indexes = {row[0] for row in self._db.execute(
            "SELECT name FROM sqlite_master WHERE type='index'")}
        if not {"history_snapshot_time", "history_session_order"} <= indexes:
            raise HistoryError("UNSUPPORTED_VERSION", "Required history indexes are missing")

    def _check_integrity(self):
        if [row[0] for row in self._db.execute("PRAGMA quick_check")] != ["ok"]:
            raise HistoryError("HISTORY_CORRUPT", "History database failed integrity check")
        if self._db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise HistoryError("HISTORY_CORRUPT", "History database has broken references")

    @contextmanager
    def _transaction(self):
        self._ensure_owner()
        self._check_space()
        try:
            self._db.execute("BEGIN IMMEDIATE")
            yield
            self._db.commit()
        except BaseException as cause:
            try:
                if self._db.in_transaction:
                    self._db.rollback()
            except sqlite3.Error as rollback:
                cause.add_note("History rollback failed: " + str(rollback))
            if isinstance(cause, sqlite3.Error):
                code = "QUOTA_EXCEEDED" if cause.sqlite_errorcode == sqlite3.SQLITE_FULL else "WRITE_FAILED"
                raise HistoryError(code, "History transaction failed") from cause
            raise

    def begin(self, context: RecordingContext, initial_snapshot: dict) -> None:
        self._ensure_owner()
        if not isinstance(context, RecordingContext):
            raise HistoryError("INVALID_DATA", "A recording context is required")
        snapshot, payload = capture_snapshot(initial_snapshot)
        if snapshot["session_id"] != context.session_id or snapshot["sequence"] != 0:
            raise HistoryError("INVALID_DATA", "Initial snapshot must be session sequence zero")
        scene = canonical_json(context.scene_payload)
        config = canonical_json([asdict(item) for item in context.vehicle_configs])
        if len((scene + config).encode("utf-8")) > 4 * 1024 * 1024:
            raise HistoryError("PAYLOAD_LIMIT", "Recording metadata exceeds 4MiB")
        with self._transaction():
            if self._session_id is not None:
                state = self._db.execute("SELECT state FROM history_sessions WHERE session_id=?",
                                         (self._session_id,)).fetchone()
                if state and state["state"] == "RECORDING":
                    raise HistoryError("SESSION_ACTIVE", "Writer already has an active recording")
            self._db.execute("""INSERT INTO history_sessions VALUES
             (?,?,?,'RECORDING',?,NULL,?,?,?,?,?,1,0,0,0,NULL,NULL)""",
             (context.session_id, 1, 1, context.started_utc, context.code_revision,
              scene, config, digest(scene), digest(config)))
            self._insert(snapshot, payload)
        self._session_id = context.session_id

    def _insert(self, snapshot: dict, payload: str) -> None:
        self._db.execute("INSERT INTO history_snapshots VALUES (?,?,?,?,?,?)",
                         (snapshot["session_id"], snapshot["sequence"],
                          float(snapshot["simulation_time_seconds"]), snapshot["timestamp"],
                          payload, digest(payload)))

    def append(self, snapshot: dict) -> None:
        self._ensure_owner()
        snapshot, payload = capture_snapshot(snapshot)
        if snapshot["session_id"] != self._session_id:
            raise HistoryError("INVALID_DATA", "Snapshot does not belong to active recording")
        with self._transaction():
            meta = self._db.execute(
                "SELECT state,last_sequence,last_simulation_time FROM history_sessions WHERE session_id=?",
                (self._session_id,)).fetchone()
            if (meta is None or meta["state"] != "RECORDING"
                or snapshot["sequence"] != meta["last_sequence"] + 1
                or snapshot["simulation_time_seconds"] <= meta["last_simulation_time"]):
                raise HistoryError("INVALID_DATA", "Snapshot must advance exactly one committed sequence")
            self._insert(snapshot, payload)
            self._db.execute("""UPDATE history_sessions SET snapshot_count=snapshot_count+1,
                last_sequence=?,last_simulation_time=? WHERE session_id=?""",
                (snapshot["sequence"], float(snapshot["simulation_time_seconds"]), self._session_id))

    def finish(self, state: str, reason: str | None) -> None:
        self._ensure_owner()
        if state not in ("COMPLETED", "FAILED", "INTERRUPTED"):
            raise HistoryError("INVALID_DATA", "Invalid terminal recording state")
        if state == "COMPLETED":
            if reason is not None:
                raise HistoryError("INVALID_DATA", "Completed recording has no failure reason")
        elif not isinstance(reason, str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", reason) is None:
            raise HistoryError("INVALID_DATA", "Noncomplete recording requires a bounded failure code")
        with self._transaction():
            current = self._db.execute("SELECT state FROM history_sessions WHERE session_id=?",
                                       (self._session_id,)).fetchone()
            if current is None or current["state"] != "RECORDING":
                raise HistoryError("SESSION_TERMINAL", "A terminal recording cannot be changed")
            self._db.execute("""UPDATE history_sessions SET state=?,ended_utc=?,
                failure_code=?,failure_message=? WHERE session_id=?""",
                (state, datetime.now(UTC).isoformat(), reason,
                 "Recording terminated: " + reason if reason else None, self._session_id))

    def recover(self) -> None:
        self._ensure_owner()
        # The process lock was acquired before this connection was opened.
        if self._session_id is not None:
            raise HistoryError("SESSION_ACTIVE", "Recovery must precede this writer's recording")
        self._check_integrity()
        with self._transaction():
            self._db.execute("""UPDATE history_sessions SET state='INTERRUPTED',ended_utc=?,
                failure_code='UNCLEAN_SHUTDOWN',
                failure_message='Recording ended without a confirmed shutdown'
                WHERE state='RECORDING'""", (datetime.now(UTC).isoformat(),))

    def close(self) -> None:
        if self._closed:
            return
        if threading.get_ident() != self._owner:
            raise HistoryError("WRONG_THREAD", "Only the owner may release the history writer")
        if self._db is not None:
            try:
                self._db.close()
                self._db = None
            except sqlite3.Error as cause:
                # Do not let another writer in while connection release is unconfirmed.
                raise HistoryError("CLEANUP_UNCONFIRMED", "History connection release unconfirmed") from cause
        if self._lock_file is not None:
            try:
                # Closing the owning OS descriptor releases its lock on both platforms.
                self._lock_file.close()
                self._lock_file = None
                self._locked = False
            except OSError as cause:
                raise HistoryError("CLEANUP_UNCONFIRMED", "History writer lock release unconfirmed") from cause
        self._closed = True
