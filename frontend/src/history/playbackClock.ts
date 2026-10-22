export interface PlaybackClockState {
  readonly status: 'PAUSED' | 'PLAYING' | 'ENDED';
  readonly time_seconds: number;
  readonly rate: 0.5 | 1 | 2 | 4;
}

type Action = 'play' | 'pause' | 'tick' | 'setRate' | 'seek';
function requireFinite(value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError('Playback clock requires finite numbers');
  }
}
function isRate(value: number): value is PlaybackClockState['rate'] {
  return value === 0.5 || value === 1 || value === 2 || value === 4;
}

/** Pure cursor clock; its caller owns scheduling and supplies monotonic milliseconds. */
export function createPlaybackClock({start, end}: {start: number; end: number}) {
  requireFinite(start);
  requireFinite(end);
  if (start > end) throw new RangeError('Playback start must not exceed end');

  let state: PlaybackClockState = {
    status: start === end ? 'ENDED' : 'PAUSED', time_seconds: start, rate: 1,
  };
  let lastNow: number | null = null;
  let anchorNow = 0;
  let anchorTime = start;
  const snapshot = (): PlaybackClockState => Object.freeze({...state});

  function update(action: Action, nowMs: number, value?: number): PlaybackClockState {
    requireFinite(nowMs);
    if (lastNow !== null && nowMs < lastNow) throw new RangeError('Playback time must be monotonic');
    if (action === 'setRate' && !isRate(value!)) throw new RangeError('Unsupported playback rate');
    if (action === 'seek') {
      requireFinite(value!);
      if (value! < start || value! > end) throw new RangeError('Seek is outside the session');
    }

    // Prepare every field locally. Invalid operations must not even advance lastNow.
    let candidate = {...state};
    let nextAnchorNow = anchorNow;
    let nextAnchorTime = anchorTime;
    if (action !== 'seek' && state.status === 'PLAYING') {
      const elapsedMs = nowMs - anchorNow;
      const advance = (elapsedMs / 1000) * state.rate;
      requireFinite(elapsedMs);
      requireFinite(advance);
      // This is the explicit end rule, not a tolerance for invalid input.
      candidate.time_seconds = Math.min(end, anchorTime + advance);
      requireFinite(candidate.time_seconds);
      if (candidate.time_seconds === end) candidate.status = 'ENDED';
    }

    if (action === 'seek') {
      candidate.time_seconds = value!;
      candidate.status = value === end ? 'ENDED' : 'PAUSED';
    } else if (action === 'play' && candidate.status === 'PAUSED') {
      candidate.status = 'PLAYING';
    } else if (action === 'pause' && candidate.status === 'PLAYING') {
      candidate.status = 'PAUSED';
    } else if (action === 'setRate') {
      candidate.rate = value as PlaybackClockState['rate'];
    }

    // Keep an unchanged playback anchor across ticks/repeated play calls. This
    // prevents tick partitioning from accumulating rounding error at the end.
    if (action === 'seek' || (action === 'play' && state.status === 'PAUSED')
      || (action === 'setRate' && candidate.rate !== state.rate)) {
      nextAnchorNow = nowMs;
      nextAnchorTime = candidate.time_seconds;
    }
    state = candidate;
    lastNow = nowMs;
    anchorNow = nextAnchorNow;
    anchorTime = nextAnchorTime;
    return snapshot();
  }

  return {
    play: (nowMs: number) => update('play', nowMs),
    pause: (nowMs: number) => update('pause', nowMs),
    setRate: (rate: number, nowMs: number) => update('setRate', nowMs, rate),
    seek: (time: number, nowMs: number) => update('seek', nowMs, time),
    tick: (nowMs: number) => update('tick', nowMs),
    getState: snapshot,
  };
}