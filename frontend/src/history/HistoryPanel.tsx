import type { FormEvent } from 'react';
import type { HistoryStatus, SessionSummary } from './historyClient';
import type { ReplaySceneHandle, ReplayViewModel } from './replayScene';
import type { AppMode } from '../App';

export interface HistoryPanelProps {
  open:boolean;mode:AppMode;
  recording:HistoryStatus|null;recordingError:string|null;
  sessions:readonly SessionSummary[];sessionsError:string|null;loading:boolean;nextCursor:string|null;
  replay:ReplayViewModel|null;controls:ReplaySceneHandle|null;modeError:string|null;
  onOpen():void;onReturnLive():void;onSelectSession(id:string):void;onRefresh():void;onLoadMore():void;
}
/** Pure controls/view: no Viewer, HTTP, socket, timer or motion ownership. */
export function HistoryPanel(p:HistoryPanelProps) {
  const r=p.replay,selected=r?.snapshot?.vehicles.find(v=>v.vehicle_id===r.selectedVehicleId);
  const ready=p.mode==='REPLAY'&&!!p.controls&&!!r?.session&&r.status!=='LOADING'&&r.status!=='ERROR';
  const submit=(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!ready||!r?.session)return;
    const field=event.currentTarget.elements.namedItem('time_seconds') as HTMLInputElement|null;
    if(!field||field.value.trim()==='')return;const time=Number(field.value);
    if(Number.isFinite(time)&&time>=r.session.first_simulation_time&&time<=r.session.last_simulation_time)p.controls?.seek(time);
  };
  const recording=<div className="recording-status" aria-label="Recording status">
    <p className="status-badge" data-tone={p.recording?.state==='FAILED'?'danger':p.recording?.state==='RECORDING'?'success':'neutral'}>Recording: {p.recording?.state??'unconfirmed'}</p>
    {p.recording?.error_code&&<p className="notice notice-warning" role="status">{p.recording.error_code}: {p.recording.error_message}</p>}
    {p.recordingError&&<p className="notice notice-danger" role="alert">Recording status unavailable: {p.recordingError}</p>}
  </div>;
  if(!p.open)return <div className="history-entry">{recording}<button className="primary-button" onClick={p.onOpen}>Enter history</button></div>;
  return <section className="fleet-panel history-panel" aria-label="History sessions and playback">
    <div className="panel-heading"><span className="eyebrow">HISTORY & REPLAY</span><h2>Replay workspace</h2><p className="muted">Recorded snapshots. Original telemetry.</p></div>
    <div className="fleet-controls history-navigation">
      <button className="primary-button" onClick={p.onReturnLive} disabled={p.mode==='SWITCHING'||p.mode==='ERROR'}>Return to realtime</button>
      <button onClick={p.onRefresh} disabled={p.loading||p.mode==='ERROR'}>Refresh history</button>
      {p.nextCursor!==null&&<button onClick={p.onLoadMore} disabled={p.loading||p.mode==='ERROR'}>More sessions</button>}
    </div>
    {recording}
    {p.modeError&&<p className="notice notice-danger" role="alert">{p.modeError}</p>}
    {p.loading&&<p className="notice" role="status">Loading history sessions</p>}
    {p.sessionsError&&<p className="notice notice-danger" role="alert">History unavailable: {p.sessionsError}</p>}
    {!p.loading&&!p.sessionsError&&p.sessions.length===0&&<p className="empty-state">No recorded sessions</p>}
    <div className="section-heading"><h3>Recorded sessions</h3><span className="muted">Select a finished session</span></div>
    <ul className="session-list" aria-label="Recorded sessions">{p.sessions.map(s=><li key={s.session_id}>
      <button className="session-select" data-session-id={s.session_id} aria-pressed={s.session_id===r?.session?.session_id} disabled={s.state==='RECORDING'||p.mode==='SWITCHING'||p.mode==='ERROR'}
        onClick={()=>{if(s.state!=='RECORDING')p.onSelectSession(s.session_id);}}>
        <span className="session-title"><time dateTime={s.started_utc}>{s.started_utc.replace('T',' ').replace('Z',' UTC')}</time><span className="status-badge" data-tone={s.state==='COMPLETED'?'success':s.state==='FAILED'?'danger':s.state==='INTERRUPTED'?'warning':'neutral'}>{s.state}</span></span>
        <span className="session-meta">{s.snapshot_count} snapshots · {s.last_simulation_time.toFixed(1)} s</span>
      </button>
      {s.incomplete&&<p className="notice notice-warning">Incomplete: {s.failure_code} {s.failure_message}</p>}
    </li>)}</ul>
    {p.mode==='SWITCHING'&&<p className="notice notice-warning" role="status">Switching mode; releasing previous resources</p>}
    {p.mode==='REPLAY'&&<div className="playback-workspace" aria-label="Historical playback">
      <div className="section-heading"><h2>Historical playback</h2><span className="status-badge" data-tone={r?.status==='ERROR'?'danger':r?.status==='BUFFERING'?'warning':'accent'}>{r?.status??'LOADING'}</span></div>
      <p className="muted">Playback: {r?.status??'LOADING'} · Scene: {r?.sceneState??'LOADING'}</p>
      {r?.incomplete&&<p className="notice notice-warning" role="status">Incomplete recording: {r.session?.failure_code} {r.session?.failure_message}</p>}
      {r?.sceneError&&<p className="notice notice-danger" role="alert">{r.sceneError}</p>}{r?.renderError&&<p className="notice notice-danger" role="alert">{r.renderError}</p>}
      {r?.status==='BUFFERING'&&<p className="notice notice-warning" role="status">Playback time is frozen while the next recorded page loads.</p>}
      <div className="playback-readout"><p>Playback cursor: {r?.time_seconds.toFixed(1)??'unconfirmed'} · Rate: {r?.rate??1}×</p>
        <p>Snapshot time: {r?.snapshot?.simulation_time_seconds.toFixed(1)??'unconfirmed'} · Sequence: {r?.snapshot?.sequence??'unconfirmed'}</p></div>
      <p className="muted">Recorded vehicles: {r?.snapshot?.vehicles.length??'unconfirmed'}</p>
      {r?.gap&&<p className="notice notice-warning" role="status">No intermediate records: {r.gap.from}–{r.gap.to}</p>}
      <div className="fleet-controls playback-controls" aria-label="Playback controls">
        {r?.status==='PLAYING'||r?.status==='BUFFERING'?<button className="primary-button" onClick={()=>p.controls?.pause()} disabled={!ready}>Pause</button>
          :<button className="primary-button" onClick={()=>p.controls?.play()} disabled={!ready||r?.status==='ENDED'}>Play</button>}
        <label>Rate <select value={r?.rate??1} disabled={!ready} onChange={e=>p.controls?.setRate(Number(e.currentTarget.value))}>
          {[0.5,1,2,4].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label>
        <button onClick={()=>p.controls?.replay()} disabled={!p.controls||!r?.session||r.status==='LOADING'}>Replay from start</button>
      </div>
      <form className="seek-form" onSubmit={submit}>
        <label>Seek simulation time <input name="time_seconds" type="number" step="any" required defaultValue={r?.session?.first_simulation_time??0}
          min={r?.session?.first_simulation_time??0} max={r?.session?.last_simulation_time??0} disabled={!ready}/></label>
        <button type="submit" disabled={!ready}>Seek</button>
      </form>
      <p className="field-hint">Seconds · Discrete snapshots, no interpolation</p>
      <div className="section-heading"><h3>Recorded vehicles</h3></div>
      <ul className="vehicle-list" aria-label="Recorded vehicles">{[...(r?.snapshot?.vehicles??[])].sort((a,b)=>a.vehicle_id.localeCompare(b.vehicle_id)).map(v=><li key={v.vehicle_id} className={v.vehicle_id===r?.selectedVehicleId?'vehicle-card is-selected':'vehicle-card'}>
        <div className="vehicle-card-heading"><button className="vehicle-select" data-vehicle-id={v.vehicle_id} aria-pressed={v.vehicle_id===r?.selectedVehicleId} onClick={()=>p.controls?.select(v.vehicle_id)}>{v.vehicle_id}</button>
          <span className="status-badge" data-tone={v.status==='running'?'success':'neutral'}>{v.status}</span></div>
        <div className="telemetry-row" title={`Raw telemetry: ${v.speed} km/h · SOC ${v.soc}% · Load: ${v.load}`}>
          <span><small>Speed</small><strong>{v.speed.toFixed(1)} <span className="unit">km/h</span></strong></span><span><small>SOC</small><strong>{v.soc.toFixed(1)}%</strong></span><span><small>Load</small><strong>{v.load}</strong></span>
        </div>
        <meter className="soc-meter" aria-label={`${v.vehicle_id} SOC`} min={0} max={100} value={v.soc}>{v.soc.toFixed(1)}%</meter>
      </li>)}</ul>
      <section className="detail-card" aria-label="Historical selected vehicle details">
        <h3>Vehicle inspection</h3>
        <p className="identity-line">Selected: {r?.selectedVehicleId??'none'}</p><p className="identity-line muted">Tracked: {r?.trackedVehicleId??'none'}</p>
        <div className="fleet-controls control-grid">
          <button className="primary-button" onClick={()=>p.controls?.locateSelected()} disabled={!selected||!ready}>Locate selected</button>
          <button onClick={()=>p.controls?.trackSelected()} disabled={!selected||r?.status!=='PLAYING'}>Track selected</button>
          <button onClick={()=>p.controls?.stopTracking()} disabled={!r?.trackedVehicleId}>Stop tracking</button>
          <button onClick={()=>p.controls?.select(null)} disabled={!selected}>Clear selection</button>
        </div>
        {selected?<>
          <p className="detail-title">{selected.vehicle_id}: {selected.status}</p>
          <p className="detail-reading" title={`Speed: ${selected.speed} km/h · SOC: ${selected.soc}% · Load: ${selected.load}`}>Speed: {selected.speed.toFixed(1)} km/h · SOC: {selected.soc.toFixed(1)}% · Load: {selected.load}</p>
          <dl className="detail-grid"><div><dt>Longitude</dt><dd>{selected.longitude.toFixed(6)}</dd></div><div><dt>Latitude</dt><dd>{selected.latitude.toFixed(6)}</dd></div>
            <div><dt>Ellipsoid height</dt><dd title={`Raw height: ${selected.height} m`}>{selected.height.toFixed(1)} m</dd></div><div><dt>Heading</dt><dd title={`Raw heading: ${selected.heading}°`}>{selected.heading.toFixed(1)}°</dd></div></dl>
          <p className="timestamp">Recorded UTC: <time dateTime={selected.timestamp}>{selected.timestamp}</time></p>
        </>:<p className="empty-state">No vehicle selected</p>}
      </section>
    </div>}
  </section>;
}
