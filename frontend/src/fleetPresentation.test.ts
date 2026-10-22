import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Cartesian3, Entity, EntityCollection, Event as CesiumEvent, JulianDate,
  PerspectiveFrustum, PointVisualizer, ScreenSpaceEventType, type Viewer } from 'cesium';
import { createFleetPresentation, FleetPresentationError, type FleetPresentationModel } from './fleetPresentation';
import { createViewer, type ViewerHandle } from './cesium/viewer';
import { focusVehicle } from './cesium/camera';
import { makeFleetSnapshotFixture } from './realtime/fleetFixtures';
import { createFleetSnapshotGate, parseFleetSnapshot } from './realtime/fleetTelemetry';
import { parseMineScene } from './scene/sceneClient';
import { makeSceneInput } from './scene/sceneFixtures';

vi.mock('./cesium/viewer',()=>({createViewer:vi.fn()}));
vi.mock('./cesium/camera',()=>({focusVehicle:vi.fn()}));
const container={} as HTMLElement;
const time=JulianDate.fromIso8601('2026-10-14T04:00:00Z');
function packet(sequence = 0, ids = ['TRUCK_001', 'TRUCK_002', 'TRUCK_003']) {
  const wire = makeFleetSnapshotFixture();
  wire.sequence = sequence; wire.simulation_time_seconds = sequence;
  wire.vehicles = wire.vehicles.filter(vehicle => ids.includes(vehicle.vehicle_id));
  wire.vehicles.forEach(vehicle => { vehicle.longitude += sequence * 0.0001; });
  const parsed = parseFleetSnapshot(wire);
  if (!parsed) throw new Error('Invalid test DTO');
  return parsed;
}
function makeViewer() {
  let dead = false;
  let tracked: Entity | undefined;
  const actions = new Map<number, unknown>();
  const trackedEntityChanged = new CesiumEvent();
  const camera = {
    positionWC: new Cartesian3(6378137, 400, 1000),
    directionWC: new Cartesian3(-1, 0, 0), upWC: new Cartesian3(0, 0, 1),
    frustum: new PerspectiveFrustum({ fov: 0.9, aspectRatio: 1.6, near: 2, far: 200000 }),
    setView: vi.fn<Viewer['camera']['setView']>(options => {
      if (options?.destination instanceof Cartesian3) Cartesian3.clone(options.destination, camera.positionWC);
      if (options?.orientation && 'direction' in options.orientation) {
        Cartesian3.clone(options.orientation.direction!, camera.directionWC);
        Cartesian3.clone(options.orientation.up!, camera.upWC);
      }
    }),
  };
  const input = { getInputAction: vi.fn((type: number) => actions.get(type)),
    setInputAction: vi.fn((action: unknown, type: number) => { actions.set(type, action); }),
    removeInputAction: vi.fn((type: number) => { actions.delete(type); }) };
  const viewer = { entities: new EntityCollection(), camera, trackedEntityChanged,
    screenSpaceEventHandler: input, scene: { pick: vi.fn() }, isDestroyed: () => dead,
    get trackedEntity() { return tracked; },
    set trackedEntity(value: Entity | undefined) { tracked = value; trackedEntityChanged.raiseEvent(value); },
  } as unknown as Viewer;
  const handle: ViewerHandle = { viewer, destroy: vi.fn(() => { dead = true; }) };
  return { viewer, handle, camera, input, actions };
}
let f:ReturnType<typeof makeViewer>;
let models:FleetPresentationModel[];
let fatals:Error[];
let diagnostics:Error[];
const latest=()=>models.at(-1)!;
function start(onModel?:(model:FleetPresentationModel)=>void,onFatal?:(error:Error)=>void){
  return createFleetPresentation(container,{
    onModel(model){models.push(model);onModel?.(model);},
    onFatal(error){fatals.push(error);onFatal?.(error);},
    onCleanupError(error){diagnostics.push(error);},
  });
}
function scene(){const parsed=parseMineScene(makeSceneInput());if(!parsed)throw new Error('bad fixture');return parsed;}
beforeEach(()=>{vi.resetAllMocks();f=makeViewer();models=[];fatals=[];diagnostics=[];vi.mocked(createViewer).mockReturnValue(f.handle);});
afterEach(()=>vi.restoreAllMocks());

test('presentation_applies_valid_snapshot_and_owns_resources',()=>{
  const handle=start();
  expect(Object.keys(latest()).sort()).toEqual(['snapshot','selectedVehicleId','trackedVehicleId','sceneState','sceneError','renderError','fatal'].sort());
  expect(latest().snapshot).toBeNull();expect(latest().sceneState).toBe('LOADING');
  handle.renderScene(scene());
  expect(handle.applySnapshot(packet(10))).toBe(true);
  expect(f.viewer.entities.values).toHaveLength(16);
  const entity=f.viewer.entities.getById('TRUCK_001')!;const position=entity.position;
  expect(handle.applySnapshot(packet(5))).toBe(true);
  expect(latest().snapshot?.sequence).toBe(5);
  expect(f.viewer.entities.getById(entity.id)).toBe(entity);expect(entity.position).toBe(position);
  expect(entity.position!.getValue(time)).toEqual(Cartesian3.fromDegrees(116.0005,39,50));
  const gate=createFleetSnapshotGate();expect(gate.accept(packet(10))).toBe(true);expect(gate.accept(packet(5))).toBe(false);
  expect(focusVehicle).toHaveBeenCalledTimes(1);
  handle.destroy();expect(f.viewer.isDestroyed()).toBe(true);expect(f.viewer.entities.values).toEqual([]);
});
test.each(['before','after'] as const)('dynamic_notification_fatal_closes_before_callbacks_%s_visualizer',order=>{
  let armed=false;let failed=false;let handle:ReturnType<typeof start>;
  const listen=()=>f.viewer.entities.collectionChanged.addEventListener((_c,added,removed)=>{
    if(!armed||failed||![...added,...removed].some(e=>e.id==='TRUCK_001'))return;
    failed=true;expect(handle.applySnapshot(packet(99))).toBe(false);throw new Error('PUBLIC_DYNAMIC_NOTIFY');
  });
  let remove=order==='before'?listen():()=>{};
  const points=new Map<Entity,{id:Entity}>();
  const visualizer=new PointVisualizer({getPoint(entity:Entity){const p={id:entity};points.set(entity,p);return p;},
    removePoint(entity:Entity){points.delete(entity);},removeBillboard(){}} as unknown as ConstructorParameters<typeof PointVisualizer>[0],f.viewer.entities);
  if(order==='after')remove=listen();
  const destroy=f.handle.destroy;f.handle.destroy=vi.fn(()=>{visualizer.destroy();points.clear();destroy();});
  let gateClosed=false;
  handle=start(model=>{if(model.fatal){expect(gateClosed).toBe(true);expect(handle.applySnapshot(packet(101))).toBe(false);}},()=>{
    gateClosed=true;expect(handle.applySnapshot(packet(100))).toBe(false);
    handle.trackSelected();handle.renderScene(scene());
  });
  handle.renderScene(scene());handle.setSourceAvailable(true);handle.applySnapshot(packet());visualizer.update(time);
  expect(points.size).toBe(3);const previous=latest().snapshot;
  armed=true;expect(handle.applySnapshot(packet(1,['TRUCK_002','TRUCK_003']))).toBe(false);
  expect(failed).toBe(true);expect(latest().fatal).toBe(true);expect(latest().snapshot).toBe(previous);
  expect(f.viewer.isDestroyed()).toBe(true);expect(f.viewer.entities.values).toEqual([]);expect(points.size).toBe(0);
  const count=models.length;remove();handle.applySnapshot(packet(102));handle.destroy();expect(models).toHaveLength(count);
});

test.each(['before','after'].flatMap(order=>['scene-first','fleet-first'].map(arrival=>({order,arrival}))))(
  'static_notification_fatal_$order_visualizer_$arrival',({order,arrival})=>{
    let failed=false;let handle:ReturnType<typeof start>;
    const listen=()=>f.viewer.entities.collectionChanged.addEventListener((_c,added)=>{
      if(failed||!added.some(e=>e.id.startsWith('scene:')))return;
      failed=true;expect(handle.applySnapshot(packet(50))).toBe(false);throw new Error('PUBLIC_STATIC_NOTIFY');
    });
    let remove=order==='before'?listen():()=>{};
    const points=new Map<Entity,{id:Entity}>();
    const visualizer=new PointVisualizer({getPoint(entity:Entity){const p={id:entity};points.set(entity,p);return p;},
      removePoint(entity:Entity){points.delete(entity);},removeBillboard(){}} as unknown as ConstructorParameters<typeof PointVisualizer>[0],f.viewer.entities);
    if(order==='after')remove=listen();
    const destroy=f.handle.destroy;f.handle.destroy=vi.fn(()=>{visualizer.destroy();points.clear();destroy();});
    handle=start(undefined,()=>{expect(handle.applySnapshot(packet(51))).toBe(false);});
    if(arrival==='fleet-first')handle.applySnapshot(packet());
    visualizer.update(time);expect(points.size).toBe(arrival==='fleet-first'?3:0);
    const previous=latest().snapshot;
    let thrown:unknown;try{handle.renderScene(scene());}catch(error){thrown=error;}
    expect(thrown).toBeInstanceOf(FleetPresentationError);expect((thrown as FleetPresentationError).fatal).toBe(true);
    expect(failed).toBe(true);expect(latest().fatal).toBe(true);expect(latest().sceneState).toBe('ERROR');
    expect(latest().renderError).toContain('PUBLIC_STATIC_NOTIFY');expect(latest().snapshot).toBe(previous);
    expect(f.viewer.isDestroyed()).toBe(true);expect(f.viewer.entities.values).toEqual([]);expect(points.size).toBe(0);
    const count=models.length;remove();handle.applySnapshot(packet(52));handle.destroy();expect(models).toHaveLength(count);
  });

test('scene_preparation_error_is_typed_nonfatal_and_does_not_consume_snapshot',()=>{
  const handle=start();handle.applySnapshot(packet());
  const vehicle=f.viewer.entities.getById('TRUCK_001')!;const position=vehicle.position;
  const external=f.viewer.entities.add(new Entity({id:'scene:DEMO_MINE:ROAD_009'}));
  let thrown:unknown;try{handle.renderScene(scene());}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(FleetPresentationError);expect((thrown as FleetPresentationError).fatal).toBe(false);
  expect(latest().sceneState).toBe('ERROR');expect(latest().renderError).toBeNull();expect(latest().fatal).toBe(false);
  expect(handle.applySnapshot(packet(1))).toBe(true);expect(f.viewer.entities.getById(vehicle.id)).toBe(vehicle);
  expect(vehicle.position).toBe(position);expect(fatals).toEqual([]);
  handle.destroy();expect(f.viewer.entities.values).toEqual([external]);
});

test('source_availability_controls_tracking_without_connection_fields_and_preserves_view',()=>{
  const handle=start();handle.applySnapshot(packet());handle.trackSelected();expect(latest().trackedVehicleId).toBeNull();
  handle.setSourceAvailable(true);handle.trackSelected();expect(latest().trackedVehicleId).toBe('TRUCK_001');
  handle.select('TRUCK_002');expect(latest().trackedVehicleId).toBe('TRUCK_001');
  const position=Cartesian3.clone(f.camera.positionWC);const direction=Cartesian3.clone(f.camera.directionWC);
  const frustum=f.camera.frustum.clone();handle.setSourceAvailable(false);
  expect(latest().trackedVehicleId).toBeNull();expect(latest().selectedVehicleId).toBe('TRUCK_002');
  expect(f.camera.positionWC).toEqual(position);expect(f.camera.directionWC).toEqual(direction);expect(f.camera.frustum.equals(frustum)).toBe(true);
  handle.trackSelected();expect(latest().trackedVehicleId).toBeNull();handle.locateSelected();
  expect(focusVehicle).toHaveBeenCalledTimes(2);expect(latest().trackedVehicleId).toBeNull();handle.destroy();
});

test('external_same_id_and_input_actions_are_not_adopted_or_removed',()=>{
  const externalAction=()=>{};f.actions.set(ScreenSpaceEventType.LEFT_DOUBLE_CLICK,externalAction);
  const handle=start();handle.applySnapshot(packet());
  expect(f.actions.get(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)).not.toBe(externalAction);
  const old=f.viewer.entities.getById('TRUCK_001')!;f.viewer.entities.remove(old);
  const external=f.viewer.entities.add(new Entity({id:old.id}));handle.select(old.id);expect(latest().selectedVehicleId).toBeNull();
  const replacement=()=>{};f.actions.set(ScreenSpaceEventType.LEFT_CLICK,replacement);
  handle.destroy();expect(f.viewer.entities.getById(old.id)).toBe(external);
  expect(f.actions.get(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)).toBe(externalAction);
  expect(f.actions.get(ScreenSpaceEventType.LEFT_CLICK)).toBe(replacement);
});

test('fatal_callback_errors_still_notify_terminal_model_and_release_every_resource',()=>{
  const handle=start(model=>{if(model.fatal)throw new Error('TERMINAL_MODEL_CALLBACK');},()=>{throw new Error('FATAL_CALLBACK');});
  handle.applySnapshot(packet());
  const entity=f.viewer.entities.getById('TRUCK_001')!;
  entity.definitionChanged.addEventListener(()=>{throw new Error('PUBLIC_PROPERTY_NOTIFY');});
  expect(handle.applySnapshot(packet(1))).toBe(false);
  expect(latest().fatal).toBe(true);expect(f.viewer.isDestroyed()).toBe(true);expect(f.viewer.entities.values).toEqual([]);
  expect(f.actions.has(ScreenSpaceEventType.LEFT_CLICK)).toBe(false);
  const errors=diagnostics.flatMap(error=>error instanceof AggregateError?error.errors:[]);
  expect(errors.some(error=>error.message==='FATAL_CALLBACK')).toBe(true);
  expect(errors.some(error=>error.message==='TERMINAL_MODEL_CALLBACK')).toBe(true);
  handle.destroy();
});

test('publication_camera_failure_is_local_fatal_not_an_escaped_consumer_exception',async()=>{
  const module=await import('./cesium/fleetCamera');const real=module.createFleetCamera;
  let armed=false;
  vi.spyOn(module,'createFleetCamera').mockImplementation((...args)=>{
    const camera=real(...args);return {...camera,getTrackedVehicleId(){if(armed)throw new Error('PUBLICATION_CAMERA_FAILURE');return camera.getTrackedVehicleId();}};
  });
  const handle=start();handle.applySnapshot(packet());
  f.viewer.entities.getById('TRUCK_002')!.definitionChanged.addEventListener(()=>{armed=true;});
  let result:boolean|undefined;
  expect(()=>{result=handle.applySnapshot(packet(1));}).not.toThrow();
  expect(result).toBe(false);
  expect(latest().fatal).toBe(true);expect(fatals).toHaveLength(1);expect(f.viewer.isDestroyed()).toBe(true);
});

test('cleanup_attempts_multiple_failures_and_retries_only_unreleased_resources',async()=>{
  const cameraModule=await import('./cesium/fleetCamera');const entityModule=await import('./vehicle/fleetEntities');
  const realCamera=cameraModule.createFleetCamera;const realEntities=entityModule.createFleetEntities;
  let cameraFirst=true;let fleetFirst=true;
  const cameraRelease=vi.fn();const fleetRelease=vi.fn();
  vi.spyOn(cameraModule,'createFleetCamera').mockImplementation((...args)=>{
    const value=realCamera(...args);return {...value,destroy(){cameraRelease();if(cameraFirst){cameraFirst=false;throw new Error('CAMERA_RELEASE');}value.destroy();}};
  });
  vi.spyOn(entityModule,'createFleetEntities').mockImplementation((...args)=>{
    const value=realEntities(...args);return {...value,destroy(){fleetRelease();if(fleetFirst){fleetFirst=false;throw new Error('FLEET_RELEASE');}value.destroy();}};
  });
  const handle=start();handle.renderScene(scene());handle.applySnapshot(packet());handle.destroy();
  expect(f.viewer.isDestroyed()).toBe(true);expect(diagnostics).toHaveLength(1);
  expect((diagnostics[0] as AggregateError).errors).toHaveLength(2);
  expect(f.actions.has(ScreenSpaceEventType.LEFT_CLICK)).toBe(false);
  handle.destroy();expect(f.viewer.entities.values).toEqual([]);expect(cameraRelease).toHaveBeenCalledTimes(2);expect(fleetRelease).toHaveBeenCalledTimes(2);
  handle.destroy();expect(f.handle.destroy).toHaveBeenCalledTimes(1);
});

test('strictmode_setup_cleanup_setup_ignores_old_actions_and_snapshot',()=>{
  const first=start();first.applySnapshot(packet());const old=f;
  const click=old.actions.get(ScreenSpaceEventType.LEFT_CLICK) as (event:unknown)=>void;first.destroy();
  f=makeViewer();vi.mocked(createViewer).mockReturnValue(f.handle);const second=start();second.renderScene(scene());second.applySnapshot(packet());
  const count=models.length;expect(first.applySnapshot(packet(1))).toBe(false);click({position:{x:0,y:0}});first.destroy();
  expect(models).toHaveLength(count);expect(f.viewer.entities.values).toHaveLength(16);expect(old.viewer.isDestroyed()).toBe(true);
  second.destroy();
});
test('render_scene_reports_fatal_typed_error_when_terminal_publication_fails',()=>{
  const handle=start(model=>{if(model.sceneState==='READY'&&!model.fatal)throw new Error('SCENE_MODEL_CONSUMER_FAILED');});
  let thrown:unknown;try{handle.renderScene(scene());}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(FleetPresentationError);
  expect((thrown as FleetPresentationError).fatal).toBe(true);
  expect(latest().fatal).toBe(true);expect(latest().renderError).toContain('SCENE_MODEL_CONSUMER_FAILED');
  expect(f.viewer.isDestroyed()).toBe(true);expect(f.viewer.entities.values).toEqual([]);
});
test('render_scene_keeps_typed_fatal_contract_when_diagnostic_consumer_throws',()=>{
  let fired=false;
  const stop=f.viewer.entities.collectionChanged.addEventListener((_c,added)=>{
    if(!fired&&added.some(entity=>entity.id.startsWith('scene:'))){fired=true;throw new Error('PUBLIC_STATIC_ROOT');}
  });
  const handle=createFleetPresentation(container,{
    onModel(model){models.push(model);},
    onFatal(){throw new Error('FATAL_CALLBACK_SECONDARY');},
    onCleanupError(error){diagnostics.push(error);throw new Error('CLEANUP_CONSUMER_SECONDARY');},
  });
  let thrown:unknown;try{handle.renderScene(scene());}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(FleetPresentationError);expect((thrown as FleetPresentationError).fatal).toBe(true);
  expect(latest().fatal).toBe(true);expect(latest().renderError).toContain('PUBLIC_STATIC_ROOT');
  expect(diagnostics).toHaveLength(1);expect(f.viewer.isDestroyed()).toBe(true);
  expect(f.viewer.entities.values).toEqual([]);expect(f.actions.has(ScreenSpaceEventType.LEFT_CLICK)).toBe(false);
  const cause=(thrown as Error).cause as AggregateError;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause.errors.some((error:Error)=>error.message.includes('PUBLIC_STATIC_ROOT'))).toBe(true);
  expect(cause.errors.some((error:Error)=>error.message==='CLEANUP_CONSUMER_SECONDARY')).toBe(true);
  const count=models.length;expect(handle.applySnapshot(packet(99))).toBe(false);stop();handle.destroy();expect(models).toHaveLength(count);
});