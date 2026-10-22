import asyncio
from datetime import datetime
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.main import app
from backend.main import _update_vehicle_state
from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.realtime.fleet_updates import FleetUpdates
from backend.simulation.fleet import FleetSimulator
from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS
from backend.tests.test_scene_api import assert_first_road_progress, patch_main_clock


def test_vehicle_api_returns_truck_state():
    with TestClient(app) as client:
        response = client.get("/api/vehicles/TRUCK_001")

    assert response.status_code == 200
    state = response.json()
    assert state["vehicle_id"] == "TRUCK_001"
    assert set(state) == {
        "vehicle_id", "timestamp", "longitude", "latitude", "height",
        "heading", "speed", "soc", "load", "status",
    }


@pytest.mark.parametrize("path, expected", [
    ("/", {"project": "Autonomous Mining Fleet Digital Twin", "status": "running"}),
    ("/health", {"status": "healthy"}),
])
def test_existing_http_endpoints(path, expected):
    with TestClient(app) as client:
        response = client.get(path)

    assert response.status_code == 200
    assert response.json() == expected


def test_docs_remains_accessible():
    with TestClient(app) as client:
        response = client.get("/docs")

    assert response.status_code == 200
    assert "SwaggerUIBundle" in response.text


def test_background_updates_vehicle_state():
    with TestClient(app) as client:
        before = client.get("/api/vehicles/TRUCK_001").json()
        deadline = time.monotonic() + 3.0
        while True:
            time.sleep(0.02)
            after = client.get("/api/vehicles/TRUCK_001").json()
            assert time.monotonic() < deadline, "No background update within 3 seconds"
            if after["longitude"] != before["longitude"]:
                break

        assert set(after) == set(before)
        assert_first_road_progress(after, 25 / 3.6)
        assert after["latitude"] < before["latitude"]
        assert after["height"] > before["height"]
        assert after["soc"] - before["soc"] == pytest.approx(-0.1)
        assert datetime.fromisoformat(after["timestamp"]) > datetime.fromisoformat(before["timestamp"])


def test_background_loop_waits_one_second_between_repeated_updates(monkeypatch):
    async def exercise_loop():
        entered = asyncio.Queue()
        permits = asyncio.Queue()

        async def controlled_sleep(seconds):
            entered.put_nowait(seconds)
            await permits.get()

        # Control only the timer; exercise the real loop and simulator.
        patch_main_clock(monkeypatch, sleep=controlled_sleep)
        simulator = FleetSimulator(
            load_scene(DEFAULT_SCENE_PATH), vehicle_configs=DEFAULT_VEHICLE_CONFIGS,
            session_id='11111111-1111-4111-8111-111111111111',
        )
        application = FastAPI()
        application.state.simulation_unavailable = False
        application.state.fleet_updates = FleetUpdates(
            simulator, is_unavailable=lambda: application.state.simulation_unavailable,
        )
        initial = simulator.get_vehicle_state('TRUCK_001')
        task = asyncio.create_task(_update_vehicle_state(simulator, application))
        try:
            assert await asyncio.wait_for(entered.get(), timeout=1) == 1.0
            assert simulator.get_vehicle_state('TRUCK_001') == initial
            for count, soc in ((1, 89.9), (2, 89.8)):
                permits.put_nowait(None)
                assert await asyncio.wait_for(entered.get(), timeout=1) == 1.0
                state = simulator.get_vehicle_state('TRUCK_001')
                assert_first_road_progress(state, count * 25 / 3.6)
                assert state["soc"] == pytest.approx(soc)
                assert set(state) == set(initial)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(exercise_loop())


def test_background_task_is_cancelled_on_shutdown():
    with TestClient(app):
        task = app.state.telemetry_task
        assert not task.done()

    assert task.done()
    assert task.cancelled()
