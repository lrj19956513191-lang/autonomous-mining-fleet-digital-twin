"""HTTP adapter: strict query grammar, safe errors and no simulation privileges."""
import math
import re
from dataclasses import asdict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend.history.queries import HistoryQueries, HistoryQueryError

router = APIRouter(prefix='/api/history')
ERRORS = {
    'INVALID_QUERY':(422,'Invalid history query'),
    'SESSION_NOT_FOUND':(404,'History session not found'),
    'SESSION_ACTIVE':(409,'History session is still recording'),
    'HISTORY_CORRUPT':(409,'History data failed integrity checks'),
    'HISTORY_UNAVAILABLE':(503,'History storage unavailable'),
    'HISTORY_BUSY':(503,'History query could not complete within its budget'),
}


def response(value, status=200):
    return JSONResponse(value, status_code=status, headers={'cache-control':'no-store'})


def parameters(request, allowed):
    items = list(request.query_params.multi_items())
    if any(key not in allowed for key,value in items) or len({key for key,value in items}) != len(items):
        raise HistoryQueryError('INVALID_QUERY')
    return dict(items)


def integer(value):
    if len(value) > 20 or re.fullmatch(r'-?[0-9]+', value) is None:
        raise HistoryQueryError('INVALID_QUERY')
    return int(value)


def dispatch(request, method, session_id=None, allowed=()):
    try:
        params = parameters(request,allowed)
        kwargs = {}
        for name,value in params.items():
            if name in ('limit','after_sequence'):
                kwargs[name] = integer(value)
            elif name == 'time_seconds':
                if len(value)>128 or re.fullmatch(r'-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?',value) is None:
                    raise HistoryQueryError('INVALID_QUERY')
                kwargs[name] = float(value)
                if not math.isfinite(kwargs[name]):
                    raise HistoryQueryError('INVALID_QUERY')
            else:
                kwargs[name] = value
        if method == 'status':
            return response(asdict(request.app.state.history_recorder.get_status()))
        if method == 'seek' and 'time_seconds' not in kwargs:
            raise HistoryQueryError('INVALID_QUERY')
        query = HistoryQueries(request.app.state.history_settings.directory / 'fleet-history.sqlite3')
        args = (session_id,) if session_id is not None else ()
        return response(getattr(query,method)(*args,**kwargs))
    except HistoryQueryError as error:
        status,message = ERRORS[error.code]
        return response({'error':{'code':error.code,'message':message}},status)


@router.get('/status')
def get_status(request: Request):
    return dispatch(request,'status')


@router.get('/sessions')
def list_sessions(request: Request):
    return dispatch(request,'list_sessions',allowed=('limit','cursor'))


@router.get('/sessions/{session_id}')
def get_session(session_id: str, request: Request):
    return dispatch(request,'get_session',session_id)


@router.get('/sessions/{session_id}/scene')
def get_scene(session_id: str, request: Request):
    return dispatch(request,'get_scene',session_id)


@router.get('/sessions/{session_id}/snapshots')
def get_snapshots(session_id: str, request: Request):
    return dispatch(request,'get_snapshots',session_id,allowed=('limit','after_sequence'))


@router.get('/sessions/{session_id}/seek')
def seek(session_id: str, request: Request):
    return dispatch(request,'seek',session_id,allowed=('time_seconds',))
