import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket

from backend.history.api import router as history_router
from backend.history.recorder import HistoryRecorder
from backend.history.settings import load_history_settings, make_recording_context
from backend.realtime.fleet_updates import FleetUnavailableError, FleetUpdates, StreamShutdown
from backend.realtime.streams import StreamSupervisor
from backend.scene.loader import DEFAULT_SCENE_PATH, load_scene
from backend.simulation.fleet import FleetSimulator
from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS, validate_vehicle_configs


logger = logging.getLogger(__name__)


async def _update_vehicle_state(fleet_simulator: FleetSimulator, application: FastAPI) -> None:
    while True:
        await asyncio.sleep(1.0)
        try:
            fleet_simulator.step(dt=1.0)
        except Exception:
            logger.exception("Vehicle route simulation failed")
            application.state.simulation_unavailable = True
            await application.state.fleet_updates.notify()
            recorder = getattr(application.state, 'history_recorder', None)
            if recorder is not None:
                await recorder.finish('MOTION_FAULT')
            return
        recorder = getattr(application.state, 'history_recorder', None)
        if recorder is not None:
            recorder.offer(fleet_simulator.get_snapshot())
        await application.state.fleet_updates.notify()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    scene = load_scene(DEFAULT_SCENE_PATH)
    validate_vehicle_configs(DEFAULT_VEHICLE_CONFIGS)
    fleet_simulator = FleetSimulator(
        scene, vehicle_configs=DEFAULT_VEHICLE_CONFIGS, session_id=str(uuid4()),
    )
    app.state.scene = scene
    app.state.fleet_simulator = fleet_simulator
    app.state.simulation_unavailable = False
    app.state.fleet_updates = FleetUpdates(
        fleet_simulator, is_unavailable=lambda: app.state.simulation_unavailable,
    )
    app.state.stream_supervisor = StreamSupervisor(app.state.fleet_updates)
    initial_snapshot = fleet_simulator.get_snapshot()
    settings = load_history_settings(os.environ)
    app.state.history_settings = settings
    context = make_recording_context(scene, DEFAULT_VEHICLE_CONFIGS, initial_snapshot,
                                     os.environ.get('PHASE2D_CODE_REVISION'))
    app.state.history_recorder = HistoryRecorder(settings, context)
    await app.state.history_recorder.start(initial_snapshot)
    task = asyncio.create_task(_update_vehicle_state(fleet_simulator, app))
    app.state.telemetry_task = task
    try:
        yield
    finally:
        reason = 'MOTION_FAULT' if app.state.simulation_unavailable else 'NORMAL_SHUTDOWN'
        try:
            task.cancel()
            try:
                with suppress(asyncio.CancelledError):
                    await task
            except BaseException:
                reason = 'START_FAILED'
                raise
        finally:
            try:
                await app.state.history_recorder.finish(reason)
            finally:
                await app.state.stream_supervisor.shutdown()


app = FastAPI(lifespan=lifespan)
app.include_router(history_router)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "project": "Autonomous Mining Fleet Digital Twin",
        "status": "running",
    }


@app.get("/health")
async def health() -> dict[str, str]:
    if app.state.simulation_unavailable:
        raise HTTPException(status_code=503, detail="Vehicle simulation unavailable")
    return {"status": "healthy"}


@app.get("/api/scene")
def get_scene() -> dict[str, object]:
    return app.state.scene.get_payload()


@app.get("/api/vehicles/TRUCK_001")
async def get_vehicle_state() -> dict[str, object]:
    if app.state.simulation_unavailable:
        raise HTTPException(status_code=503, detail="Vehicle simulation unavailable")
    return app.state.fleet_simulator.get_vehicle_state('TRUCK_001')


@app.websocket("/ws/vehicles")
async def vehicle_websocket(websocket: WebSocket) -> None:
    await app.state.stream_supervisor.serve(websocket, mode='vehicle')


@app.get("/api/fleet")
async def get_fleet_state() -> dict[str, object]:
    if app.state.simulation_unavailable:
        raise HTTPException(status_code=503, detail="Vehicle simulation unavailable")
    return app.state.fleet_simulator.get_snapshot()


@app.websocket("/ws/fleet")
async def fleet_websocket(websocket: WebSocket) -> None:
    await app.state.stream_supervisor.serve(websocket, mode='fleet')
