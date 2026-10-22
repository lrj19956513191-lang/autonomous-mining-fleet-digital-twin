import json
from pathlib import Path

import pytest


DEMO_PATH = Path(__file__).resolve().parents[1] / 'data' / 'demo_mine.json'


@pytest.fixture
def demo_payload():
    """Each test receives a fresh copy from the single spatial source."""
    return json.loads(DEMO_PATH.read_text(encoding='utf-8'))


@pytest.fixture
def scene_features(demo_payload):
    """Mutable ID lookup into this test's isolated source payload."""
    return {feature['id']: feature for feature in demo_payload['features']['features']}


@pytest.fixture(autouse=True)
def isolate_history_environment(monkeypatch):
    """Tests opt in to recording explicitly, never through the developer's environment."""
    for key in ('PHASE2D_HISTORY_DIR', 'PHASE2D_HISTORY_MAX_DB_BYTES', 'PHASE2D_CODE_REVISION'):
        monkeypatch.delenv(key, raising=False)
