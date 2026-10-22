import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import App, { FleetPanel } from './App';
import { HistoryPanel, type HistoryPanelProps } from './history/HistoryPanel';
import type { FleetViewModel } from './fleetScene';
import { parseFleetSnapshot } from './realtime/fleetTelemetry';
import { makeFleetSnapshotFixture } from './realtime/fleetFixtures';
function live(): FleetViewModel {
  const wire=makeFleetSnapshotFixture(); wire.vehicles[0].speed=24.987; wire.vehicles[0].soc=79.9995;
  return {snapshot:parseFleetSnapshot(wire)!,selectedVehicleId:'TRUCK_001',trackedVehicleId:'TRUCK_002',sceneState:'READY',connectionState:'LIVE',sceneError:null,renderError:null,dataStale:false,currentConnectionConfirmed:true};
}
function history():HistoryPanelProps {
  const session={session_id:'11111111-1111-4111-8111-111111111111',state:'COMPLETED' as const,started_utc:'2026-10-14T00:00:00Z',ended_utc:'2026-10-14T00:02:00Z',snapshot_count:121,first_sequence:0 as const,last_sequence:120,first_simulation_time:0 as const,last_simulation_time:120,incomplete:false,failure_code:null,failure_message:null};
  return {open:true,mode:'REPLAY',sessions:[session],recording:null,recordingError:null,sessionsError:null,loading:false,nextCursor:null,modeError:null,
    replay:{snapshot:live().snapshot,session:{...session,storage_version:1,fleet_schema_version:1,code_revision:null,scene_sha256:'a'.repeat(64),config_sha256:'b'.repeat(64),vehicle_configs:[]},selectedVehicleId:'TRUCK_001',trackedVehicleId:null,status:'BUFFERING',time_seconds:10.5,rate:2,sceneState:'READY',sceneError:null,renderError:null,incomplete:false,gap:{from:10,to:13}},
    controls:{play:vi.fn(),pause:vi.fn(),setRate:vi.fn(),seek:vi.fn(),replay:vi.fn(),select:vi.fn(),locateSelected:vi.fn(),trackSelected:vi.fn(),stopTracking:vi.fn(),destroy:vi.fn()},
    onOpen:vi.fn(),onReturnLive:vi.fn(),onSelectSession:vi.fn(),onRefresh:vi.fn(),onLoadMore:vi.fn()};
}
test('console navigation and native keyboard collapse keep a persistent scene slot',()=>{
  const html=renderToStaticMarkup(<App/>);
  expect(html).toContain('aria-label="Console navigation"');expect(html).toContain('<summary');
  expect(html).toContain('aria-label="Fleet workspace"');expect(html).toContain('id="cesium-container"');
});
test('display rounding does not mutate committed telemetry',()=>{
  const model=live(),before=JSON.stringify(model.snapshot);
  const html=renderToStaticMarkup(<FleetPanel model={model} controls={null}/>);
  expect(html).toContain('25.0');expect(html).toContain('80.0%');expect(html).toContain('116.000000');
  expect(JSON.stringify(model.snapshot)).toBe(before);
  expect(model.snapshot!.vehicles[0].speed).toBe(24.987);expect(model.snapshot!.vehicles[0].soc).toBe(79.9995);
});
test('SOC meters expose real values and vehicle-specific accessible labels',()=>{
  const html=renderToStaticMarkup(<FleetPanel model={live()} controls={null}/>);
  expect(html).toMatch(/<meter[^>]*aria-label="TRUCK_001 SOC"[^>]*value="79.9995"/);
});
test('stale counts and tracked identity remain explicit',()=>{
  const model={...live(),connectionState:'CLOSED' as const,dataStale:true,currentConnectionConfirmed:false};
  const html=renderToStaticMarkup(<FleetPanel model={model} controls={null}/>);
  for(const text of ['Online: 0','Selected: TRUCK_001','Tracked: TRUCK_002','Last received data is stale'])expect(html).toContain(text);
  expect(html).toMatch(/disabled=""[^>]*>Track selected/);
});
test('loaded historical session has a pressed selection state',()=>{
  const html=renderToStaticMarkup(<HistoryPanel {...history()}/>);
  expect(html).toMatch(/<button[^>]*data-session-id="11111111-1111-4111-8111-111111111111"[^>]*aria-pressed="true"/);
});
test('buffering and gaps do not conflate cursor with snapshot time',()=>{
  const p=history();const html=renderToStaticMarkup(<HistoryPanel {...p}/>);
  for(const text of ['BUFFERING','Playback time is frozen','Playback cursor: 10.5','Snapshot time: '+p.replay!.snapshot!.simulation_time_seconds,'No intermediate records: 10–13','aria-label="Playback controls"'])expect(html).toContain(text);
});
test('release errors stay visible and block returning live',()=>{
  const html=renderToStaticMarkup(<HistoryPanel {...history()} mode="ERROR" modeError="Release unconfirmed"/>);
  expect(html).toContain('role="alert"');expect(html).toContain('Release unconfirmed');expect(html).toMatch(/disabled=""[^>]*>Return to realtime/);
});
test('recording failures stay distinct from loaded historical data',()=>{
  const p=history();const html=renderToStaticMarkup(<HistoryPanel {...p} recording={{enabled:true,state:'FAILED',session_id:p.sessions[0].session_id,last_offered_sequence:5,last_persisted_sequence:4,error_code:'WRITE_FAILED',error_message:'Recording stopped; live simulation continues'}}/>);
  for(const text of ['WRITE_FAILED','Recording stopped; live simulation continues','Historical playback'])expect(html).toContain(text);
});

test('unconfirmed startup is never labelled as live telemetry',()=>{
  const html=renderToStaticMarkup(<App/>);
  expect(html).not.toContain('>LIVE TELEMETRY<');
  expect(html).toContain('WAITING FOR CONFIRMED DATA');
});
test('session catalogue describes availability without pretending active sessions are absent',()=>{
  const p=history();
  const html=renderToStaticMarkup(<HistoryPanel {...p} sessions={[{...p.sessions[0],state:'RECORDING',ended_utc:null}]}/>);
  expect(html).toContain('Select a finished session');expect(html).toContain('RECORDING');
  expect(html).toMatch(/data-session-id="[^"]+"[^>]*disabled=""/);
});
