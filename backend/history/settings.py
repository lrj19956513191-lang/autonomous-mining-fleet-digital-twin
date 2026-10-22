"""Explicit opt-in history configuration; resolving settings performs no I/O."""
from collections.abc import Mapping
from pathlib import Path
import re

from backend.history.models import HistorySettings, RecordingContext

DEFAULT_HISTORY_DIR = Path(__file__).resolve().parents[2] / '.history'


def load_history_settings(environ: Mapping[str, str]) -> HistorySettings:
    raw_directory = environ.get('PHASE2D_HISTORY_DIR')
    directory = DEFAULT_HISTORY_DIR if raw_directory is None else Path(raw_directory)
    raw_limit = environ.get('PHASE2D_HISTORY_MAX_DB_BYTES', '')
    limit = None
    if directory.is_absolute() and re.fullmatch(r'[0-9]{1,20}', raw_limit):
        candidate = int(raw_limit)
        if candidate >= 16 * 1024 * 1024 and candidate % 4096 == 0:
            limit = candidate
    return HistorySettings(directory, limit)


def make_recording_context(scene, vehicle_configs, snapshot, code_revision) -> RecordingContext:
    revision = code_revision if isinstance(code_revision, str) and re.fullmatch(
        r'[0-9a-f]{40}', code_revision,
    ) else None
    return RecordingContext(snapshot['session_id'], snapshot['timestamp'], scene.get_payload(),
                            vehicle_configs, revision)
