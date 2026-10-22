import asyncio
import json
from contextlib import ExitStack
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pyproj import Geod

import backend.main as main
import backend.realtime.streams as streams
from backend.main import app
from backend.scene.loader import DEFAULT_SCENE_PATH, SceneValidationError, load_scene
from backend.simulation.route_motion import RouteMotionError


def test_scene_endpoint_returns_shared_payload(monkeypatch):
    async def paused_background(*args):
        await asyncio.Event().wait()

    monkeypatch.setattr('backend.main._update_vehicle_state', paused_background)
    with TestClient(app) as client:
        response = client.get('/api/scene')
        assert response.status_code == 200
        assert response.headers['content-type'] == 'application/json'
        payload = response.json()
        assert payload['schema_version'] == 1
        assert payload['mine_id'] == 'DEMO_MINE'
        assert len(payload['features']['features']) == 21
        assert payload['preset_route']['route_id'] == 'ROUTE_001'
        assert payload['preset_route']['segments'] == [
            {'edge_id': f'ROAD_{i:03d}', 'reverse': False} for i in range(1, 7)
        ]
        assert payload == app.state.scene.get_payload()
        roads = {
            feature['id']: feature['geometry']['coordinates']
            for feature in payload['features']['features']
            if feature['properties']['kind'] == 'road_edge'
        }
        assert roads == {
            edge: [list(point) for point in coordinates]
            for edge, coordinates in app.state.scene.road_coordinates.items()
        }
        initial = app.state.fleet_simulator.get_vehicle_state('TRUCK_001')
        for _ in range(3):
            assert client.get('/api/scene').json() == payload
            assert client.get('/api/vehicles/TRUCK_001').json() == initial
        assert app.state.fleet_simulator.get_vehicle_state('TRUCK_001') == initial


GEOD = Geod(ellps='WGS84')


def patch_main_clock(monkeypatch, **overrides):
    # Scope clocks to this consumer; leave AnyIO's global asyncio untouched.
    monkeypatch.setattr(main, 'asyncio', SimpleNamespace(**(vars(asyncio) | overrides)))


def patch_stream_clock(monkeypatch, **overrides):
    # The legacy read interval belongs to its actual stream consumer.
    monkeypatch.setattr(streams, 'asyncio', SimpleNamespace(**(vars(asyncio) | overrides)))


def receive_vehicle_message(websocket):
    # Bound TestClient's receive so a missing immediate send fails promptly.
    async def receive():
        return await asyncio.wait_for(websocket._send_rx.receive(), timeout=3.0)

    message = websocket.portal.call(receive)
    assert message['type'] == 'websocket.send', message
    return json.loads(message['text'])


def assert_first_road_progress(state, metres):
    # Independent reference from the published original ROAD_001 first leg.
    bearing, _, length = GEOD.inv(116.3900, 39.9000, 116.3915, 39.8992)
    lon, lat, heading = GEOD.fwd(
        116.3900, 39.9000, bearing, metres, return_back_azimuth=False,
    )
    assert GEOD.inv(lon, lat, state['longitude'], state['latitude'])[2] < 1e-6
    assert state['height'] == pytest.approx(50.0 + metres / length, abs=1e-6)
    assert state['heading'] == pytest.approx(heading % 360, abs=1e-6)
    assert state['speed'] == 25.0
    assert datetime.fromisoformat(state['timestamp']).utcoffset() == timedelta(0)


@pytest.mark.parametrize('bad_data', ['json', 'route'])
def test_startup_fails_before_task_on_bad_scene(monkeypatch, tmp_path, demo_payload, bad_data):
    path = tmp_path / 'invalid_scene.json'
    if bad_data == 'json':
        path.write_text('{bad JSON', encoding='utf-8')
    else:
        demo_payload['preset_route']['segments'][1:3] = list(
            reversed(demo_payload['preset_route']['segments'][1:3])
        )
        path.write_text(json.dumps(demo_payload), encoding='utf-8')
    monkeypatch.setattr(main, 'DEFAULT_SCENE_PATH', path)
    started = []

    def forbidden_background(*args):
        started.append(args)
        raise AssertionError('invalid startup created a background coroutine')

    monkeypatch.setattr(main, '_update_vehicle_state', forbidden_background)
    with pytest.raises(SceneValidationError) as error:
        with TestClient(app):
            pytest.fail('invalid startup must not yield')
    assert not started
    assert '$' in str(error.value)
    if bad_data == 'json':
        assert str(path) in str(error.value)
        assert isinstance(error.value.__cause__, json.JSONDecodeError)
    else:
        assert 'preset_route' in str(error.value)


def test_constructor_failure_creates_no_background_task(monkeypatch):
    started = []

    def failed_constructor(scene, **kwargs):
        raise RouteMotionError('invalid compiled length')

    def forbidden_background(*args):
        started.append(args)
        raise AssertionError('failed construction created a background coroutine')

    monkeypatch.setattr(main, 'FleetSimulator', failed_constructor)
    monkeypatch.setattr(main, '_update_vehicle_state', forbidden_background)
    with pytest.raises(RouteMotionError, match='invalid compiled length'):
        with TestClient(app):
            pytest.fail('constructor failure must not yield')
    assert not started


def test_scene_loaded_once_and_independent_of_cwd(monkeypatch, tmp_path):
    calls, consumed = [], []
    real_constructor = main.FleetSimulator

    def counted_load(path):
        calls.append(path)
        return load_scene(path)

    def captured_constructor(scene, **kwargs):
        consumed.append(scene)
        return real_constructor(scene, **kwargs)

    async def paused_background(*args):
        await asyncio.Event().wait()

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main, 'load_scene', counted_load)
    monkeypatch.setattr(main, 'FleetSimulator', captured_constructor)
    monkeypatch.setattr(main, '_update_vehicle_state', paused_background)
    with TestClient(app) as client:
        initial = app.state.fleet_simulator.get_vehicle_state('TRUCK_001')
        payload = client.get('/api/scene').json()
        assert calls == [DEFAULT_SCENE_PATH]
        assert consumed == [app.state.scene]
        assert consumed[0] is app.state.scene
        road = next(f for f in payload['features']['features'] if f['id'] == 'ROAD_001')
        road['geometry']['coordinates'][0][0] = 0
        private_copy = app.state.scene.get_payload()
        private_copy['features']['features'].clear()
        for _ in range(3):
            fresh = client.get('/api/scene').json()
            assert len(fresh['features']['features']) == 21
            assert next(f for f in fresh['features']['features'] if f['id'] == 'ROAD_001')['geometry']['coordinates'][0] == [116.3900, 39.9000, 50.0]
            assert client.get('/api/vehicles/TRUCK_001').json() == initial
        app.state.fleet_simulator.step()
        assert_first_road_progress(app.state.fleet_simulator.get_vehicle_state('TRUCK_001'), 25 / 3.6)
        assert calls == [DEFAULT_SCENE_PATH]
        assert len(consumed) == 1


@pytest.fixture
def controlled_background_clock(monkeypatch):
    entered, permits = asyncio.Queue(), asyncio.Queue()

    async def controlled_sleep(seconds):
        entered.put_nowait(seconds)
        await permits.get()

    patch_main_clock(monkeypatch, sleep=controlled_sleep)
    return entered, permits


def wait_for_background_sleep(client, clock):
    async def wait():
        return await asyncio.wait_for(clock[0].get(), timeout=1.0)
    assert client.portal.call(wait) == 1.0


def release_background_tick(client, clock):
    client.portal.call(clock[1].put_nowait, None)
    wait_for_background_sleep(client, clock)


def test_background_has_one_fixed_dt_source(monkeypatch, controlled_background_clock):
    steps = []
    real_step = main.FleetSimulator.step

    def recorded_step(simulator, dt=1.0):
        steps.append(dt)
        real_step(simulator, dt)

    monkeypatch.setattr(main.FleetSimulator, 'step', recorded_step)
    with TestClient(app) as client:
        task = app.state.telemetry_task
        wait_for_background_sleep(client, controlled_background_clock)
        initial = client.get('/api/vehicles/TRUCK_001').json()
        with client.websocket_connect('/ws/vehicles') as first_ws:
            with client.websocket_connect('/ws/vehicles') as second_ws:
                assert receive_vehicle_message(first_ws) == initial
                assert receive_vehicle_message(second_ws) == initial
                for _ in range(3):
                    assert client.get('/api/vehicles/TRUCK_001').json() == initial
                    assert client.get('/api/scene').status_code == 200
                assert steps == []
                for count in (1, 2):
                    release_background_tick(client, controlled_background_clock)
                    state = client.get('/api/vehicles/TRUCK_001').json()
                    assert_first_road_progress(state, count * 25 / 3.6)
                    assert state['soc'] == pytest.approx(90 - count * 0.1)
                    assert datetime.fromisoformat(state['timestamp']) >= datetime.fromisoformat(initial['timestamp'])
                    assert steps == [1.0] * count
                    assert app.state.telemetry_task is task
                final = app.state.fleet_simulator.get_vehicle_state('TRUCK_001')
                for _ in range(3):
                    assert client.get('/api/vehicles/TRUCK_001').json() == final
                assert steps == [1.0, 1.0]
        assert not task.done()
        assert client.get('/health').status_code == 200
    assert task.done() and task.cancelled()


def test_original_http_ws_contract_on_route(controlled_background_clock):
    with TestClient(app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        for path in ('/', '/health', '/docs'):
            assert client.get(path).status_code == 200
        initial = client.get('/api/vehicles/TRUCK_001').json()
        assert_first_road_progress(initial, 0)
        assert set(initial) == {
            'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height',
            'heading', 'speed', 'soc', 'load', 'status',
        }
        with client.websocket_connect('/ws/vehicles') as websocket:
            assert receive_vehicle_message(websocket) == initial
            assert client.get('/api/vehicles/TRUCK_001').json() == initial
            release_background_tick(client, controlled_background_clock)
            updated = client.get('/api/vehicles/TRUCK_001').json()
            assert_first_road_progress(updated, 25 / 3.6)
            assert updated['latitude'] < initial['latitude']
            assert updated['height'] > initial['height']
            assert updated['heading'] != initial['heading']
            assert set(updated) == set(initial)
            assert receive_vehicle_message(websocket) == updated


def test_background_cancel_and_ws_disconnect(controlled_background_clock, caplog):
    with TestClient(app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        task = app.state.telemetry_task
        with client.websocket_connect('/ws/vehicles') as websocket:
            receive_vehicle_message(websocket)
        assert not task.done()
        assert client.get('/health').json() == {'status': 'healthy'}
        release_background_tick(client, controlled_background_clock)
        assert_first_road_progress(client.get('/api/vehicles/TRUCK_001').json(), 25 / 3.6)
    assert task.cancelled()
    assert not app.state.simulation_unavailable
    assert not [record for record in caplog.records if record.levelname == 'ERROR']


@pytest.mark.parametrize('error_type', [RouteMotionError, RuntimeError])
def test_background_fault_is_recorded_and_stops(monkeypatch, caplog, error_type):
    async def exercise():
        simulator = main.FleetSimulator(
            load_scene(DEFAULT_SCENE_PATH), vehicle_configs=main.DEFAULT_VEHICLE_CONFIGS,
            session_id='11111111-1111-4111-8111-111111111111',
        )
        application = main.FastAPI()
        application.state.simulation_unavailable = False
        application.state.fleet_updates = main.FleetUpdates(
            simulator, is_unavailable=lambda: application.state.simulation_unavailable,
        )
        initial = simulator.get_vehicle_state('TRUCK_001')
        calls = []

        async def immediate_sleep(seconds):
            assert seconds == 1.0

        def failed_step(dt=1.0):
            calls.append(dt)
            raise error_type('controlled motion failure')

        patch_main_clock(monkeypatch, sleep=immediate_sleep)
        monkeypatch.setattr(simulator, 'step', failed_step)
        await main._update_vehicle_state(simulator, application)
        assert application.state.simulation_unavailable
        assert simulator.get_vehicle_state('TRUCK_001') == initial
        assert calls == [1.0]
        errors = [record for record in caplog.records if record.levelname == 'ERROR']
        assert len(errors) == 1
        assert errors[0].exc_info[0] is error_type
        assert str(errors[0].exc_info[1]) == 'controlled motion failure'

    asyncio.run(exercise())


@pytest.mark.parametrize('error_type', [RouteMotionError, RuntimeError])
@pytest.mark.parametrize('active_socket', [False, True], ids=['before-first', 'active'])
def test_motion_fault_disables_vehicle_service(
    monkeypatch, caplog, controlled_background_clock, error_type, active_socket,
):
    intervals = asyncio.Queue()
    real_timeout = asyncio.timeout

    def controlled_timeout(seconds):
        timer = real_timeout(None)
        intervals.put_nowait((seconds, timer))
        return timer

    patch_stream_clock(monkeypatch, timeout=controlled_timeout)
    with TestClient(app) as client:
        wait_for_background_sleep(client, controlled_background_clock)
        initial = client.get('/api/vehicles/TRUCK_001').json()
        scene = client.get('/api/scene').json()
        with ExitStack() as sessions:
            if active_socket:
                websocket = sessions.enter_context(client.websocket_connect('/ws/vehicles'))
                assert receive_vehicle_message(websocket) == initial

                async def observe_interval():
                    seconds, timer = await asyncio.wait_for(intervals.get(), timeout=1)
                    assert seconds == 1.0
                    return timer
                active_timer = client.portal.call(observe_interval)

            def failed_step(dt=1.0):
                assert dt == 1.0
                raise error_type('controlled service failure')

            monkeypatch.setattr(app.state.fleet_simulator, 'step', failed_step)
            client.portal.call(controlled_background_clock[1].put_nowait, None)

            async def wait_for_task():
                await asyncio.wait_for(app.state.telemetry_task, timeout=1.0)

            client.portal.call(wait_for_task)
            assert app.state.simulation_unavailable
            assert app.state.telemetry_task.done()
            assert not app.state.telemetry_task.cancelled()
            assert app.state.fleet_simulator.get_vehicle_state('TRUCK_001') == initial
            for _ in range(3):
                for path in ('/health', '/api/vehicles/TRUCK_001'):
                    response = client.get(path)
                    assert response.status_code == 503
                    assert 'simulation' in response.json()['detail'].lower()
                    assert 'status' not in response.json()
                assert client.get('/api/scene').json() == scene
            assert client.get('/').status_code == 200
            assert client.get('/docs').status_code == 200
            if active_socket:
                async def assert_interval_cancelled():
                    # Fault supervision exits the real interval before its deadline.
                    assert not active_timer.expired()
                    with pytest.raises(RuntimeError):
                        active_timer.reschedule(asyncio.get_running_loop().time())
                client.portal.call(assert_interval_cancelled)
            else:
                websocket = sessions.enter_context(client.websocket_connect('/ws/vehicles'))

            async def receive_message():
                return await asyncio.wait_for(websocket._send_rx.receive(), timeout=1)

            message = websocket.portal.call(receive_message)
            assert message['type'] == 'websocket.close', message
            assert message['code'] == 1011
            errors = [record for record in caplog.records if record.levelname == 'ERROR']
            assert len(errors) == 1
            assert errors[0].exc_info[0] is error_type
