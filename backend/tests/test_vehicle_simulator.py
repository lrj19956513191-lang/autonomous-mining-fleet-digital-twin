from datetime import UTC, datetime

import pytest

from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.simulation.route_motion import RouteSimulator
from backend.tests.test_scene_api import assert_first_road_progress


@pytest.fixture
def simulator():
    return RouteSimulator(load_scene(DEFAULT_SCENE_PATH))


def test_initial_state_has_complete_fields_and_expected_values(simulator):
    state = simulator.get_state()
    assert set(state) == {
        'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height',
        'heading', 'speed', 'soc', 'load', 'status',
    }
    assert state['vehicle_id'] == 'TRUCK_001'
    assert state['status'] == 'running'
    for field, expected in {
        'longitude': 116.3900, 'latitude': 39.9000, 'height': 50.0,
        'speed': 25.0, 'soc': 90.0, 'load': 65.0,
    }.items():
        assert state[field] == pytest.approx(expected, rel=0, abs=1e-10)
    assert_first_road_progress(state, 0)


def test_get_state_returns_an_independent_snapshot(simulator):
    snapshot = simulator.get_state()
    snapshot['longitude'] = 0.0
    snapshot['vehicle_id'] = 'CHANGED'
    assert simulator.get_state()['longitude'] == pytest.approx(116.3900)
    assert simulator.get_state()['vehicle_id'] == 'TRUCK_001'


def test_initial_timestamp_is_current_timezone_aware_utc():
    before = datetime.now(UTC)
    state = RouteSimulator(load_scene(DEFAULT_SCENE_PATH)).get_state()
    after = datetime.now(UTC)
    timestamp = datetime.fromisoformat(state['timestamp'])
    assert timestamp.tzinfo is not None
    assert timestamp.utcoffset().total_seconds() == 0
    assert before <= timestamp <= after


def test_step_updates_coordinates_and_soc_and_preserves_other_fields(simulator):
    before = simulator.get_state()
    simulator.step()
    after = simulator.get_state()
    assert set(after) == set(before)
    assert_first_road_progress(after, 25 / 3.6)
    assert after['height'] > before['height']
    assert after['heading'] != before['heading']
    assert after['soc'] - before['soc'] == pytest.approx(-0.1)
    for field in ('vehicle_id', 'speed', 'load', 'status'):
        assert after[field] == before[field]
    assert before['longitude'] == pytest.approx(116.3900, rel=0, abs=1e-10)
    assert before['height'] == 50.0


def test_step_refreshes_timestamp_to_current_timezone_aware_utc(monkeypatch):
    class ControlledClock:
        current = datetime(2026, 10, 1, 0, 0, 0, tzinfo=UTC)

        @classmethod
        def now(cls, tz):
            return cls.current.astimezone(tz)

    monkeypatch.setattr('backend.simulation.route_motion.datetime', ControlledClock)
    simulator = RouteSimulator(load_scene(DEFAULT_SCENE_PATH))
    assert simulator.get_state()['timestamp'] == '2026-10-01T00:00:00+00:00'
    ControlledClock.current = datetime(2026, 10, 1, 0, 0, 1, tzinfo=UTC)
    simulator.step()
    timestamp = datetime.fromisoformat(simulator.get_state()['timestamp'])
    assert timestamp.tzinfo is not None
    assert timestamp.utcoffset().total_seconds() == 0
    assert timestamp.isoformat() == '2026-10-01T00:00:01+00:00'


def test_soc_stays_at_zero_after_depletion(simulator):
    for _ in range(1000):
        simulator.step()
        assert simulator.get_state()['soc'] >= 0.0
    assert simulator.get_state()['soc'] == pytest.approx(0.0, abs=1e-10)
