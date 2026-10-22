"""History HTTP contracts against real, isolated SQLite databases."""
import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.main as main


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv('PHASE2D_HISTORY_DIR', str(tmp_path))
    async def paused(*args):
        await asyncio.Event().wait()
    monkeypatch.setattr(main, '_update_vehicle_state', paused)
    with TestClient(main.app) as value:
        yield value


def test_history_list_and_status_contract(client, tmp_path):
    before = client.get('/api/fleet').json()
    status = client.get('/api/history/status')
    assert status.status_code == 200
    assert status.json() == {
        'enabled': False, 'state': 'DISABLED_CONFIG', 'session_id': None,
        'last_offered_sequence': None, 'last_persisted_sequence': None,
        'error_code': 'INVALID_CONFIG',
        'error_message': 'Explicit valid recording configuration required',
    }
    listing = client.get('/api/history/sessions')
    assert listing.status_code == 200
    assert listing.json() == {'sessions': [], 'next_cursor': None}
    for response in (status, listing):
        assert response.headers['cache-control'] == 'no-store'
        assert response.headers['content-type'] == 'application/json'
    assert list(tmp_path.iterdir()) == []
    assert client.get('/api/fleet').json() == before


@pytest.fixture
def seeded(tmp_path):
    import json
    from copy import deepcopy
    from dataclasses import replace
    from backend.history.models import RecordingContext
    from backend.history.store import HistoryStore
    from backend.scene.loader import load_scene, DEFAULT_SCENE_PATH
    from backend.simulation.fleet import FleetSimulator
    from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS
    scene = load_scene(DEFAULT_SCENE_PATH)
    path = tmp_path / 'fleet-history.sqlite3'
    def make(index=1, count=3, state='COMPLETED', times=None, large=False, stamp=None):
        sid = f'{index:08x}-1234-4abc-8abc-123456789abc'
        stamp = stamp or f'2026-10-19T08:00:{index:02d}+00:00'
        config = DEFAULT_VEHICLE_CONFIGS
        initial = FleetSimulator(scene, vehicle_configs=config, session_id=sid).get_snapshot()
        if large:
            config = tuple(replace(config[0], vehicle_id=f'TRUCK_{i:03d}') for i in range(1, 101))
            initial['vehicles'] = [dict(initial['vehicles'][0], vehicle_id=c.vehicle_id) for c in config]
        initial['timestamp'] = stamp
        for v in initial['vehicles']:
            v['timestamp'] = stamp
        context = RecordingContext(sid, stamp, scene.get_payload(), config, 'a' * 40)
        snapshots = []
        with_store = HistoryStore(path, max_db_bytes=16777216)
        try:
            with_store.begin(context, initial)
            snapshots.append(deepcopy(initial))
            for seq in range(1, count):
                value = deepcopy(initial)
                value['sequence'] = seq
                value['simulation_time_seconds'] = float(times[seq] if times else seq)
                with_store.append(value)
                snapshots.append(value)
            if state != 'RECORDING':
                with_store.finish(state, None if state == 'COMPLETED' else 'TEST_INTERRUPTION')
        finally:
            with_store.close()
        return sid, snapshots
    return path, make, scene.get_payload()


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert set(response.json()) == {'error'}
    assert set(response.json()['error']) == {'code', 'message'}
    assert response.json()['error']['code'] == code
    assert response.headers['cache-control'] == 'no-store'


def test_list_keyset_and_detail(client, seeded):
    import base64
    import json
    path, make, _ = seeded
    ids = [make(i, stamp='2026-10-19T08:00:00+00:00')[0] for i in range(1, 5)]
    first = client.get('/api/history/sessions?limit=2').json()
    assert [s['session_id'] for s in first['sessions']] == ids[::-1][:2]
    cursor = first['next_cursor']
    decoded = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
    assert decoded == {'started_utc': '2026-10-19T08:00:00+00:00', 'session_id': ids[2]}
    second = client.get('/api/history/sessions', params={'limit': 2, 'cursor': cursor}).json()
    assert [s['session_id'] for s in second['sessions']] == ids[::-1][2:]
    assert second['next_cursor'] is None
    summary = first['sessions'][0]
    assert set(summary) == {'session_id','state','started_utc','ended_utc','snapshot_count',
                            'first_sequence','last_sequence','first_simulation_time',
                            'last_simulation_time','incomplete','failure_code','failure_message'}
    detail = client.get(f'/api/history/sessions/{ids[3]}').json()
    assert set(detail) == set(summary) | {'storage_version','fleet_schema_version','code_revision',
                                        'scene_sha256','config_sha256','vehicle_configs'}
    assert detail['snapshot_count'] == 3
    assert detail['last_sequence'] == 2 and not detail['incomplete']
    assert detail['code_revision'] == 'a' * 40
    assert [v['vehicle_id'] for v in detail['vehicle_configs']] == ['TRUCK_001','TRUCK_002','TRUCK_003']


@pytest.mark.parametrize('limit', [1, 60, 200])
def test_snapshot_pagination_bounds(client, seeded, limit):
    _, make, _ = seeded
    sid, expected = make(count=201)
    first = client.get(f'/api/history/sessions/{sid}/snapshots', params={'limit':limit})
    assert first.status_code == 200
    assert first.json() == {'session_id':sid,'snapshots':expected[:limit], 'next_after_sequence':limit-1}
    rest = client.get(f'/api/history/sessions/{sid}/snapshots', params={'limit':200,'after_sequence':limit-1}).json()
    assert rest['snapshots'] == expected[limit:]
    assert rest['next_after_sequence'] is None
    assert client.get(f'/api/history/sessions/{sid}/snapshots?after_sequence=201').json()['snapshots'] == []


def test_default_snapshot_limit_and_budget(client, seeded):
    _, make, _ = seeded
    sid, expected = make(count=70, large=True)
    result = client.get(f'/api/history/sessions/{sid}/snapshots')
    assert result.status_code == 200
    assert len(result.content) <= 1048576
    data = result.json()
    assert 1 <= len(data['snapshots']) < 60
    assert data['snapshots'] == expected[:len(data['snapshots'])]
    assert data['next_after_sequence'] == len(data['snapshots'])-1
    tail = client.get(f'/api/history/sessions/{sid}/snapshots', params={'after_sequence':data['next_after_sequence']}).json()
    assert tail['snapshots'][0] == expected[len(data['snapshots'])]


@pytest.mark.parametrize('time,index', [(0,0), (1,0), (2,1), (3.9,1), (4,2)])
def test_seek_simulation_time(client, seeded, time, index):
    _, make, scene = seeded
    sid, data = make(times=[0,2,4])
    result = client.get(f'/api/history/sessions/{sid}/seek', params={'time_seconds':time})
    assert result.status_code == 200
    assert result.json() == {'session_id':sid,'target_time_seconds':time,'snapshot':data[index],
                             'next_snapshot':data[index+1] if index<2 else None}
    assert client.get(f'/api/history/sessions/{sid}/scene').json() == scene


@pytest.mark.parametrize('state', ['RECORDING','FAILED','INTERRUPTED'])
def test_active_and_incomplete_prefix(client, seeded, state):
    _, make, _ = seeded
    sid, values = make(state=state)
    detail = client.get(f'/api/history/sessions/{sid}')
    assert detail.status_code == 200
    assert detail.json()['incomplete'] == (state != 'RECORDING')
    for suffix in ('scene','snapshots','seek?time_seconds=1'):
        result = client.get(f'/api/history/sessions/{sid}/{suffix}')
        if state == 'RECORDING':
            assert_error(result,409,'SESSION_ACTIVE')
        else:
            assert result.status_code == 200
    if state != 'RECORDING':
        assert client.get(f'/api/history/sessions/{sid}/snapshots').json()['snapshots'] == values


@pytest.mark.parametrize('query', ['limit=0','limit=201','limit=true','limit=1.5','limit=NaN',
                                   'limit=1&limit=2','cursor=bad','cursor='+'a'*257,'unexpected=1'])
def test_invalid_list_query(client, query):
    assert_error(client.get('/api/history/sessions?'+query),422,'INVALID_QUERY')


@pytest.mark.parametrize('suffix', ['snapshots?after_sequence=-2', 'snapshots?after_sequence=9007199254740992',
    'snapshots?after_sequence=0&after_sequence=1','snapshots?after_sequence=true',
    'seek','seek?time_seconds=NaN','seek?time_seconds=Infinity','seek?time_seconds=-1',
    'seek?time_seconds=3','seek?time_seconds=true','seek?time_seconds=1&time_seconds=2'])
def test_invalid_snapshot_and_seek_query(client, seeded, suffix):
    _, make, _ = seeded
    sid, _ = make()
    assert_error(client.get(f'/api/history/sessions/{sid}/{suffix}'),422,'INVALID_QUERY')


@pytest.mark.parametrize('sid', ['not-uuid', '00000001-1234-1abc-8abc-123456789abc', "x' OR 1=1--"])
def test_invalid_id_rejects_sql_input(client, sid):
    assert_error(client.get(f'/api/history/sessions/{sid}'),422,'INVALID_QUERY')


def test_missing_and_readonly_do_not_create_or_write(client, seeded):
    import hashlib
    path, make, _ = seeded
    missing = '12345678-1234-4abc-8abc-123456789abc'
    assert_error(client.get(f'/api/history/sessions/{missing}'),404,'SESSION_NOT_FOUND')
    assert not path.exists()
    sid, _ = make(state='FAILED')
    before_bytes = hashlib.sha256(path.read_bytes()).hexdigest()
    before = client.get('/api/fleet').json()
    for suffix in ('','/scene','/snapshots','/seek?time_seconds=1'):
        assert client.get(f'/api/history/sessions/{sid}{suffix}').status_code == 200
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before_bytes
    assert client.get('/api/fleet').json() == before


@pytest.mark.parametrize('mutation', [
    "UPDATE history_sessions SET scene_sha256='bad'",
    "UPDATE history_sessions SET config_sha256='bad'",
    "UPDATE history_sessions SET snapshot_count=4",
    "UPDATE history_sessions SET last_simulation_time=99",
    "DELETE FROM history_snapshots WHERE sequence=1",
    "UPDATE history_snapshots SET payload_sha256='bad' WHERE sequence=1",
    "UPDATE history_snapshots SET timestamp='2026-10-19T09:00:00+00:00' WHERE sequence=1",
    "UPDATE history_snapshots SET simulation_time_seconds=1.5 WHERE sequence=1",
    "UPDATE history_snapshots SET simulation_time_seconds=0.5 WHERE sequence=2",
    "UPDATE history_sessions SET started_utc='2026-02-30T08:00:00+00:00'",
])
def test_integrity_rejects_corrupt_records(client, seeded, mutation):
    import sqlite3
    path, make, _ = seeded
    sid, _ = make()
    with sqlite3.connect(path) as db:
        db.execute(mutation)
    assert_error(client.get(f'/api/history/sessions/{sid}/snapshots'),409,'HISTORY_CORRUPT')
    assert client.get('/health').status_code == 200
    assert client.get('/api/fleet').status_code == 200


def test_duplicate_sequence_in_tampered_schema_rejected(client, seeded):
    import sqlite3
    path, make, _ = seeded
    sid, _ = make()
    with sqlite3.connect(path) as db:
        db.executescript('ALTER TABLE history_snapshots RENAME TO original; '
            'CREATE TABLE history_snapshots AS SELECT * FROM original; '
            'INSERT INTO history_snapshots SELECT * FROM original WHERE sequence=1; DROP TABLE original;')
    assert_error(client.get(f'/api/history/sessions/{sid}/snapshots'),409,'HISTORY_CORRUPT')


def test_payload_hash_recomputed_but_index_disagrees(client, seeded):
    import json
    import sqlite3
    from backend.history.models import canonical_json, digest
    path, make, _ = seeded
    sid, values = make()
    values[1]['sequence'] = 99
    text = canonical_json(values[1])
    with sqlite3.connect(path) as db:
        db.execute('UPDATE history_snapshots SET payload_json=?,payload_sha256=? WHERE sequence=1',
                   (text,digest(text)))
    assert_error(client.get(f'/api/history/sessions/{sid}/snapshots'),409,'HISTORY_CORRUPT')


def test_meta_hash_validation_on_list_and_scene(client, seeded):
    import sqlite3
    path, make, _ = seeded
    sid, _ = make()
    with sqlite3.connect(path) as db:
        db.execute("UPDATE history_sessions SET config_json='[]'")
    for url in ('/api/history/sessions', f'/api/history/sessions/{sid}',f'/api/history/sessions/{sid}/scene'):
        assert_error(client.get(url),409,'HISTORY_CORRUPT')


def test_real_readonly_transaction_and_close_before_response(client, seeded, monkeypatch):
    import sqlite3
    import backend.history.queries as queries
    _, make, _ = seeded
    sid, _ = make()
    real_connect = sqlite3.connect
    connections, traces, closing = [], [], []
    class Tracked(sqlite3.Connection):
        def close(self):
            closing.append((self.execute('PRAGMA query_only').fetchone()[0], self.in_transaction))
            return super().close()
    def tracked_connect(*args, **kwargs):
        assert 'mode=ro' in args[0] and kwargs['uri']
        db = real_connect(*args, **kwargs, factory=Tracked)
        connections.append(db)
        db.set_trace_callback(traces.append)
        return db
    monkeypatch.setattr(queries.sqlite3,'connect',tracked_connect)
    assert client.get(f'/api/history/sessions/{sid}/snapshots').status_code == 200
    assert closing == [(1,True)]
    assert 'BEGIN' in traces
    assert not any(s.lstrip().upper().startswith(('INSERT','UPDATE','DELETE','CREATE','REPLACE')) for s in traces)
    for db in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            db.execute('SELECT 1')


def test_query_vm_deadline_closes_connection_and_live_is_unaffected(client, seeded, monkeypatch):
    import backend.history.queries as queries
    import sqlite3
    _, make, _ = seeded
    sid, _ = make()
    clock, opened = [0.0], []
    real_meta = queries.HistoryQueries._meta
    monkeypatch.setattr(queries,'monotonic',lambda: clock[0])
    def slow_meta(self, reader, session_id, **kwargs):
        opened.append(reader.db)
        def expire():
            clock[0] = 3.0
            return 1
        reader.db.create_function('expire_budget',0,expire)
        reader.execute('WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<100000) SELECT SUM(expire_budget()) FROM x').fetchone()
        return real_meta(self,reader,session_id,**kwargs)
    monkeypatch.setattr(queries.HistoryQueries,'_meta',slow_meta)
    assert_error(client.get(f'/api/history/sessions/{sid}'),503,'HISTORY_BUSY')
    with pytest.raises(sqlite3.ProgrammingError):
        opened[0].execute('SELECT 1')
    assert client.get('/health').status_code == 200


def test_real_exclusive_lock_maps_busy(client, seeded):
    import sqlite3
    path, make, _ = seeded
    sid, _ = make()
    db = sqlite3.connect(path, isolation_level=None)
    try:
        db.execute('BEGIN EXCLUSIVE')
        assert_error(client.get(f'/api/history/sessions/{sid}'),503,'HISTORY_BUSY')
        assert client.get('/health').status_code == 200
    finally:
        db.rollback()
        db.close()
    assert client.get(f'/api/history/sessions/{sid}').status_code == 200


def test_database_unavailable_and_corrupt_are_distinct(client, tmp_path):
    path = tmp_path / 'fleet-history.sqlite3'
    path.mkdir()
    assert_error(client.get('/api/history/sessions'),503,'HISTORY_UNAVAILABLE')
    path.rmdir()
    path.write_bytes(b'this is not a database')
    assert_error(client.get('/api/history/sessions'),409,'HISTORY_CORRUPT')
    assert client.get('/health').status_code == 200


def test_concurrent_writer_cannot_mix_read_transaction(client, seeded, monkeypatch):
    import threading
    import sqlite3
    import backend.history.queries as queries
    from backend.history.store import HistoryStore
    from backend.history.models import RecordingContext
    from backend.scene.loader import load_scene, DEFAULT_SCENE_PATH
    from backend.simulation.fleet import FleetSimulator
    from backend.simulation.fleet_config import DEFAULT_VEHICLE_CONFIGS
    path, _, _ = seeded
    ready, append_now, commit_entered = threading.Event(),threading.Event(),threading.Event()
    errors = []
    sid = 'abcd1234-1234-4abc-8abc-123456789abc'
    scene = load_scene(DEFAULT_SCENE_PATH)
    initial = FleetSimulator(scene,vehicle_configs=DEFAULT_VEHICLE_CONFIGS,session_id=sid).get_snapshot()
    def writer():
        store = None
        try:
            store = HistoryStore(path,max_db_bytes=16777216)
            store._db.execute('PRAGMA busy_timeout=3000')  # Test synchronization, not production policy.
            store.begin(RecordingContext(sid,initial['timestamp'],scene.get_payload(),DEFAULT_VEHICLE_CONFIGS,None),initial)
            store._db.set_trace_callback(lambda sql: commit_entered.set() if sql=='COMMIT' else None)
            ready.set()
            assert append_now.wait(5)
            value = dict(initial,sequence=1,simulation_time_seconds=1.0)
            store.append(value)
        except BaseException as error:
            errors.append(error)
        finally:
            ready.set()
            if store is not None:
                store.close()
    thread = threading.Thread(target=writer)
    thread.start()
    real_execute = queries._Reader.execute
    synchronized = []
    def execute(reader,sql,parameters=()):
        cursor = real_execute(reader,sql,parameters)
        if sql.startswith('SELECT * FROM history_sessions') and not synchronized:
            synchronized.append(True)
            append_now.set()
            assert commit_entered.wait(3)
        return cursor
    try:
        assert ready.wait(3)
        assert not errors
        monkeypatch.setattr(queries._Reader,'execute',execute)
        result = client.get(f'/api/history/sessions/{sid}')
        assert result.status_code == 200
        assert result.json()['snapshot_count'] == 1
        assert result.json()['last_sequence'] == 0
        thread.join(5)
        assert not thread.is_alive() and not errors
        next_read = client.get(f'/api/history/sessions/{sid}').json()
        assert next_read['snapshot_count'] == 2 and next_read['last_sequence'] == 1
        with sqlite3.connect(path) as db:
            assert db.execute('SELECT state FROM history_sessions').fetchone()[0] == 'RECORDING'
    finally:
        append_now.set()
        thread.join(5)
    assert synchronized


def test_relative_history_path_is_not_resolved_against_cwd(tmp_path, monkeypatch):
    from backend.history.queries import HistoryQueries, HistoryQueryError
    monkeypatch.chdir(tmp_path)
    with pytest.raises(HistoryQueryError) as error:
        HistoryQueries(Path('relative')/'fleet-history.sqlite3').list_sessions()
    assert error.value.code == 'HISTORY_UNAVAILABLE'
    assert list(tmp_path.iterdir()) == []


def test_strict_direct_query_numbers(client, seeded):
    from backend.history.queries import HistoryQueries, HistoryQueryError
    path,make,_ = seeded
    sid,_ = make()
    query = HistoryQueries(path)
    for value in (True, '1', float('nan'), float('inf'), 10**1000):
        with pytest.raises(HistoryQueryError) as error:
            query.seek(sid,time_seconds=value)
        assert error.value.code == 'INVALID_QUERY'


def test_source_relative_uri_handles_unicode_and_hash(seeded, tmp_path):
    from backend.history.queries import HistoryQueries
    path,make,_ = seeded
    sid,_ = make()
    folder = tmp_path/'mine # 场景'
    folder.mkdir()
    target = folder/'fleet-history.sqlite3'
    target.write_bytes(path.read_bytes())
    assert HistoryQueries(target).get_session(sid)['session_id'] == sid


def test_default_limit_cursor_and_version_edges(client, seeded):
    import base64
    import json
    import sqlite3
    path,make,_ = seeded
    sid,values = make(count=61)
    page = client.get(f'/api/history/sessions/{sid}/snapshots').json()
    assert page['snapshots'] == values[:60] and page['next_after_sequence'] == 59
    for value in ({'started_utc':'2026-02-30T00:00:00Z','session_id':sid},
                  {'started_utc':'2026-10-19T00:00:00Z','session_id':sid,'extra':1}):
        cursor = base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
        assert_error(client.get('/api/history/sessions',params={'cursor':cursor}),422,'INVALID_QUERY')
    with sqlite3.connect(path) as db:
        db.execute('PRAGMA user_version=2')
    assert_error(client.get('/api/history/sessions'),409,'HISTORY_CORRUPT')
    assert client.get('/api/history/status').status_code == 200


def test_busy_wait_uses_only_remaining_query_budget(client, seeded, monkeypatch):
    import backend.history.queries as queries
    _,make,_ = seeded
    sid,_ = make()
    clock, observed = [0.0], []
    real_meta = queries.HistoryQueries._meta
    monkeypatch.setattr(queries,'monotonic',lambda:clock[0])
    def near_deadline(self,reader,session_id,**kwargs):
        clock[0] = 1.95
        observed.append(reader.execute('PRAGMA busy_timeout').fetchone()[0])
        return real_meta(self,reader,session_id,**kwargs)
    monkeypatch.setattr(queries.HistoryQueries,'_meta',near_deadline)
    assert client.get(f'/api/history/sessions/{sid}').status_code == 200
    assert len(observed)==1 and 0 < observed[0] <= 50


@pytest.mark.parametrize('table,column', [('history_snapshots','payload_sha256'),('history_sessions','failure_message')])
@pytest.mark.parametrize('empty', [False,True])
def test_missing_schema_column_is_structured_corruption(client, seeded, table, column, empty):
    import sqlite3
    path,make,_ = seeded
    sid,_ = make()
    with sqlite3.connect(path) as db:
        if empty:
            db.execute('DELETE FROM history_snapshots')
            db.execute('DELETE FROM history_sessions')
        # Test-selected constants, never request input.
        db.execute(f'ALTER TABLE {table} DROP COLUMN {column}')
    url = '/api/history/sessions' if empty else f'/api/history/sessions/{sid}'
    assert_error(client.get(url),409,'HISTORY_CORRUPT')
    assert client.get('/api/history/status').status_code == 200
    assert client.get('/health').status_code == 200
