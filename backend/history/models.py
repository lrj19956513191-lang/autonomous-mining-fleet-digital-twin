"""Immutable history contracts and strict wire-value validation."""
import hashlib
import json
import math
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from collections.abc import Mapping

from backend.simulation.fleet_config import VehicleConfig, validate_vehicle_configs

MAX_SEQUENCE = 9007199254740991
UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SNAPSHOT_KEYS = {"schema_version", "session_id", "sequence", "timestamp",
                 "simulation_time_seconds", "vehicles"}
VEHICLE_KEYS = {"vehicle_id", "timestamp", "longitude", "latitude", "height",
                "heading", "speed", "soc", "load", "status"}


class HistoryError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _plain(value):
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise HistoryError("INVALID_DATA", "JSON object keys must be strings")
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if value is None or type(value) in (bool, int, str):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    raise HistoryError("INVALID_DATA", "Only finite JSON values are supported")


def canonical_json(value: object) -> str:
    try:
        text = json.dumps(_plain(value), ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)
        text.encode("utf-8")
        return text
    except (ValueError, TypeError, RecursionError, UnicodeError) as cause:
        raise HistoryError("INVALID_DATA", "Unable to encode history JSON") from cause


def parse_json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise HistoryError("INVALID_DATA", "Duplicate JSON object key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise HistoryError("INVALID_DATA", "Nonfinite JSON constant")

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
        return _plain(value)  # Also rejects exponent overflow (e.g. 1e999).
    except (ValueError, TypeError, RecursionError) as cause:
        if isinstance(cause, HistoryError):
            raise
        raise HistoryError("INVALID_DATA", "Unable to decode history JSON") from cause


def digest(text: str) -> str:
    try:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()
    except UnicodeError as cause:
        raise HistoryError("INVALID_DATA", "Invalid UTF-8 text") from cause


def valid_timestamp(value) -> bool:
    if not isinstance(value, str) or re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
        r"(\.[0-9]{1,6})?(Z|\+00:00)", value
    ) is None:
        return False
    try:
        datetime.fromisoformat(value)
        return True
    except ValueError:
        return False


def _finite(value) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def detach_snapshot(value: Mapping) -> dict:
    """Bounded structural copy only; JSON encoding and hashing belong to the writer."""
    if (type(value) is not dict or len(value) != len(SNAPSHOT_KEYS)
        or any(type(key) is not str for key in value) or set(value) != SNAPSHOT_KEYS):
        raise HistoryError("INVALID_DATA", "Invalid fleet snapshot fields")
    vehicles = value["vehicles"]
    if (type(vehicles) is not list or len(vehicles) > 100
        or any(type(v) is not dict or len(v) != len(VEHICLE_KEYS)
               or any(type(key) is not str for key in v) for v in vehicles)):
        raise HistoryError("INVALID_DATA", "Invalid history vehicles array")
    snapshot = value.copy()
    snapshot["vehicles"] = [vehicle.copy() for vehicle in vehicles]
    if not isinstance(snapshot, dict) or set(snapshot) != SNAPSHOT_KEYS:
        raise HistoryError("INVALID_DATA", "Invalid fleet snapshot fields")
    version, sequence, time = (snapshot["schema_version"], snapshot["sequence"],
                               snapshot["simulation_time_seconds"])
    if (type(version) is not int or version != 1 or type(sequence) is not int
        or not 0 <= sequence <= MAX_SEQUENCE
        or type(snapshot["session_id"]) is not str
        or UUID4.fullmatch(snapshot["session_id"]) is None
        or type(snapshot["timestamp"]) is not str or not valid_timestamp(snapshot["timestamp"]) or not _finite(time)
        or type(time) is int and float(time) != time
        or (time != 0 if sequence == 0 else time <= 0)):
        raise HistoryError("INVALID_DATA", "Invalid fleet snapshot identity or time")
    vehicles = snapshot["vehicles"]
    if not isinstance(vehicles, list) or len(vehicles) > 100:
        raise HistoryError("INVALID_DATA", "Invalid history vehicles array")
    seen = set()
    for vehicle in vehicles:
        if not isinstance(vehicle, dict) or len(vehicle) != len(VEHICLE_KEYS) or set(vehicle) != VEHICLE_KEYS:
            raise HistoryError("INVALID_DATA", "Invalid vehicle fields")
        identity = vehicle["vehicle_id"]
        if (type(identity) is not str or re.fullmatch(r"TRUCK_[0-9]{3}", identity) is None
            or identity in seen or type(vehicle["timestamp"]) is not str
            or vehicle["timestamp"] != snapshot["timestamp"]
            or type(vehicle["status"]) is not str):
            raise HistoryError("INVALID_DATA", "Invalid vehicle identity or timestamp")
        seen.add(identity)
        if not all(_finite(vehicle[key]) for key in
                   ("longitude", "latitude", "height", "heading", "speed", "soc", "load")):
            raise HistoryError("INVALID_DATA", "Invalid vehicle numeric fields")
        if (not -180 <= vehicle["longitude"] <= 180 or not -90 <= vehicle["latitude"] <= 90
            or not 0 <= vehicle["heading"] < 360 or vehicle["speed"] < 0
            or not 0 <= vehicle["soc"] <= 100 or vehicle["status"] not in ("running", "stopped")
            or vehicle["status"] == "stopped" and vehicle["speed"] != 0):
            raise HistoryError("INVALID_DATA", "Invalid vehicle state")
    if _snapshot_size(snapshot) > 65536:
        raise HistoryError("PAYLOAD_LIMIT", "History snapshot exceeds 64KiB")
    return snapshot


def _snapshot_size(value) -> int:
    """Exact compact JSON byte count for the validated ASCII-only fleet schema.
    No JSON text/bytes or hash is produced on the handoff thread. Numeric repr
    matches Python's finite JSON number spelling; only builtin scalar types pass.
    """
    if type(value) is dict:
        return 2 + max(0, len(value) - 1) + sum(
            len(key) + 3 + _snapshot_size(item) for key, item in value.items())
    if type(value) is list:
        return 2 + max(0, len(value) - 1) + sum(_snapshot_size(item) for item in value)
    if type(value) is str:
        return len(value) + 2  # Validated identifiers/UTC/status contain no escapes/non-ASCII.
    return len(repr(value))


def capture_snapshot(value: Mapping) -> tuple[dict, str]:
    """Detach once: columns and payload describe the same captured object."""
    snapshot = detach_snapshot(value)
    text = canonical_json(snapshot)
    if len(text.encode("utf-8")) > 65536:
        raise HistoryError("PAYLOAD_LIMIT", "History snapshot exceeds 64KiB")
    return snapshot, text


def _freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


@dataclass(frozen=True, slots=True)
class HistorySettings:
    directory: Path
    max_db_bytes: int | None
    queue_capacity: int = 128


@dataclass(frozen=True, slots=True)
class RecordingContext:
    session_id: str
    started_utc: str
    scene_payload: Mapping[str, object]
    vehicle_configs: tuple[VehicleConfig, ...]
    code_revision: str | None

    def __post_init__(self):
        if (not isinstance(self.session_id, str) or UUID4.fullmatch(self.session_id) is None
            or not valid_timestamp(self.started_utc)
            or self.code_revision is not None and
            (not isinstance(self.code_revision, str) or
             re.fullmatch(r"[0-9a-f]{40}", self.code_revision) is None)):
            raise HistoryError("INVALID_DATA", "Invalid recording provenance")
        try:
            validate_vehicle_configs(self.vehicle_configs)
        except ValueError as cause:
            raise HistoryError("INVALID_DATA", "Invalid recording configuration") from cause
        scene = _plain(self.scene_payload)
        if not isinstance(scene, dict):
            raise HistoryError("INVALID_DATA", "Scene must be an object")
        object.__setattr__(self, "scene_payload", _freeze(scene))
        object.__setattr__(self, "vehicle_configs", deepcopy(self.vehicle_configs))

@dataclass(frozen=True, slots=True)
class RecordingStatus:
    enabled: bool
    state: str
    session_id: str | None
    last_offered_sequence: int | None
    last_persisted_sequence: int | None
    error_code: str | None
    error_message: str | None
