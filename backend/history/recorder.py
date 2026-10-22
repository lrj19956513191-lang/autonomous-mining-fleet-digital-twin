"""A bounded handoff to one connection-owning storage thread, never a simulator."""
import asyncio
from concurrent.futures import Future, InvalidStateError
from dataclasses import replace
from queue import Empty, Full, Queue
from pathlib import Path
import threading
import re

from backend.history.models import HistoryError, RecordingStatus, detach_snapshot
from backend.history.store import HistoryStore


class HistoryRecorder:
    def __init__(self, settings, context):
        self._settings, self._context = settings, context
        self._lock = threading.Lock()
        valid = (type(settings.max_db_bytes) is int
                 and settings.max_db_bytes >= 16 * 1024 * 1024
                 and settings.max_db_bytes % 4096 == 0
                 and type(settings.queue_capacity) is int
                 and 1 <= settings.queue_capacity <= 128
                 and isinstance(settings.directory, Path) and settings.directory.is_absolute())
        self._queue = Queue(maxsize=settings.queue_capacity if valid else 128)
        self._wake = threading.Event()
        self._startup, self._done = Future(), Future()
        self._thread = None
        self._started = False
        self._stop = False
        self._reason = None
        self._last_time = None
        self._failure = None
        self._diagnostics = []
        self._unreleased_store = None
        self._start_timeout = 2.0
        self._finish_timeout = 5.0
        self._status = RecordingStatus(valid, "STARTING" if valid else "DISABLED_CONFIG",
                                       context.session_id if valid else None, None, None,
                                       None if valid else "INVALID_CONFIG",
                                       None if valid else "Explicit valid recording configuration required")
        if not valid:
            self._settle(self._startup, False)
            self._settle(self._done, None)

    @staticmethod
    def _settle(future, value):
        try:
            future.set_result(value)
        except InvalidStateError:
            pass  # A concurrent termination already settled this one-shot acknowledgement.

    def get_status(self):
        with self._lock:
            return replace(self._status)

    @property
    def diagnostics(self):
        """Original exceptions (including secondary failures), not part of the wire status."""
        with self._lock:
            return tuple(self._diagnostics)

    def _fail_locked(self, error):
        if not any(item is error for item in self._diagnostics):
            self._diagnostics.append(error)
        if self._failure is None:
            self._failure = error
            code = error.code if isinstance(error, HistoryError) else "WRITE_FAILED"
            if not isinstance(code, str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", code) is None:
                code = "WRITE_FAILED"
            self._status = replace(self._status, state="FAILED",
                                   error_code=code,
                                   error_message="History recording failed; inspect diagnostics")
        self._stop = True
        self._wake.set()

    def _fail(self, error):
        with self._lock:
            self._fail_locked(error)

    async def start(self, initial_snapshot):
        with self._lock:
            if not self._status.enabled or self._stop or threading.current_thread() is self._thread:
                return
            first = not self._started
            if first:
                self._started = True
        if first:
            try:
                initial = detach_snapshot(initial_snapshot)
                if initial["sequence"] != 0 or initial["session_id"] != self._context.session_id:
                    raise HistoryError("INVALID_DATA", "Initial recording requires its session sequence zero")
                with self._lock:
                    stopped = self._stop
                    if not stopped:
                        self._last_time = initial["simulation_time_seconds"]
                        self._status = replace(self._status, last_offered_sequence=0)
                        self._thread = threading.Thread(target=self._run, args=(initial,),
                                                        name="history-writer", daemon=True)
                if stopped:
                    self._settle(self._startup, False)
                    self._settle(self._done, None)
                    return
                self._thread.start()
            except Exception as error:
                self._fail(error)
                self._settle(self._startup, False)
                self._settle(self._done, None)
        try:
            await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(self._startup)),
                                   timeout=self._start_timeout)
        except TimeoutError as cause:
            error = HistoryError("START_TIMEOUT", "History startup was not acknowledged within budget")
            error.__cause__ = cause
            self._fail(error)
        except asyncio.CancelledError as cause:
            error = HistoryError("START_CANCELLED", "History startup wait was cancelled")
            error.__cause__ = cause
            self._fail(error)
            raise

    def offer(self, snapshot):
        with self._lock:
            if self._status.state != "RECORDING" or self._stop:
                return False
        try:
            value = detach_snapshot(snapshot)
        except Exception as error:
            self._fail(error)
            return False
        with self._lock:
            if self._status.state != "RECORDING" or self._stop:
                return False
            if (value["session_id"] != self._context.session_id
                or value["sequence"] != self._status.last_offered_sequence + 1
                or value["simulation_time_seconds"] <= self._last_time):
                self._fail_locked(HistoryError("INVALID_DATA", "Snapshot sequence/session/time is not contiguous"))
                return False
            try:
                self._queue.put_nowait(value)
            except Full:
                self._fail_locked(HistoryError("QUEUE_FULL", "History handoff queue is full"))
                return False
            self._last_time = value["simulation_time_seconds"]
            self._status = replace(self._status, last_offered_sequence=value["sequence"])
            self._wake.set()
            return True

    async def finish(self, reason):
        if reason not in ("NORMAL_SHUTDOWN", "MOTION_FAULT", "START_FAILED"):
            raise HistoryError("INVALID_DATA", "Unknown recording shutdown reason")
        settle_empty = False
        with self._lock:
            if not self._status.enabled:
                return
            if not self._started:
                self._started = True
                self._fail_locked(HistoryError("START_FAILED", "Recording ended before startup"))
                settle_empty = True
            if not self._stop:
                self._reason = reason
                self._stop = True
                if reason != "NORMAL_SHUTDOWN":
                    self._fail_locked(HistoryError(reason, "History source terminated"))
                else:
                    self._status = replace(self._status, state="STOPPING")
                self._wake.set()
        if settle_empty:
            self._settle(self._startup, False)
            self._settle(self._done, None)
        if threading.current_thread() is self._thread:
            return  # Synchronous owner callbacks may request stop, but must never self-join.
        if self._done.done() and (self._thread is None or not self._thread.is_alive()):
            return
        try:
            await asyncio.wait_for(self._wait_for_exit(), timeout=self._finish_timeout)
        except TimeoutError as cause:
            error = HistoryError("SHUTDOWN_UNCONFIRMED", "History worker release exceeded shutdown budget")
            error.__cause__ = cause
            self._fail(error)
            with self._lock:
                self._status = replace(self._status, state="FAILED",
                                       error_code=error.code,
                                       error_message="History worker/connection/lock release unconfirmed")
        except asyncio.CancelledError as cause:
            error = HistoryError("SHUTDOWN_CANCELLED", "History shutdown wait was cancelled")
            error.__cause__ = cause
            self._fail(error)
            raise

    async def _wait_for_exit(self):
        await asyncio.shield(asyncio.wrap_future(self._done))
        # done certifies the cleanup attempt; separately confirm the actual thread exit.
        while self._thread is not None and self._thread.is_alive():
            await asyncio.sleep(0)

    def _run(self, initial):
        store = None
        begun = False
        try:
            store = HistoryStore(self._settings.directory / "fleet-history.sqlite3",
                                 max_db_bytes=self._settings.max_db_bytes)
            store.recover()
            store.begin(self._context, initial)
            begun = True
            with self._lock:
                self._status = replace(self._status, last_persisted_sequence=0)
                ready = not self._stop
                if ready:
                    self._status = replace(self._status, state="RECORDING")
            self._settle(self._startup, ready)  # Future callbacks must never run under the state lock.
            while True:
                with self._lock:
                    try:
                        item = self._queue.get_nowait()
                    except Empty:
                        if self._stop:
                            break
                        self._wake.clear()
                        item = None
                if item is None:
                    self._wake.wait()
                    continue
                try:
                    store.append(item)
                    with self._lock:
                        self._status = replace(self._status, last_persisted_sequence=item["sequence"])
                finally:
                    self._queue.task_done()
        except BaseException as error:
            self._fail(error)
        finally:
            terminal = None
            if store is not None:
                if begun:
                    with self._lock:
                        reason = self._status.error_code if self._failure else None
                        terminal = "FAILED" if reason else "COMPLETED"
                    try:
                        store.finish(terminal, reason)
                    except BaseException as error:
                        self._fail(error)
                        if terminal == "COMPLETED":
                            try:
                                store.finish("FAILED", self.get_status().error_code)
                            except BaseException as marker_error:
                                self._fail(marker_error)
                        terminal = None
                try:
                    store.close()
                except BaseException as error:
                    self._unreleased_store = store
                    self._fail(error)
            with self._lock:
                if terminal == "COMPLETED" and self._failure is None:
                    self._status = replace(self._status, state="COMPLETED")
                while True:
                    try:
                        self._queue.get_nowait()
                        self._queue.task_done()
                    except Empty:
                        break
            self._settle(self._startup, False)
            self._settle(self._done, None)
