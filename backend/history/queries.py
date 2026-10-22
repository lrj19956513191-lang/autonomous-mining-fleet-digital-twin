"""Bounded, materialized reads. No writer, recovery, simulator or connection cache.

The deadline covers SQLite VM progress, bounded busy waits and Python checkpoints.
It cannot forcibly interrupt arbitrary OS I/O or a single native call; the same
request worker retains ownership until finally closes its connection. No timeout
thread is abandoned and no cursor/connection escapes into the HTTP response.
"""
import base64
import math
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from time import monotonic

from backend.history.models import (
    MAX_SEQUENCE, UUID4, HistoryError, canonical_json, capture_snapshot, digest,
    parse_json, valid_timestamp,
)
from backend.simulation.fleet_config import VehicleConfig, ParkingWindow, validate_vehicle_configs

QUERY_SECONDS = 2.0
PAGE_BYTES = 1048576
SUMMARY_KEYS = ('session_id','state','started_utc','ended_utc','snapshot_count',
                'last_sequence','first_simulation_time','last_simulation_time',
                'failure_code','failure_message')


class HistoryQueryError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def invalid():
    raise HistoryQueryError('INVALID_QUERY')


def check_id(value):
    if type(value) is not str or UUID4.fullmatch(value) is None:
        invalid()


def check_limit(value):
    if type(value) is not int or not 1 <= value <= 200:
        invalid()


def decode_cursor(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str) or not 1 <= len(value) <= 256:
            invalid()
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
            invalid()
        data = parse_json(raw.decode('utf-8'))
        if not isinstance(data, dict) or set(data) != {'started_utc','session_id'}:
            invalid()
        check_id(data['session_id'])
        if not valid_timestamp(data['started_utc']):
            invalid()
        return data
    except (ValueError, UnicodeError, TypeError) as cause:
        raise HistoryQueryError('INVALID_QUERY') from cause


def encode_cursor(meta):
    value = {key:meta[key] for key in ('started_utc','session_id')}
    return base64.urlsafe_b64encode(canonical_json(value).encode()).decode().rstrip('=')


class _Reader:
    def __init__(self, db, deadline):
        self.db, self.deadline = db, deadline

    def check(self):
        if monotonic() >= self.deadline:
            raise HistoryQueryError('HISTORY_BUSY')

    def execute(self, sql, parameters=()):
        self.check()
        # PRAGMA cannot bind a parameter; this bounded integer is internal, never user SQL.
        wait_ms = max(0,min(200,int((self.deadline-monotonic())*1000)))
        self.db.execute(f'PRAGMA busy_timeout={wait_ms}')
        cursor = self.db.execute(sql, parameters)
        self.check()
        return cursor


class HistoryQueries:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def _transaction(self):
        deadline = monotonic() + QUERY_SECONDS
        db = None
        try:
            if not self.path.is_absolute():
                raise HistoryQueryError('HISTORY_UNAVAILABLE')
            if not self.path.exists():
                if monotonic() >= deadline:
                    raise HistoryQueryError('HISTORY_BUSY')
                yield None
                return
            if not self.path.is_file():
                raise HistoryQueryError('HISTORY_UNAVAILABLE')
            db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True,
                                 timeout=min(.2, QUERY_SECONDS))
            db.row_factory = sqlite3.Row
            db.set_progress_handler(lambda: int(monotonic() >= deadline), 1000)
            reader = _Reader(db, deadline)
            reader.execute('PRAGMA query_only=ON')
            reader.execute('BEGIN')
            if reader.execute('PRAGMA user_version').fetchone()[0] != 1:
                raise HistoryQueryError('HISTORY_CORRUPT')
            # Validate required v1 columns even in an empty database; no schema writes.
            meta_columns = SUMMARY_KEYS + ('storage_version','fleet_schema_version','code_revision',
                'scene_json','config_json','scene_sha256','config_sha256')
            reader.execute('SELECT ' + ','.join(meta_columns) + ' FROM history_sessions LIMIT 0')
            reader.execute('SELECT session_id,sequence,simulation_time_seconds,timestamp,'
                           'payload_json,payload_sha256 FROM history_snapshots LIMIT 0')
            yield reader
            reader.check()
        except sqlite3.Error as cause:
            code = getattr(cause, 'sqlite_errorcode', 0) & 255
            if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_INTERRUPT):
                error = 'HISTORY_BUSY'
            elif code in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_ERROR,
                           sqlite3.SQLITE_SCHEMA, sqlite3.SQLITE_MISMATCH):
                error = 'HISTORY_CORRUPT'
            else:
                error = 'HISTORY_UNAVAILABLE'
            raise HistoryQueryError(error) from cause
        except OSError as cause:
            raise HistoryQueryError('HISTORY_UNAVAILABLE') from cause
        finally:
            if db is not None:
                db.close()

    def _meta(self, reader, session_id, *, terminal=False):
        if reader is None:
            raise HistoryQueryError('SESSION_NOT_FOUND')
        size = reader.execute('SELECT length(CAST(scene_json AS BLOB)) + '
            'length(CAST(config_json AS BLOB)) FROM history_sessions WHERE session_id=?',
            (session_id,)).fetchone()
        if size is None:
            raise HistoryQueryError('SESSION_NOT_FOUND')
        if type(size[0]) is not int or not 0 < size[0] <= 4 * 1024 * 1024:
            raise HistoryQueryError('HISTORY_CORRUPT')
        row = reader.execute('SELECT * FROM history_sessions WHERE session_id=?', (session_id,)).fetchone()
        meta = dict(row)
        try:
            if (meta['session_id'] != session_id or UUID4.fullmatch(meta['session_id']) is None
                or type(meta['storage_version']) is not int or meta['storage_version'] != 1
                or type(meta['fleet_schema_version']) is not int or meta['fleet_schema_version'] != 1
                or meta['state'] not in ('RECORDING','COMPLETED','FAILED','INTERRUPTED')
                or not valid_timestamp(meta['started_utc'])
                or (meta['ended_utc'] is not None if meta['state']=='RECORDING'
                    else not valid_timestamp(meta['ended_utc']))
                or meta['code_revision'] is not None and
                    (not isinstance(meta['code_revision'],str) or re.fullmatch(r'[0-9a-f]{40}',meta['code_revision']) is None)
                or type(meta['snapshot_count']) is not int or meta['snapshot_count'] < 1
                or type(meta['last_sequence']) is not int or not 0 <= meta['last_sequence'] <= MAX_SEQUENCE
                or meta['snapshot_count'] != meta['last_sequence'] + 1
                or any(type(meta[k]) not in (int,float) or not math.isfinite(meta[k])
                       for k in ('first_simulation_time','last_simulation_time'))
                or meta['first_simulation_time'] != 0 or meta['last_simulation_time'] < 0):
                raise HistoryQueryError('HISTORY_CORRUPT')
            if meta['state'] in ('RECORDING','COMPLETED'):
                if meta['failure_code'] is not None or meta['failure_message'] is not None:
                    raise HistoryQueryError('HISTORY_CORRUPT')
            elif (not isinstance(meta['failure_code'],str)
                  or re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}',meta['failure_code']) is None
                  or not isinstance(meta['failure_message'],str) or not 1 <= len(meta['failure_message']) <= 512):
                raise HistoryQueryError('HISTORY_CORRUPT')
            for name in ('scene','config'):
                text = meta[name+'_json']
                value = parse_json(text)
                if canonical_json(value) != text or digest(text) != meta[name+'_sha256']:
                    raise HistoryQueryError('HISTORY_CORRUPT')
                meta['_'+name] = value
            if not isinstance(meta['_scene'],dict) or not isinstance(meta['_config'],list):
                raise HistoryQueryError('HISTORY_CORRUPT')
            configs = []
            for config in meta['_config']:
                config = dict(config)
                if config['parking'] is not None:
                    config['parking'] = ParkingWindow(**config['parking'])
                configs.append(VehicleConfig(**config))
            validate_vehicle_configs(tuple(configs))
            aggregate = reader.execute("""SELECT COUNT(*),COUNT(DISTINCT sequence),MIN(sequence),MAX(sequence),
                MIN(simulation_time_seconds),MAX(simulation_time_seconds),
                SUM(CASE WHEN typeof(sequence)<>'integer' OR typeof(simulation_time_seconds) NOT IN ('integer','real')
                    OR typeof(payload_json)<>'text' OR length(CAST(payload_json AS BLOB))>65536 THEN 1 ELSE 0 END)
                FROM history_snapshots WHERE session_id=?""",(session_id,)).fetchone()
            count = meta['snapshot_count']
            if (tuple(aggregate[:4]) != (count,count,0,meta['last_sequence'])
                or aggregate[4] != 0 or aggregate[5] != meta['last_simulation_time'] or aggregate[6] != 0):
                raise HistoryQueryError('HISTORY_CORRUPT')
            backwards = reader.execute('SELECT 1 FROM history_snapshots a JOIN history_snapshots b '
                'ON b.session_id=a.session_id AND b.sequence=a.sequence+1 '
                'WHERE a.session_id=? AND b.simulation_time_seconds<=a.simulation_time_seconds LIMIT 1',
                (session_id,)).fetchone()
            if backwards:
                raise HistoryQueryError('HISTORY_CORRUPT')
            for seq in {0,meta['last_sequence']}:
                boundary = reader.execute('SELECT * FROM history_snapshots WHERE session_id=? AND sequence=?',
                                          (session_id,seq)).fetchone()
                value = self._snapshot(boundary)
                if value['session_id'] != session_id or (seq==0 and value['timestamp'] != meta['started_utc']):
                    raise HistoryQueryError('HISTORY_CORRUPT')
            reader.check()
        except (HistoryError,ValueError,TypeError,KeyError,IndexError,OverflowError,RecursionError) as cause:
            if isinstance(cause,HistoryQueryError):
                raise
            raise HistoryQueryError('HISTORY_CORRUPT') from cause
        if terminal and meta['state'] == 'RECORDING':
            raise HistoryQueryError('SESSION_ACTIVE')
        return meta

    @staticmethod
    def _summary(meta):
        return {**{key:meta[key] for key in SUMMARY_KEYS}, 'first_sequence':0,
                'incomplete':meta['state'] in ('FAILED','INTERRUPTED')}

    def list_sessions(self, *, limit=60, cursor=None):
        check_limit(limit)
        key = decode_cursor(cursor)
        with self._transaction() as reader:
            if reader is None:
                return {'sessions':[], 'next_cursor':None}
            where, parameters = '', []
            if key is not None:
                where = 'WHERE started_utc < ? OR (started_utc = ? AND session_id < ?)'
                parameters = [key['started_utc'], key['started_utc'], key['session_id']]
            result = reader.execute('SELECT session_id,started_utc FROM history_sessions ' + where +
                ' ORDER BY started_utc DESC,session_id DESC LIMIT ?', (*parameters,limit+1)).fetchall()
            page = [self._meta(reader,row['session_id']) for row in result[:limit]]
            return {'sessions':[self._summary(row) for row in page],
                    'next_cursor':encode_cursor(page[-1]) if len(result)>limit else None}

    def get_session(self, session_id):
        check_id(session_id)
        with self._transaction() as reader:
            meta = self._meta(reader, session_id)
            return {**self._summary(meta), **{key:meta[key] for key in
                ('storage_version','fleet_schema_version','code_revision','scene_sha256','config_sha256')},
                'vehicle_configs':meta['_config']}

    def get_scene(self, session_id):
        check_id(session_id)
        with self._transaction() as reader:
            return self._meta(reader, session_id, terminal=True)['_scene']

    @staticmethod
    def _snapshot(row):
        try:
            if row is None:
                raise HistoryQueryError('HISTORY_CORRUPT')
            value, text = capture_snapshot(parse_json(row['payload_json']))
            if (text != row['payload_json'] or digest(text) != row['payload_sha256']
                or value['session_id'] != row['session_id']
                or type(row['sequence']) is not int or value['sequence'] != row['sequence']
                or value['simulation_time_seconds'] != row['simulation_time_seconds']
                or value['timestamp'] != row['timestamp']):
                raise HistoryQueryError('HISTORY_CORRUPT')
            return value
        except (HistoryError,ValueError,TypeError,KeyError,IndexError,OverflowError,RecursionError) as cause:
            if isinstance(cause,HistoryQueryError):
                raise
            raise HistoryQueryError('HISTORY_CORRUPT') from cause

    def get_snapshots(self, session_id, *, after_sequence=-1, limit=60):
        check_id(session_id)
        check_limit(limit)
        if type(after_sequence) is not int or not -1 <= after_sequence <= MAX_SEQUENCE:
            invalid()
        with self._transaction() as reader:
            self._meta(reader, session_id, terminal=True)
            rows = reader.execute('SELECT * FROM history_snapshots WHERE session_id=? AND sequence>? '
                                  'ORDER BY sequence LIMIT ?', (session_id,after_sequence,limit+1)).fetchall()
            values, used = [], 128
            for row in rows[:limit]:
                reader.check()
                value = self._snapshot(row)
                size = len(canonical_json(value).encode('utf-8')) + 1
                if used + size > PAGE_BYTES:
                    break
                values.append(value)
                used += size
            return {'session_id':session_id,'snapshots':values,
                    'next_after_sequence':values[-1]['sequence'] if len(rows)>len(values) and values else None}

    def seek(self, session_id, *, time_seconds):
        check_id(session_id)
        try:
            finite = type(time_seconds) in (int,float) and math.isfinite(time_seconds)
        except OverflowError:
            finite = False
        if not finite:
            invalid()
        with self._transaction() as reader:
            meta = self._meta(reader,session_id,terminal=True)
            if not meta['first_simulation_time'] <= time_seconds <= meta['last_simulation_time']:
                invalid()
            row = reader.execute('SELECT * FROM history_snapshots WHERE session_id=? '
                'AND simulation_time_seconds<=? ORDER BY simulation_time_seconds DESC LIMIT 1',
                (session_id,time_seconds)).fetchone()
            next_row = reader.execute('SELECT * FROM history_snapshots WHERE session_id=? '
                'AND sequence>? ORDER BY sequence LIMIT 1',(session_id,row['sequence'])).fetchone()
            return {'session_id':session_id,'target_time_seconds':time_seconds,
                    'snapshot':self._snapshot(row), 'next_snapshot':self._snapshot(next_row) if next_row else None}
