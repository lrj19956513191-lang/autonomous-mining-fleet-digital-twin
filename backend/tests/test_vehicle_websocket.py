import asyncio
from datetime import datetime, timedelta
import json
import threading

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.tests.test_scene_api import assert_first_road_progress, patch_stream_clock


def receive_json_with_timeout(websocket):
    # TestClient has no public receive timeout. Bound its ASGI receive stream
    # so a broken continuous stream fails instead of hanging the test suite.
    async def receive():
        return await asyncio.wait_for(websocket._send_rx.receive(), timeout=3.0)

    message = websocket.portal.call(receive)
    assert message["type"] == "websocket.send", message
    return json.loads(message["text"])


@pytest.fixture
def controlled_stream_clock(monkeypatch):
    async def paused_background(simulator, application):
        await asyncio.Event().wait()

    intervals = asyncio.Queue()
    real_timeout = asyncio.timeout

    def controlled_timeout(seconds):
        # Use a real asyncio timeout, initially without a deadline.
        # The test advances it only after observing the preceding message.
        timer = real_timeout(None)
        intervals.put_nowait((seconds, timer))
        return timer

    monkeypatch.setattr("backend.main._update_vehicle_state", paused_background)
    patch_stream_clock(monkeypatch, timeout=controlled_timeout)
    return intervals


def advance_stream_clock(websocket, intervals):
    async def expire_interval():
        seconds, timer = await asyncio.wait_for(intervals.get(), timeout=1.0)
        timer.reschedule(asyncio.get_running_loop().time())
        return seconds

    return websocket.portal.call(expire_interval)


def test_websocket_connects_and_immediately_returns_vehicle_json():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/vehicles") as websocket:
            state = receive_json_with_timeout(websocket)

    assert state["vehicle_id"] == "TRUCK_001"


def test_websocket_message_has_http_schema_and_utc_timestamp():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/vehicles") as websocket:
            state = receive_json_with_timeout(websocket)

    assert set(state) == {
        "vehicle_id", "timestamp", "longitude", "latitude", "height",
        "heading", "speed", "soc", "load", "status",
    }
    assert state["vehicle_id"] == "TRUCK_001"
    timestamp = datetime.fromisoformat(state["timestamp"])
    assert timestamp.tzinfo is not None
    assert timestamp.utcoffset() == timedelta(0)


def test_websocket_reads_state_without_advancing_the_simulator(controlled_stream_clock):
    with TestClient(app) as client:
        initial = client.get("/api/vehicles/TRUCK_001").json()
        with client.websocket_connect("/ws/vehicles") as websocket:
            assert receive_json_with_timeout(websocket) == initial
            assert client.get("/api/vehicles/TRUCK_001").json() == initial

            # Only this explicit, controlled source update may change state.
            async def commit():
                app.state.fleet_simulator.step()
                await app.state.fleet_updates.notify()
            client.portal.call(commit)
            updated = client.get("/api/vehicles/TRUCK_001").json()
            assert_first_road_progress(updated, 25 / 3.6)
            assert updated["height"] > initial["height"]
            assert updated["latitude"] < initial["latitude"]
            assert updated["soc"] - initial["soc"] == pytest.approx(-0.1)

            assert advance_stream_clock(websocket, controlled_stream_clock) == 1.0
            assert receive_json_with_timeout(websocket) == updated
            assert client.get("/api/vehicles/TRUCK_001").json() == updated


def test_first_message_precedes_timer_and_repeated_messages_wait_one_second(controlled_stream_clock):
    with TestClient(app) as client:
        with client.websocket_connect("/ws/vehicles") as websocket:
            # No timer has been advanced: a wait before the first send would
            # block here. Each later send requires an explicit timer expiry.
            first = receive_json_with_timeout(websocket)
            for _ in range(2):
                assert advance_stream_clock(websocket, controlled_stream_clock) == 1.0
                assert receive_json_with_timeout(websocket) == first


def test_websocket_continuously_streams_background_state_updates():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/vehicles") as websocket:
            first = receive_json_with_timeout(websocket)
            # Allow two periods in case a send lands just before a source tick.
            for _ in range(2):
                latest = receive_json_with_timeout(websocket)
                assert latest["vehicle_id"] == first["vehicle_id"] == "TRUCK_001"
                if (latest["longitude"], latest["latitude"]) != (first["longitude"], first["latitude"]):
                    break

            assert (latest["longitude"], latest["latitude"]) != (first["longitude"], first["latitude"])
            ticks = round((90 - latest["soc"]) / 0.1)
            assert_first_road_progress(latest, ticks * 25 / 3.6)
            assert datetime.fromisoformat(latest["timestamp"]) > datetime.fromisoformat(first["timestamp"])


def test_client_disconnect_keeps_health_and_http_state_available():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/vehicles") as websocket:
            receive_json_with_timeout(websocket)

        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "healthy"}
        assert client.get("/api/vehicles/TRUCK_001").status_code == 200
        assert not app.state.telemetry_task.done()


def test_client_disconnect_finishes_handler_without_testclient_cancelling_it():
    finished = threading.Event()

    async def tracked_app(scope, receive, send):
        try:
            await app(scope, receive, send)
        finally:
            if scope["type"] == "websocket":
                finished.set()

    with TestClient(tracked_app) as client:
        with client.websocket_connect("/ws/vehicles") as websocket:
            receive_json_with_timeout(websocket)
            websocket.close()
            # Remain inside the session: its exit would cancel the handler
            # and conceal a handler that never consumes client disconnects.
            assert finished.wait(timeout=1.5), "WebSocket handler did not finish after client disconnect"

        assert client.get("/health").status_code == 200
