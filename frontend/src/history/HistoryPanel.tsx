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
  const recording=<div aria-label="Recording status">
    <p>Recording: {p.recording?.state??'unconfirmed'}</p>
    {p.recording?.error_code&&<p role="status">{p.recording.error_code}: {p.recording.error_message}</p>}
    {p.recordingError&&<p role="alert">Recording status unavailable: {p.recordingError}</p>}
  </div>;
  if(!p.open)return <div>{recording}<button onClick={p.onOpen}>Enter history</button></div>;
  return <section className="fleet-panel" aria-label="History sessions and playback">
    {recording}
    <div className="fleet-controls">
      <button onClick={p.onReturnLive} disabled={p.mode==='SWITCHING'||p.mode==='ERROR'}>Return to realtime</button>
      <button onClick={p.onRefresh} disabled={p.loading||p.mode==='ERROR'}>Refresh history</button>
      {p.nextCursor!==null&&<button onClick={p.onLoadMore} disabled={p.loading||p.mode==='ERROR'}>More sessions</button>}
    </div>
    {p.modeError&&<p role="alert">{p.modeError}</p>}
    {p.loading&&<p role="status">Loading history sessions</p>}
    {p.sessionsError&&<p role="alert">History unavailable: {p.sessionsError}</p>}
    {!p.loading&&!p.sessionsError&&p.sessions.length===0&&<p>No recorded sessions</p>}
    <ul aria-label="Recorded sessions">{p.sessions.map(s=><li key={s.session_id}>
      <button data-session-id={s.session_id} disabled={s.state==='RECORDING'||p.mode==='SWITCHING'||p.mode==='ERROR'}
        onClick={()=>{if(s.state!=='RECORDING')p.onSelectSession(s.session_id);}}>{s.started_utc} · {s.state} · {s.snapshot_count} snapshots</button>
      {s.incomplete&&<span> Incomplete: {s.failure_code} {s.failure_message}</span>}
    </li>)}</ul>
    {p.mode==='SWITCHING'&&<p role="status">Switching mode; releasing previous resources</p>}
    {p.mode==='REPLAY'&&<div aria-label="Historical playback">
      <h2>Historical playback</h2>
      <p>Playback: {r?.status??'LOADING'} · Scene: {r?.sceneState??'LOADING'}</p>
      {r?.incomplete&&<p role="status">Incomplete recording: {r.session?.failure_code} {r.session?.failure_message}</p>}
      {r?.sceneError&&<p role="alert">{r.sceneError}</p>}{r?.renderError&&<p role="alert">{r.renderError}</p>}
      <p>Playback cursor: {r?.time_seconds??'unconfirmed'} · Rate: {r?.rate??1}×</p>
      <p>Snapshot time: {r?.snapshot?.simulation_time_seconds??'unconfirmed'} · Sequence: {r?.snapshot?.sequence??'unconfirmed'}</p>
      <p>Recorded vehicles: {r?.snapshot?.vehicles.length??'unconfirmed'}</p>
      <p>Selected: {r?.selectedVehicleId??'none'} · Tracked: {r?.trackedVehicleId??'none'}</p>
      {r?.gap&&<p role="status">No intermediate records: {r.gap.from}–{r.gap.to}</p>}
      <div className="fleet-controls">
        {r?.status==='PLAYING'||r?.status==='BUFFERING'?<button onClick={()=>p.controls?.pause()} disabled={!ready}>Pause</button>
          :<button onClick={()=>p.controls?.play()} disabled={!ready||r?.status==='ENDED'}>Play</button>}
        <label>Rate <select value={r?.rate??1} disabled={!ready} onChange={e=>p.controls?.setRate(Number(e.currentTarget.value))}>
          {[0.5,1,2,4].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label>
        <button onClick={()=>p.controls?.replay()} disabled={!p.controls||!r?.session||r.status==='LOADING'}>Replay from start</button>
      </div>
      <form onSubmit={submit}>
        <label>Seek simulation time <input name="time_seconds" type="number" step="any" required defaultValue={r?.session?.first_simulation_time??0}
          min={r?.session?.first_simulation_time??0} max={r?.session?.last_simulation_time??0} disabled={!ready}/></label>
        <button type="submit" disabled={!ready}>Seek</button>
      </form>
      <div className="fleet-controls">
        <button onClick={()=>p.controls?.locateSelected()} disabled={!selected||!ready}>Locate selected</button>
        <button onClick={()=>p.controls?.trackSelected()} disabled={!selected||r?.status!=='PLAYING'}>Track selected</button>
        <button onClick={()=>p.controls?.stopTracking()} disabled={!r?.trackedVehicleId}>Stop tracking</button>
        <button onClick={()=>p.controls?.select(null)} disabled={!selected}>Clear selection</button>
      </div>
      <ul aria-label="Recorded vehicles">{[...(r?.snapshot?.vehicles??[])].sort((a,b)=>a.vehicle_id.localeCompare(b.vehicle_id)).map(v=><li key={v.vehicle_id}>
        <button data-vehicle-id={v.vehicle_id} aria-pressed={v.vehicle_id===r?.selectedVehicleId} onClick={()=>p.controls?.select(v.vehicle_id)}>{v.vehicle_id}</button>
        {' '}{v.status} · {v.speed} km/h · SOC {v.soc}% · Load: {v.load}
      </li>)}</ul>
      <div aria-label="Historical selected vehicle details">{selected?<>
        <p>{selected.vehicle_id}: {selected.status}</p><p>Speed: {selected.speed} km/h · SOC: {selected.soc}% · Load: {selected.load}</p>
        <p>Longitude: {selected.longitude} · Latitude: {selected.latitude} · Ellipsoid height: {selected.height} m · Heading: {selected.heading}°</p>
        <p>Recorded UTC: {selected.timestamp}</p>
      </>:<p>No vehicle selected</p>}</div>
    </div>}
  </section>;
}