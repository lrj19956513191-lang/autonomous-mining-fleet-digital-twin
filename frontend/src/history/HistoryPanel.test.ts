import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect,test,vi } from 'vitest';
import { HistoryPanel, type HistoryPanelProps } from './HistoryPanel';
import type { SessionSummary } from './historyClient';
import type { ReplayViewModel } from './replayScene';
import { makeFleetSnapshotFixture } from '../realtime/fleetFixtures';
import { parseFleetSnapshot } from '../realtime/fleetTelemetry';
const SID='11111111-1111-4111-8111-111111111111';
function session(state:SessionSummary['state']='COMPLETED'):SessionSummary {
  const incomplete=state==='FAILED'||state==='INTERRUPTED';return {session_id:SID,state,started_utc:'2026-10-14T00:00:00Z',ended_utc:state==='RECORDING'?null:'2026-10-14T00:02:00Z',snapshot_count:121,first_sequence:0,last_sequence:120,first_simulation_time:0,last_simulation_time:120,incomplete,failure_code:incomplete?'WRITE_FAILED':null,failure_message:incomplete?'Recorded prefix':null};
}
function props():HistoryPanelProps {
  return {open:true,mode:'REPLAY',recording:null,recordingError:null,sessions:[session()],sessionsError:null,loading:false,nextCursor:null,
    replay:null,controls:null,modeError:null,onOpen:vi.fn(),onReturnLive:vi.fn(),onSelectSession:vi.fn(),onRefresh:vi.fn(),onLoadMore:vi.fn()};
}
function playback(status:ReplayViewModel['status']='PAUSED'):ReplayViewModel {
  return {session:{...session(),storage_version:1,fleet_schema_version:1,code_revision:null,scene_sha256:'b'.repeat(64),config_sha256:'c'.repeat(64),vehicle_configs:[]},
    snapshot:parseFleetSnapshot({...makeFleetSnapshotFixture(),sequence:10,simulation_time_seconds:10})!,status,time_seconds:10.5,rate:1,
    selectedVehicleId:'TRUCK_002',trackedVehicleId:'TRUCK_001',sceneState:'READY',sceneError:null,renderError:null,incomplete:false,gap:{from:10,to:13}};
}
function elements(node:ReactNode):ReactElement<Record<string,unknown>>[] {
  if(Array.isArray(node))return node.flatMap(elements);if(!isValidElement(node))return [];
  const e=node as ReactElement<Record<string,unknown>>;return [e,...elements(e.props.children as ReactNode)];
}
function byText(tree:ReactNode,text:string){return elements(tree).find(e=>e.type==='button'&&e.props.children===text)!;}

test('terminal_sessions_and_incomplete',()=>{
  for(const state of ['RECORDING','COMPLETED','FAILED','INTERRUPTED'] as const){const p={...props(),sessions:[session(state)]};
    const tree=HistoryPanel(p);const markup=renderToStaticMarkup(tree);expect(markup).toContain(state);expect(markup).toContain('121');
    const button=elements(tree).find(e=>e.type==='button'&&e.props['data-session-id']===SID)!;
    expect(button.props.disabled).toBe(state==='RECORDING');if(state!=='RECORDING')(button.props.onClick as ()=>void)();
    expect(p.onSelectSession).toHaveBeenCalledTimes(state==='RECORDING'?0:1);
    if(state==='FAILED'||state==='INTERRUPTED')expect(markup).toContain('Incomplete');
  }
});

test('replay_has_no_online_or_live_label',()=>{
  const markup=renderToStaticMarkup(createElement(HistoryPanel,{...props(),replay:playback()}));
  expect(markup).toContain('Historical playback');expect(markup).toContain('Playback cursor: 10.5');expect(markup).toContain('Snapshot time: 10');expect(markup).toContain('Sequence: 10');
  expect(markup).toContain('Selected: TRUCK_002');expect(markup).toContain('Tracked: TRUCK_001');expect(markup).toContain('10');expect(markup).toContain('13');
  expect(markup).not.toContain('Online:');expect(markup).not.toContain('Connection:');expect(markup).not.toContain('LIVE');
});

test('controls_play_pause_rate_seek_end_replay_without_second_clock',()=>{
  const controls={play:vi.fn(),pause:vi.fn(),setRate:vi.fn(),seek:vi.fn(),replay:vi.fn(),select:vi.fn(),locateSelected:vi.fn(),trackSelected:vi.fn(),stopTracking:vi.fn(),destroy:vi.fn()};
  const p={...props(),replay:playback('PLAYING'),controls};const tree=HistoryPanel(p);
  for(const text of ['Pause','Locate selected','Track selected','Stop tracking','Replay from start']) (byText(tree,text).props.onClick as ()=>void)();
  expect(controls.pause).toHaveBeenCalledTimes(1);expect(controls.locateSelected).toHaveBeenCalledTimes(1);expect(controls.trackSelected).toHaveBeenCalledTimes(1);expect(controls.stopTracking).toHaveBeenCalledTimes(1);expect(controls.replay).toHaveBeenCalledTimes(1);
  const rate=elements(tree).find(e=>e.type==='select')!;(rate.props.onChange as (e:unknown)=>void)({currentTarget:{value:'4'}});expect(controls.setRate).toHaveBeenCalledWith(4);
  const form=elements(tree).find(e=>e.type==='form')!;(form.props.onSubmit as (e:unknown)=>void)({preventDefault(){},currentTarget:{elements:{namedItem:()=>({value:'45.5'})}}});expect(controls.seek).toHaveBeenCalledWith(45.5);
  const vehicle=elements(tree).find(e=>e.props['data-vehicle-id']==='TRUCK_003'&&e.type==='button')!;(vehicle.props.onClick as ()=>void)();expect(controls.select).toHaveBeenCalledWith('TRUCK_003');
  const paused=HistoryPanel({...p,replay:playback()});(byText(paused,'Play').props.onClick as ()=>void)();expect(controls.play).toHaveBeenCalledTimes(1);
  expect(controls.destroy).not.toHaveBeenCalled();
});

test('recording_disabled_errors_empty_list_and_recorded_prefix_are_explicit',()=>{
  const p={...props(),recording:{enabled:false,state:'DISABLED_CONFIG' as const,session_id:null,last_offered_sequence:null,last_persisted_sequence:null,error_code:'INVALID_CONFIG',error_message:'Configuration required'},sessionsError:'HTTP 503',sessions:[]};
  let markup=renderToStaticMarkup(createElement(HistoryPanel,p));expect(markup).toContain('DISABLED_CONFIG');expect(markup).toContain('Configuration required');expect(markup).toContain('HTTP 503');expect(markup).not.toContain('No recorded sessions');
  markup=renderToStaticMarkup(createElement(HistoryPanel,{...props(),replay:{...playback(),incomplete:true,session:{...playback().session!,...session('FAILED')}}}));expect(markup).toContain('Incomplete');expect(markup).toContain('Recorded prefix');
});