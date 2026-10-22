import { afterEach, expect, test, vi } from 'vitest';
import { Cartesian2, Color, Entity, EntityCollection, Event, JulianDate, ScreenSpaceEventType, type Viewer } from 'cesium';
import { makeFleetSnapshotFixture } from '../realtime/fleetFixtures';
import { parseFleetSnapshot } from '../realtime/fleetTelemetry';
import { createFleetEntities } from './fleetEntities';
import { createFleetInteraction, type FleetInteractionCallbacks } from './fleetInteraction';

const clickType = ScreenSpaceEventType.LEFT_CLICK;
const doubleClickType = ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
const time = JulianDate.fromIso8601('2026-10-14T04:00:00Z');
type Action = (event: { position: Cartesian2 }) => void;
afterEach(() => vi.restoreAllMocks());
function setup() {
  const entities = new EntityCollection();
  const fleet = createFleetEntities(entities, () => true);
  fleet.apply(parseFleetSnapshot(makeFleetSnapshotFixture())!, {
    capture: () => null, beforeRemove: () => {}, afterReconcile: () => {}, restore: () => {}, isActive: () => true,
  });
  const statik = entities.add(new Entity({ id: 'ROAD_001' }));
  let active = true;
  let dead = false;
  let picked: unknown;
  let tracked: Entity | undefined;
  const trackedEntityChanged = new Event();
  const actions = new Map<number, Action>();
  const handler = {
    getInputAction: (type: number) => actions.get(type),
    setInputAction: (action: Action, type: number) => { actions.set(type, action); },
    removeInputAction: (type: number) => { actions.delete(type); },
    destroy: vi.fn(),
  };
  const camera = { setView: vi.fn(), flyTo: vi.fn() };
  const viewer = {
    entities, screenSpaceEventHandler: handler, trackedEntityChanged, camera,
    scene: { pick: vi.fn(() => picked) }, isDestroyed: () => dead,
    get trackedEntity() { return tracked; },
    set trackedEntity(entity: Entity | undefined) { tracked = entity; trackedEntityChanged.raiseEvent(entity); },
  };
  const selections: (string | null)[] = [];
  const invalid: string[] = [];
  const callbacks: FleetInteractionCallbacks = {
    onSelect: id => { selections.push(id); fleet.setSelected(id); },
    onInvalidTarget: id => { invalid.push(id); }, isActive: () => active,
  };
  const create = () => createFleetInteraction(viewer as unknown as Viewer, fleet, callbacks);
  const fire = (type = clickType) => actions.get(type)?.({ position: new Cartesian2(5, 6) });
  return { entities, fleet, statik, handler, camera, viewer, callbacks, actions, selections, invalid, create, fire,
    pick: (value: unknown) => { picked = value; }, deactivate: () => { active = false; }, kill: () => { dead = true; } };
}
// Catches map/list divergence, unauthorized ownership and selection moving the camera.
test('selection list_and_map_selection_are_same_action_without_camera_motion', () => {
  const s = setup();
  const h = s.create();
  const one = s.fleet.getOwnedEntity('TRUCK_001')!;
  const two = s.fleet.getOwnedEntity('TRUCK_002')!;
  s.viewer.trackedEntity = one;
  h.select(one.id);
  expect(s.selections).toEqual(['TRUCK_001']);
  expect(one.point!.outlineColor!.getValue(time)).toEqual(Color.CYAN);
  expect(one.point!.outlineWidth!.getValue(time)).toBe(3);
  s.pick({ id: two }); s.fire();
  expect(s.selections).toEqual(['TRUCK_001', 'TRUCK_002']);
  expect(one.point!.outlineColor!.getValue(time)).toEqual(Color.BLACK);
  expect(one.point!.outlineWidth!.getValue(time)).toBe(2);
  expect(two.point!.outlineColor!.getValue(time)).toEqual(Color.CYAN);
  expect(two.point!.outlineWidth!.getValue(time)).toBe(3);
  s.pick({ id: s.statik }); s.fire();
  s.pick({ id: new Entity({ id: two.id }) }); s.fire();
  s.pick({ id: two.id }); s.fire();
  h.select('ROAD_001'); h.select('MISSING');
  expect(s.selections).toEqual(['TRUCK_001', 'TRUCK_002']);
  s.pick(undefined); s.fire();
  expect(s.selections).toEqual(['TRUCK_001', 'TRUCK_002', null]);
  expect(two.point!.outlineColor!.getValue(time)).toEqual(Color.BLACK);
  expect(two.point!.outlineWidth!.getValue(time)).toBe(2);
  expect(s.viewer.trackedEntity).toBe(one);
  expect(s.camera.setView).not.toHaveBeenCalled();
  expect(s.camera.flyTo).not.toHaveBeenCalled();
  h.destroy();
});
// Catches use of ID alone, plus callbacks surviving an ended lifecycle or Viewer.
test('selection rejects_external_same_id_and_late_input', () => {
  const s = setup(); const h = s.create();
  const old = s.fleet.getOwnedEntity('TRUCK_001')!;
  s.entities.remove(old);
  const external = s.entities.add(new Entity({ id: old.id }));
  h.select(old.id); s.pick({ id: external }); s.fire();
  expect(s.selections).toEqual([]);
  s.deactivate(); h.select('TRUCK_002'); s.pick(undefined); s.fire();
  expect(s.selections).toEqual([]);
  h.destroy();
  const t = setup(); const other = t.create();
  const late = t.actions.get(clickType);
  expect(late).toBeTypeOf('function');
  t.kill(); other.select(null); late?.({ position: new Cartesian2() });
  expect(t.selections).toEqual([]);
  other.destroy();
});

// Catches Cesium's implicit follow and restoring over a later input owner.
test('double_click default_double_click_is_disabled_and_owned_actions_restore', () => {
  const s = setup();
  const originalClick: Action = () => { s.selections.push('native'); };
  const originalDoubleClick: Action = () => { s.viewer.trackedEntity = s.fleet.getOwnedEntity('TRUCK_001'); };
  s.actions.set(clickType, originalClick); s.actions.set(doubleClickType, originalDoubleClick);
  const h = s.create();
  const lateClick = s.actions.get(clickType)!;
  for (const target of [s.fleet.getOwnedEntity('TRUCK_001'), s.statik]) {
    s.pick({ id: target }); s.fire(doubleClickType);
    expect(s.viewer.trackedEntity).toBeUndefined();
  }
  expect(s.selections).toEqual([]);
  const externalAction: Action = () => {};
  s.handler.setInputAction(externalAction, clickType);
  h.destroy(); h.destroy();
  expect(s.handler.getInputAction(doubleClickType)).toBe(originalDoubleClick);
  expect(s.handler.getInputAction(clickType)).toBe(externalAction);
  lateClick({ position: new Cartesian2() });
  expect(s.selections).toEqual([]);
  expect(s.handler.destroy).not.toHaveBeenCalled();
});
// Catches unconditional restore/removal and leaking a native-free setup after cleanup.
test('double_click restores_absent_and_present_handlers_by_ownership', () => {
  const s = setup(); const original: Action = () => {};
  s.actions.set(clickType, original);
  const h = s.create(); h.destroy();
  expect(s.actions.get(clickType)).toBe(original);
  expect(s.actions.has(doubleClickType)).toBe(false);
  const other = s.create(); const external: Action = () => {};
  s.actions.set(doubleClickType, external); other.destroy();
  expect(s.actions.get(doubleClickType)).toBe(external);
  expect(s.actions.get(clickType)).toBe(original);
});
// Catches stale entity identity retaining selection/follow, without owning camera mechanics here.
test('cleanup target_replacement_batch_and_strictmode_cleanup', () => {
  const s = setup(); const h = s.create();
  let selected: string | null = 'TRUCK_001';
  const one = s.fleet.getOwnedEntity(selected)!;
  s.viewer.trackedEntity = one;
  s.callbacks.onInvalidTarget = id => {
    s.invalid.push(id);
    if (selected === id) selected = null;
    if (s.viewer.trackedEntity?.id === id) s.viewer.trackedEntity = undefined;
  };
  s.entities.remove(one);
  expect(s.invalid).toEqual(['TRUCK_001']);
  expect(selected).toBeNull(); expect(s.viewer.trackedEntity).toBeUndefined();
  const external = s.entities.add(new Entity({ id: one.id }));
  h.select(external.id); s.pick({ id: external }); s.fire();
  expect(s.selections).toEqual([]);
  expect(s.entities.getById(one.id)).toBe(external);
  h.destroy(); h.destroy();
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(0);
  const again = s.create();
  expect(s.entities.collectionChanged.numberOfListeners).toBe(1);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(1);
  again.select('TRUCK_002'); expect(s.selections).toEqual(['TRUCK_002']);
  again.destroy();
  expect(s.actions.size).toBe(0);
  expect(s.handler.destroy).not.toHaveBeenCalled();
});
// Catches transient remove/re-add publishing UI and nested/idempotent batch ends flushing early.
test('cleanup batches_recheck_final_identity_without_transient_UI_reentry', () => {
  const s = setup(); const h = s.create();
  const one = s.fleet.getOwnedEntity('TRUCK_001')!;
  const outer = h.beginBatch(); const inner = h.beginBatch();
  s.entities.remove(one); s.entities.add(one);
  s.viewer.trackedEntity = new Entity({ id: one.id }); s.viewer.trackedEntity = one;
  expect(s.invalid).toEqual([]);
  inner(); inner(); expect(s.invalid).toEqual([]);
  outer(); outer(); expect(s.invalid).toEqual([]);
  const end = h.beginBatch(); s.entities.remove(one);
  const replacement = s.entities.add(new Entity({ id: one.id }));
  expect(s.invalid).toEqual([]);
  end(); end(); expect(s.invalid).toEqual(['TRUCK_001']);
  expect(s.entities.getById(one.id)).toBe(replacement);
  h.destroy();
});
// Catches following an external same-ID object and callback-triggered cleanup continuing notifications.
test('cleanup tracked_identity_and_consumer_teardown_stop_synchronous_work', () => {
  const s = setup(); const h = s.create();
  s.viewer.trackedEntity = new Entity({ id: 'TRUCK_001' });
  expect(s.invalid).toEqual(['TRUCK_001']);
  s.callbacks.onInvalidTarget = id => { s.invalid.push(id); h.destroy(); };
  const end = h.beginBatch();
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_002')!);
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_003')!);
  end();
  expect(s.invalid).toEqual(['TRUCK_001', 'TRUCK_002']);
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(0);
});
// Catches putting disposed behind the batch gate and permitting stale input/callbacks.
test('cleanup disposal_during_batch_disables_late_actions_and_end', () => {
  const s = setup(); const h = s.create(); const late = s.actions.get(clickType)!;
  const end = h.beginBatch();
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_001')!);
  h.destroy(); end(); end();
  h.select('TRUCK_002'); late({ position: new Cartesian2() });
  s.viewer.trackedEntity = new Entity({ id: 'TRUCK_002' });
  expect(s.selections).toEqual([]); expect(s.invalid).toEqual([]);
  expect(s.actions.size).toBe(0);
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
});
// Catches a pick/query returning after teardown still publishing selection.
test.each(['pick', 'query', 'select'] as const)('cleanup rechecks_after_%s_consumer', boundary => {
  const s = setup(); const h = s.create();
  const two = s.fleet.getOwnedEntity('TRUCK_002')!;
  if (boundary === 'pick') vi.spyOn(s.viewer.scene, 'pick').mockImplementation(() => { h.destroy(); return { id: two }; });
  if (boundary === 'query') {
    const real = s.fleet.getOwnedEntity;
    vi.spyOn(s.fleet, 'getOwnedEntity').mockImplementation(id => { const result = real(id); h.destroy(); return result; });
  }
  if (boundary === 'select') s.callbacks.onSelect = id => { s.selections.push(id); h.destroy(); };
  s.pick({ id: two }); s.fire(); h.select(null);
  expect(s.selections).toEqual(boundary === 'select' ? ['TRUCK_002'] : []);
  expect(s.actions.size).toBe(0);
});
// Catches aborting independent cleanup after one throw, or treating disposed as released.
test('cleanup release_failure_is_aggregated_and_unreleased_resource_retried', () => {
  const s = setup(); const h = s.create();
  const real = s.handler.removeInputAction;
  let fail = true;
  vi.spyOn(s.handler, 'removeInputAction').mockImplementation(type => {
    if (type === clickType && fail) { fail = false; throw new Error('click cleanup failure'); }
    real(type);
  });
  expect(() => h.destroy()).toThrow(AggregateError);
  expect(s.actions.has(doubleClickType)).toBe(false);
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(0);
  h.destroy(); h.destroy(); expect(s.actions.size).toBe(0);
});
// Catches resources registered after synchronous lifecycle termination being left ownerless.
test.each(['input', 'collection', 'tracked'] as const)('cleanup late_%s_registration_released', boundary => {
  const s = setup();
  if (boundary === 'input') {
    const real = s.handler.setInputAction;
    vi.spyOn(s.handler, 'setInputAction').mockImplementation((action, type) => { real(action, type); s.deactivate(); });
  } else {
    const event = boundary === 'collection' ? s.entities.collectionChanged : s.viewer.trackedEntityChanged;
    const real = event.addEventListener.bind(event);
    vi.spyOn(event, 'addEventListener').mockImplementation((listener: (...args: unknown[]) => void, scope?: unknown) => {
      const release = real(listener, scope); s.deactivate(); return release;
    });
  }
  const h = s.create(); h.destroy();
  expect(s.actions.size).toBe(0);
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(0);
});
// Catches mutate-then-throw setup leaking an action/listener, and preserving the initiating failure.
test.each(['input', 'collection', 'tracked'] as const)('cleanup partial_%s_setup_failure_releases_resources', boundary => {
  const s = setup(); const failure = new Error('setup failed after mutation');
  if (boundary === 'input') {
    const real = s.handler.setInputAction;
    vi.spyOn(s.handler, 'setInputAction').mockImplementation((action, type) => { real(action, type); throw failure; });
  } else {
    const event = boundary === 'collection' ? s.entities.collectionChanged : s.viewer.trackedEntityChanged;
    const real = event.addEventListener.bind(event);
    vi.spyOn(event, 'addEventListener').mockImplementation((listener: (...args: unknown[]) => void, scope?: unknown) => { real(listener, scope); throw failure; });
  }
  expect(() => s.create()).toThrow(failure);
  expect(s.actions.size).toBe(0);
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(0);
});

// Catches losing remaining invalidations when a consumer starts a transaction synchronously.
test('cleanup reentrant_batch_retains_undelivered_invalidations', () => {
  const s = setup(); const h = s.create();
  let nestedEnd: (() => void) | undefined;
  s.callbacks.onInvalidTarget = id => {
    s.invalid.push(id);
    if (id === 'TRUCK_001') nestedEnd = h.beginBatch();
  };
  const end = h.beginBatch();
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_001')!);
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_002')!);
  end();
  expect(s.invalid).toEqual(['TRUCK_001']);
  nestedEnd!();
  expect(s.invalid).toEqual(['TRUCK_001', 'TRUCK_002']);
  h.destroy();
});
// Catches direct/map selection publishing from inside a fleet transaction.
test('cleanup batch_suppresses_selection_and_dead_viewer_end_callbacks', () => {
  const s = setup(); const h = s.create(); const end = h.beginBatch();
  h.select('TRUCK_001'); s.pick(undefined); s.fire();
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_002')!);
  s.kill(); end();
  expect(s.selections).toEqual([]); expect(s.invalid).toEqual([]);
  h.destroy();
  expect(s.entities.collectionChanged.numberOfListeners).toBe(0);
  expect(s.viewer.trackedEntityChanged.numberOfListeners).toBe(0);
});

// Catches failing to discover ownership committed after Cesium's synchronous collection events.
test('cleanup real_fleet_transaction_discovers_new_owned_identity_at_batch_end', () => {
  const s = setup(); const h = s.create(); const end = h.beginBatch();
  const wire = makeFleetSnapshotFixture(); wire.vehicles[0].vehicle_id = 'TRUCK_004';
  s.fleet.apply(parseFleetSnapshot(wire)!, {
    capture: () => null, beforeRemove: () => {}, afterReconcile: () => {}, restore: () => {}, isActive: () => true,
  });
  expect(s.invalid).toEqual([]);
  end(); expect(s.invalid).toEqual(['TRUCK_001']);
  h.select('TRUCK_004'); expect(s.selections).toEqual(['TRUCK_004']);
  s.entities.remove(s.fleet.getOwnedEntity('TRUCK_004')!);
  expect(s.invalid).toEqual(['TRUCK_001', 'TRUCK_004']);
  h.destroy();
});
// Catches lifetime deduplication hiding a second independent association with the same foreign object.
test('cleanup tracking_cycle_same_foreign_entity_notifies_after_each_controller_release', () => {
  const s = setup();
  const external = s.entities.add(new Entity({ id: 'EXTERNAL_RESOURCE' }));
  const retained = [...s.entities.values];
  const h = s.create();
  const foreign = new Entity({ id: 'TRUCK_001' });
  s.callbacks.onInvalidTarget = id => {
    s.invalid.push(id);
    if (s.viewer.trackedEntity === foreign) s.viewer.trackedEntity = undefined;
  };
  s.viewer.trackedEntity = foreign;
  expect(s.viewer.trackedEntity).toBeUndefined();
  expect(s.invalid).toEqual(['TRUCK_001']);
  s.viewer.trackedEntity = foreign;
  expect(s.invalid).toEqual(['TRUCK_001', 'TRUCK_001']);
  expect(s.viewer.trackedEntity).toBeUndefined();
  expect(s.entities.values).toHaveLength(retained.length);
  for (const entity of retained) expect(s.entities.getById(entity.id)).toBe(entity);
  expect(s.entities.getById(external.id)).toBe(external);
  expect(s.entities.getById(s.statik.id)).toBe(s.statik);
  h.destroy();
});
// Catches deduplication surviving a switch through another target, without clearing external camera policy.
test('cleanup tracking_cycle_target_switch_allows_same_foreign_identity_again', () => {
  const s = setup(); const h = s.create();
  const first = new Entity({ id: 'TRUCK_001' });
  const second = new Entity({ id: 'TRUCK_002' });
  s.viewer.trackedEntity = first;
  expect(s.invalid).toEqual(['TRUCK_001']);
  expect(s.viewer.trackedEntity).toBe(first);
  s.viewer.trackedEntity = second;
  expect(s.invalid).toEqual(['TRUCK_001', 'TRUCK_002']);
  expect(s.viewer.trackedEntity).toBe(second);
  s.viewer.trackedEntity = first;
  expect(s.invalid).toEqual(['TRUCK_001', 'TRUCK_002', 'TRUCK_001']);
  expect(s.viewer.trackedEntity).toBe(first);
  h.destroy();
});
// Catches removing cycle-local synchronous reentry protection and recursive duplicate notifications.
test('cleanup tracking_cycle_unresolved_duplicate_events_remain_deduplicated', () => {
  const s = setup(); const h = s.create();
  const foreign = new Entity({ id: 'TRUCK_001' });
  s.callbacks.onInvalidTarget = id => {
    s.invalid.push(id);
    if (s.invalid.length > 1) throw new Error('Recursive duplicate invalidation');
    s.viewer.trackedEntityChanged.raiseEvent(foreign);
    s.entities.collectionChanged.raiseEvent(s.entities, [], [], []);
  };
  s.viewer.trackedEntity = foreign;
  s.viewer.trackedEntityChanged.raiseEvent(foreign);
  s.entities.collectionChanged.raiseEvent(s.entities, [], [], []);
  expect(s.invalid).toEqual(['TRUCK_001']);
  expect(s.viewer.trackedEntity).toBe(foreign);
  h.destroy();
});
