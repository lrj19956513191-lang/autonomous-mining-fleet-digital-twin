import { expect, test, vi, afterEach } from 'vitest';
import { Cartesian2, Cartesian3, Color, ConstantPositionProperty, Entity, EntityCollection, JulianDate, PointVisualizer } from 'cesium';
import { makeFleetSnapshotFixture } from '../realtime/fleetFixtures';
import { parseFleetSnapshot, type FleetSnapshot } from '../realtime/fleetTelemetry';
import { makeSceneInput } from '../scene/sceneFixtures';
import { parseMineScene } from '../scene/sceneClient';
import { renderMineScene } from '../scene/sceneRenderer';
import { createFleetEntities, FleetRenderError, type FleetReconcileHooks } from './fleetEntities';

const time = JulianDate.fromIso8601('2026-10-14T04:00:00Z');
afterEach(() => vi.restoreAllMocks());
function snapshot(change?: (wire: ReturnType<typeof makeFleetSnapshotFixture>) => void): FleetSnapshot {
  const wire = makeFleetSnapshotFixture();
  change?.(wire);
  const parsed = parseFleetSnapshot(wire);
  if (!parsed) throw new Error('Invalid test snapshot');
  return parsed;
}
function setup() {
  const entities = new EntityCollection();
  const scene = parseMineScene(makeSceneInput());
  if (!scene) throw new Error('Invalid source scene');
  renderMineScene(entities, scene);
  const statics = [...entities.values];
  let active = true;
  const handle = createFleetEntities(entities, () => active);
  return { entities, statics, handle, deactivate: () => { active = false; } };
}
function hooks(): FleetReconcileHooks<null> {
  return { capture: () => null, beforeRemove: () => {}, afterReconcile: () => {}, restore: () => {}, isActive: () => true };
}
function expectStatics(entities: EntityCollection, statics: Entity[]) {
  expect(statics).toHaveLength(13);
  statics.forEach(entity => expect(entities.getById(entity.id)).toBe(entity));
}
// Catches recreation, divergent coordinate conversion/style and extra scene/route entities.
test('retains_entity_identity_and_shared_vehicle_semantics', () => {
  const { entities, statics, handle } = setup();
  const first = snapshot();
  handle.apply(first, hooks());
  expect(entities.values).toHaveLength(16);
  expectStatics(entities, statics);
  const identities = first.vehicles.map(vehicle => {
    const entity = handle.getOwnedEntity(vehicle.vehicle_id)!;
    expect(entity).toBe(entities.getById(vehicle.vehicle_id));
    expect(entity.position).toBeInstanceOf(ConstantPositionProperty);
    expect(entity.position?.getValue(time)).toEqual(Cartesian3.fromDegrees(vehicle.longitude, vehicle.latitude, vehicle.height));
    expect(entity.point?.pixelSize?.getValue(time)).toBe(12);
    expect(entity.point?.color?.getValue(time)).toEqual(Color.YELLOW);
    expect(entity.point?.outlineWidth?.getValue(time)).toBe(2);
    expect(entity.point?.outlineColor?.getValue(time)).toEqual(Color.BLACK);
    expect(entity.label?.text?.getValue(time)).toBe(vehicle.vehicle_id);
    expect(entity.label?.pixelOffset?.getValue(time)).toEqual(new Cartesian2(0, -16));
    expect(entity.point?.disableDepthTestDistance?.getValue(time)).toBe(2000);
    expect(entity.label?.disableDepthTestDistance?.getValue(time)).toBe(2000);
    return { entity, position: entity.position, point: entity.point, label: entity.label };
  });
  const later = snapshot(wire => { wire.vehicles.reverse(); wire.vehicles.forEach(vehicle => { vehicle.longitude += 0.001; }); });
  handle.apply(later, hooks());
  first.vehicles.forEach((vehicle, index) => {
    const identity = identities[index];
    const entity = handle.getOwnedEntity(vehicle.vehicle_id)!;
    expect(entity).toBe(identity.entity);
    expect(entity.position).toBe(identity.position);
    expect(entity.point).toBe(identity.point);
    expect(entity.label).toBe(identity.label);
    expect(entity.position?.getValue(time)).toEqual(Cartesian3.fromDegrees(vehicle.longitude + 0.001, vehicle.latitude, vehicle.height));
  });
  expect(entities.values).toHaveLength(16);
  expectStatics(entities, statics);
});
// Catches retaining absent IDs, ignoring empty snapshots and recreating retained vehicles.
test('ownership_adds_removes_without_stealing_external_entities', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const retained = handle.getOwnedEntity('TRUCK_002');
  const removed = handle.getOwnedEntity('TRUCK_001')!;
  const next = snapshot(wire => { wire.vehicles.shift(); wire.vehicles[1].vehicle_id = 'TRUCK_004'; });
  handle.apply(next, hooks());
  expect(handle.getOwnedEntity('TRUCK_002')).toBe(retained);
  expect(handle.getOwnedEntity('TRUCK_004')).toBe(entities.getById('TRUCK_004'));
  expect(handle.getOwnedEntity('TRUCK_001')).toBeUndefined();
  expect(entities.values.includes(removed)).toBe(false);
  expect(entities.getById('TRUCK_003')).toBeUndefined();
  expect(entities.values).toHaveLength(15);
  handle.apply(snapshot(wire => { wire.vehicles = []; }), hooks());
  expect(entities.values).toHaveLength(13);
  expect(handle.getOwnedEntity('TRUCK_002')).toBeUndefined();
  expectStatics(entities, statics);
});
// Catches partial mutation before discovering a collision in the final ID.
test.each(['TRUCK_001', 'TRUCK_003'])('ownership_preflights_all_external_ids: %s', id => {
  const { entities, statics, handle } = setup();
  const external = entities.add(new Entity({ id }));
  let events = 0;
  entities.collectionChanged.addEventListener(() => { events++; });
  expect(() => handle.apply(snapshot(), hooks())).toThrow(FleetRenderError);
  expect(events).toBe(0);
  expect(entities.values).toHaveLength(14);
  expect(entities.getById(id)).toBe(external);
  expect(handle.getOwnedEntity(id)).toBeUndefined();
  expectStatics(entities, statics);
});
// Catches Cesium's remove-by-ID deleting a replacement and stale handles re-acquiring ownership.
test('ownership_destroy_is_identity_safe_and_idempotent', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  entities.remove(handle.getOwnedEntity('TRUCK_001')!);
  entities.remove(handle.getOwnedEntity('TRUCK_002')!);
  const replacement = entities.add(new Entity({ id: 'TRUCK_001' }));
  expect(handle.getOwnedEntity('TRUCK_001')).toBeUndefined();
  expect(handle.getOwnedEntity('TRUCK_002')).toBeUndefined();
  handle.destroy();
  handle.destroy();
  expect(entities.values).toHaveLength(14);
  expect(entities.getById(replacement.id)).toBe(replacement);
  handle.apply(snapshot(wire => { wire.vehicles = []; }), hooks());
  expect(entities.values).toHaveLength(14);
  expectStatics(entities, statics);
});
function caught(action: () => void): FleetRenderError {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(FleetRenderError);
  return failure as FleetRenderError;
}
function remember(handle: ReturnType<typeof createFleetEntities>) {
  return ['TRUCK_001', 'TRUCK_002', 'TRUCK_003'].map(id => {
    const entity = handle.getOwnedEntity(id)!;
    return { entity, position: entity.position!, value: entity.position!.getValue(time), point: entity.point!, label: entity.label!,
      color: entity.point!.outlineColor!, width: entity.point!.outlineWidth!,
      colorValue: entity.point!.outlineColor!.getValue(time), widthValue: entity.point!.outlineWidth!.getValue(time) };
  });
}
function expectRemembered(entities: EntityCollection, handle: ReturnType<typeof createFleetEntities>, old: ReturnType<typeof remember>) {
  for (const item of old) {
    expect(handle.getOwnedEntity(item.entity.id)).toBe(item.entity);
    expect(entities.getById(item.entity.id)).toBe(item.entity);
    expect(item.entity.position).toBe(item.position);
    expect(item.position.getValue(time)).toEqual(item.value);
    expect(item.entity.point).toBe(item.point);
    expect(item.entity.label).toBe(item.label);
    expect(item.point.outlineColor).toBe(item.color);
    expect(item.point.outlineWidth).toBe(item.width);
    expect(item.color.getValue(time)).toEqual(item.colorValue);
    expect(item.width.getValue(time)).toBe(item.widthValue);
  }
}
function replacementSnapshot() {
  return snapshot(wire => {
    wire.vehicles[0].longitude += 0.01;
    const prototype = wire.vehicles[1];
    wire.vehicles = [wire.vehicles[0], ...['TRUCK_004', 'TRUCK_005', 'TRUCK_006'].map(vehicle_id => ({ ...prototype, vehicle_id }))];
  });
}
// Catches selection replacing style properties, resetting on updates and not restoring defaults.
test('rollback_selection_style_identity_and_successful_hook_staging', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const first = handle.getOwnedEntity('TRUCK_001')!;
  const color = first.point!.outlineColor;
  const width = first.point!.outlineWidth;
  handle.setSelected('TRUCK_001');
  expect(first.point!.outlineColor).toBe(color);
  expect(first.point!.outlineWidth).toBe(width);
  expect(color!.getValue(time)).toEqual(Color.CYAN);
  expect(width!.getValue(time)).toBe(3);
  handle.apply(replacementSnapshot(), { ...hooks(), afterReconcile: () => {
    expect(handle.getOwnedEntity('TRUCK_006')).toBe(entities.getById('TRUCK_006'));
    expect(handle.getOwnedEntity('TRUCK_002')).toBeUndefined();
    handle.setSelected('TRUCK_006');
  } });
  expect(color!.getValue(time)).toEqual(Color.BLACK);
  expect(width!.getValue(time)).toBe(2);
  expect(handle.getOwnedEntity('TRUCK_006')!.point!.outlineColor!.getValue(time)).toEqual(Color.CYAN);
  handle.setSelected(null);
  expect(handle.getOwnedEntity('TRUCK_006')!.point!.outlineWidth!.getValue(time)).toBe(2);
  expectStatics(entities, statics);
});
// Catches incomplete rollback of in-place values, removals, styles and controller checkpoints.
test.each(['update', 'third add before', 'third add after', 'remove after', 'beforeRemove', 'afterReconcile'] as const)(
  'rollback_restores_updates_removals_styles_and_tracking: %s', phase => {
    const { entities, statics, handle } = setup();
    const external = entities.add(new Entity({ id: 'external-survey' }));
    handle.apply(snapshot(), hooks());
    handle.setSelected('TRUCK_001');
    const old = remember(handle);
    const cause = new Error(phase);
    let controller = { selected: 'TRUCK_001', tracked: old[1].entity, cameraLocated: true, selectionInitialized: true, camera: [1, 2, 3] };
    const before = { ...controller, camera: [...controller.camera] };
    let published: FleetSnapshot | undefined;
    const transactionHooks: FleetReconcileHooks<typeof controller> = {
      capture: () => ({ ...controller, camera: [...controller.camera] }),
      beforeRemove: () => {
        controller = { ...controller, selected: '', tracked: old[0].entity, camera: [8, 9, 10] };
        handle.setSelected(null);
        if (phase === 'beforeRemove') throw cause;
      },
      afterReconcile: () => {
        handle.setSelected('TRUCK_006');
        controller = { ...controller, selected: 'TRUCK_006', cameraLocated: false };
        if (phase === 'afterReconcile') throw cause;
      },
      restore: checkpoint => { controller = checkpoint; }, isActive: () => true,
    };
    if (phase === 'update') {
      const property = old[0].position as ConstantPositionProperty;
      const realSet = property.setValue.bind(property);
      let fired = false;
      vi.spyOn(property, 'setValue').mockImplementation((...args) => {
        realSet(...args);
        if (!fired) { fired = true; throw cause; }
      });
    }
    if (phase.startsWith('third add')) {
      const realAdd = entities.add.bind(entities);
      let adds = 0;
      vi.spyOn(entities, 'add').mockImplementation(entity => {
        adds++;
        if (adds === 3) {
          if (phase === 'third add after') realAdd(entity);
          throw cause;
        }
        return realAdd(entity);
      });
    }
    if (phase === 'remove after') {
      const realRemove = entities.remove.bind(entities);
      let fired = false;
      vi.spyOn(entities, 'remove').mockImplementation(entity => {
        const result = realRemove(entity);
        if (!fired) { fired = true; throw cause; }
        return result;
      });
    }
    const failure = caught(() => { const next = replacementSnapshot(); handle.apply(next, transactionHooks); published = next; });
    // Public mutation failure cannot distinguish a wrapper throw from interrupted Cesium dispatch.
    expect(failure.restored).toBe(phase === 'beforeRemove' || phase === 'afterReconcile');
    expect(failure.cause).toBe(cause);
    expect(published).toBeUndefined();
    expect(controller).toEqual(before);
    expectRemembered(entities, handle, old);
    expect(entities.values).toHaveLength(17);
    expect(entities.getById(external.id)).toBe(external);
    for (const id of ['TRUCK_004', 'TRUCK_005', 'TRUCK_006']) expect(entities.getById(id)).toBeUndefined();
    expectStatics(entities, statics);
    handle.setSelected(null);
    expect(old[0].color.getValue(time)).toEqual(Color.BLACK);
  },
);
// Catches late validation of the final member after already updating earlier entities.
test('rollback_preflights_the_full_snapshot_before_mutation', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const old = remember(handle);
  const invalid = makeFleetSnapshotFixture();
  invalid.vehicles[0].longitude += 0.01;
  invalid.vehicles[2].longitude = Number.NaN;
  const failure = caught(() => handle.apply(invalid as unknown as FleetSnapshot, hooks()));
  expect(failure.restored).toBe(true);
  expectRemembered(entities, handle, old);
  expectStatics(entities, statics);
});
// Catches disposed being incorrectly treated as successful resource cleanup.
test('inactive_destroy_releases_owned_entities', () => {
  const { entities, statics, handle, deactivate } = setup();
  handle.apply(snapshot(), hooks());
  const replaced = handle.getOwnedEntity('TRUCK_001')!;
  entities.remove(replaced);
  const replacement = entities.add(new Entity({ id: replaced.id }));
  deactivate();
  handle.destroy();
  handle.destroy();
  expect(entities.values).toHaveLength(14);
  expect(entities.getById(replacement.id)).toBe(replacement);
  expectStatics(entities, statics);
});
// Catches labeling a partial rollback as restored and losing either exception.
test.each(['position', 'style', 'add', 'remove', 'restore'] as const)(
  'rollback_failure_reports_fatal_and_preserves_both_causes: %s', resource => {
    const { entities, statics, handle } = setup();
    handle.apply(snapshot(), hooks());
    handle.setSelected('TRUCK_001');
    const old = remember(handle);
    const primary = new Error('apply failed');
    const rollback = new Error(`${resource} rollback failed`);
    const transactionHooks = { ...hooks(), afterReconcile: () => { handle.setSelected('TRUCK_006'); throw primary; } };
    if (resource === 'position') {
      const property = old[0].position as ConstantPositionProperty;
      const realSet = property.setValue.bind(property);
      vi.spyOn(property, 'setValue').mockImplementation((...args) => {
        if (Cartesian3.equals(args[0], old[0].value)) throw rollback;
        realSet(...args);
      });
    }
    if (resource === 'style') {
      const property = old[0].color as import('cesium').ConstantProperty;
      const realSet = property.setValue.bind(property);
      vi.spyOn(property, 'setValue').mockImplementation(value => {
        if (Color.equals(value, Color.CYAN)) throw rollback;
        realSet(value);
      });
    }
    if (resource === 'add') {
      const realAdd = entities.add.bind(entities);
      vi.spyOn(entities, 'add').mockImplementation(entity => {
        if (entity === old[1].entity) throw rollback;
        return realAdd(entity);
      });
    }
    if (resource === 'remove') {
      const realRemove = entities.remove.bind(entities);
      vi.spyOn(entities, 'remove').mockImplementation(entity => {
        if (entity?.id === 'TRUCK_004') throw rollback;
        return realRemove(entity);
      });
    }
    if (resource === 'restore') transactionHooks.restore = () => { throw rollback; };
    const failure = caught(() => handle.apply(replacementSnapshot(), transactionHooks));
    expect(failure.restored).toBe(false);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).cause).toBe(primary);
    expect((failure.cause as AggregateError).errors).toContain(primary);
    expect((failure.cause as AggregateError).errors).toContain(rollback);
    expectStatics(entities, statics);
    vi.restoreAllMocks();
    handle.destroy();
    expect(entities.values).toHaveLength(13);
  },
);
// Catches stopping teardown after one resource throws and silently dropping unfinished ownership.
test.each(['before removal', 'after removal'] as const)('failure_destroy_attempts_every_resource_and_retries_only_unconfirmed: %s', phase => {
  const { entities, statics, handle, deactivate } = setup();
  handle.apply(snapshot(), hooks());
  const first = handle.getOwnedEntity('TRUCK_001')!;
  const cause = new Error('remove failed');
  const realRemove = entities.remove.bind(entities);
  let firstAttempt = true;
  vi.spyOn(entities, 'remove').mockImplementation(entity => {
    if (entity === first && firstAttempt) {
      firstAttempt = false;
      if (phase === 'after removal') realRemove(entity);
      throw cause;
    }
    return realRemove(entity);
  });
  deactivate();
  const failure = caught(() => handle.destroy());
  expect(failure.restored).toBe(false);
  expect(entities.getById('TRUCK_002')).toBeUndefined();
  expect(entities.getById('TRUCK_003')).toBeUndefined();
  expect(entities.getById(first.id)).toBe(phase === 'before removal' ? first : undefined);
  const removals: string[] = [];
  entities.collectionChanged.addEventListener((_collection, _added, removed) => { removals.push(...removed.map(entity => entity.id)); });
  handle.destroy();
  handle.destroy();
  expect(removals).toEqual(phase === 'before removal' ? ['TRUCK_001'] : []);
  expect(entities.values).toHaveLength(13);
  expectStatics(entities, statics);
});
// Catches stale positive operations after synchronous public Cesium events end the lifecycle.
test.each(['update', 'add', 'remove', 'style', 'capture', 'beforeRemove', 'afterReconcile'] as const)(
  'synchronous_cleanup_never_continues_or_readds: %s', phase => {
    const { entities, statics, handle, deactivate } = setup();
    handle.apply(snapshot(), hooks());
    const old = remember(handle);
    let stopped = false;
    let laterAdds = 0;
    let laterMutations = 0;
    let after = false;
    let published = false;
    const stop = () => { if (stopped) return; stopped = true; deactivate(); handle.destroy(); };
    entities.collectionChanged.addEventListener((_collection, added, removed) => {
      if (stopped) laterAdds += added.length;
      else if ((phase === 'add' && added.length > 0) || (phase === 'remove' && removed.length > 0)) stop();
    });
    old[0].position.definitionChanged.addEventListener(() => { if (phase === 'update') stop(); });
    old[1].position.definitionChanged.addEventListener(() => { if (stopped) laterMutations++; });
    old[0].color.definitionChanged.addEventListener(() => { if (phase === 'style') stop(); });
    const transactionHooks = { ...hooks(),
      capture: () => { if (phase === 'capture') stop(); return null; },
      beforeRemove: () => { if (phase === 'beforeRemove') stop(); },
      afterReconcile: () => {
        after = true;
        if (phase === 'style') handle.setSelected('TRUCK_001');
        if (phase === 'afterReconcile') stop();
      },
      restore: () => { throw new Error('Ended lifecycle must never restore hooks'); },
      isActive: () => !stopped,
    };
    const failure = caught(() => { handle.apply(replacementSnapshot(), transactionHooks); published = true; });
    expect(failure.restored).toBe(false);
    expect(stopped).toBe(true);
    expect(published).toBe(false);
    expect(laterAdds).toBe(0);
    expect(laterMutations).toBe(0);
    expect(after).toBe(phase === 'style' || phase === 'afterReconcile');
    expect(entities.values).toHaveLength(13);
    expectStatics(entities, statics);
  },
);
// Catches performing the next rollback operation after restore itself disposes the lifecycle.
test('synchronous_cleanup_during_rollback_stops_restoration', () => {
  const { entities, statics, handle, deactivate } = setup();
  handle.apply(snapshot(), hooks());
  const old = remember(handle);
  let stopDuringRollback = false;
  let stopped = false;
  let lateAdds = 0;
  old[0].position.definitionChanged.addEventListener(() => {
    if (!stopDuringRollback) return;
    stopped = true;
    deactivate();
    handle.destroy();
  });
  entities.collectionChanged.addEventListener((_collection, added) => { if (stopped) lateAdds += added.length; });
  const primary = new Error('start rollback');
  const failure = caught(() => handle.apply(replacementSnapshot(), { ...hooks(), afterReconcile: () => { stopDuringRollback = true; throw primary; } }));
  expect(failure.restored).toBe(false);
  expect(stopped).toBe(true);
  expect(lateAdds).toBe(0);
  expect(entities.values).toHaveLength(13);
  expectStatics(entities, statics);
});
// Catches a lifecycle ending solely through hooks.isActive while the outer owner is still active.
test('synchronous_hooks_gate_stops_after_each_side_effect', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const old = remember(handle);
  let hookActive = true;
  old[0].position.definitionChanged.addEventListener(() => { hookActive = false; });
  const failure = caught(() => handle.apply(snapshot(wire => { wire.vehicles.forEach(vehicle => { vehicle.longitude += 0.01; }); }), {
    ...hooks(), isActive: () => hookActive,
    afterReconcile: () => { throw new Error('Must not reach hook'); },
  }));
  expect(failure.restored).toBe(false);
  expect(old[1].position.getValue(time)).toEqual(old[1].value);
  handle.destroy();
  expect(entities.values).toHaveLength(13);
  expectStatics(entities, statics);
});
// Catches restoring a stale owned reference that was already absent before this transaction.
test('rollback_preserves_preexisting_external_removal', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const absent = handle.getOwnedEntity('TRUCK_003')!;
  entities.remove(absent);
  const cause = new Error('after reconcile');
  const failure = caught(() => handle.apply(snapshot(wire => { wire.vehicles.pop(); wire.vehicles[0].longitude += 0.01; }), {
    ...hooks(), afterReconcile: () => { throw cause; },
  }));
  expect(failure.restored).toBe(true);
  expect(failure.cause).toBe(cause);
  expect(entities.getById(absent.id)).toBeUndefined();
  expect(handle.getOwnedEntity(absent.id)).toBeUndefined();
  expect(entities.values).toHaveLength(15);
  expectStatics(entities, statics);
});
// Catches trusting a stale identity check across a synchronous property event during rollback.
test('failure_detects_external_replacement_during_rollback', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const old = remember(handle);
  let restoring = false;
  let replacement: Entity | undefined;
  old[0].position.definitionChanged.addEventListener(() => {
    if (!restoring || replacement) return;
    entities.remove(old[0].entity);
    replacement = entities.add(new Entity({ id: old[0].entity.id }));
  });
  const failure = caught(() => handle.apply(replacementSnapshot(), { ...hooks(), afterReconcile: () => {
    restoring = true;
    throw new Error('primary');
  } }));
  expect(failure.restored).toBe(false);
  expect(entities.getById('TRUCK_001')).toBe(replacement);
  handle.destroy();
  expect(entities.values).toHaveLength(14);
  expectStatics(entities, statics);
});
// Catches silent restore-add failure being reported as a complete restoration.
test('failure_checks_real_membership_after_rollback_add', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const second = handle.getOwnedEntity('TRUCK_002')!;
  const realAdd = entities.add.bind(entities);
  vi.spyOn(entities, 'add').mockImplementation(entity => entity === second ? second : realAdd(entity));
  const failure = caught(() => handle.apply(replacementSnapshot(), { ...hooks(), afterReconcile: () => { throw new Error('primary'); } }));
  expect(failure.restored).toBe(false);
  expect(entities.getById(second.id)).toBeUndefined();
  expectStatics(entities, statics);
});
// Catches continuing to mutate later vehicles and publishing a mapping with a lost owned entity.
test('failure_stops_forward_mutation_on_synchronous_identity_loss', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const old = remember(handle);
  let replacement: Entity | undefined;
  old[0].position.definitionChanged.addEventListener(() => {
    if (replacement) return;
    entities.remove(old[0].entity);
    replacement = entities.add(new Entity({ id: old[0].entity.id }));
  });
  let published = false;
  const failure = caught(() => handle.apply(snapshot(wire => { wire.vehicles.forEach(vehicle => { vehicle.longitude += 0.01; }); }), {
    ...hooks(), afterReconcile: () => { published = true; },
  }));
  expect(failure.restored).toBe(false);
  expect(published).toBe(false);
  expect(old[1].position.getValue(time)).toEqual(old[1].value);
  expect(entities.getById('TRUCK_001')).toBe(replacement);
  handle.destroy();
  expectStatics(entities, statics);
});
// I1: a late selection callback must not leave a removed original entity outside the ownership ledger.
test('final_membership_commit_detects_late_readdition_of_removed_owned_entity', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const first = handle.getOwnedEntity('TRUCK_001')!;
  const removed = handle.getOwnedEntity('TRUCK_002')!;
  let readded = false;
  first.point!.outlineColor!.definitionChanged.addEventListener(() => {
    if (readded || entities.getById(removed.id)) return;
    readded = true;
    entities.add(removed);
  });
  const failure = caught(() => handle.apply(snapshot(wire => { wire.vehicles.splice(1, 1); }), {
    ...hooks(), afterReconcile: () => handle.setSelected('TRUCK_001'),
  }));
  expect(readded).toBe(true);
  expect(failure.restored).toBe(true);
  expect(entities.values).toHaveLength(16);
  expect(handle.getOwnedEntity(removed.id)).toBe(removed);
  expect(first.point!.outlineColor!.getValue(time)).toEqual(Color.BLACK);
  handle.destroy();
  expect(entities.values).toHaveLength(13);
  expectStatics(entities, statics);
});
// I1: later property/controller restoration can reattach an addition already visited by rollback.
test.each(['restore hook', 'old property'] as const)('final_membership_rollback_detects_late_readded_addition: %s', phase => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const first = handle.getOwnedEntity('TRUCK_001')!;
  let addition: Entity | undefined;
  let rollingBack = false;
  let readded = false;
  const readd = () => {
    if (!rollingBack || !addition || readded) return;
    readded = true;
    entities.add(addition);
  };
  if (phase === 'old property') first.position!.definitionChanged.addEventListener(readd);
  const primary = new Error('start rollback');
  const failure = caught(() => handle.apply(replacementSnapshot(), {
    ...hooks(), afterReconcile: () => {
      addition = handle.getOwnedEntity('TRUCK_004');
      rollingBack = true;
      throw primary;
    }, restore: () => { if (phase === 'restore hook') readd(); },
  }));
  expect(readded).toBe(true);
  expect(failure.restored).toBe(false);
  expect(failure.cause).toBeInstanceOf(AggregateError);
  expect((failure.cause as AggregateError).cause).toBe(primary);
  expect(entities.getById('TRUCK_004')).toBe(addition);
  handle.destroy();
  expect(entities.values).toHaveLength(13);
  expectStatics(entities, statics);
});
// I1: a later remove listener can reattach an earlier original; preserve its cleanup record for retry.
test('final_membership_destroy_reports_and_retains_late_readded_original', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks());
  const first = handle.getOwnedEntity('TRUCK_001')!;
  const external = entities.add(new Entity({ id: 'external-survey' }));
  let readded = false;
  entities.collectionChanged.addEventListener((_collection, _added, removed) => {
    if (readded || !removed.some(entity => entity.id === 'TRUCK_002')) return;
    readded = true;
    entities.add(first);
  });
  const failure = caught(() => handle.destroy());
  expect(readded).toBe(true);
  expect(failure.restored).toBe(false);
  expect(entities.getById(first.id)).toBe(first);
  expect(entities.getById('TRUCK_002')).toBeUndefined();
  expect(entities.getById('TRUCK_003')).toBeUndefined();
  handle.destroy();
  handle.destroy();
  expect(entities.values).toHaveLength(14);
  expect(entities.getById(external.id)).toBe(external);
  expectStatics(entities, statics);
});

// C-I1: member restoration cannot certify Cesium notifications or the real Visualizer.
test.each(['before', 'after'] as const)('notification_failure_is_fatal_with_visualizer_subscribed_%s: add', order => {
  const entities = new EntityCollection();
  const points: { id: Entity }[] = [];
  const cause = new Error('public collectionChanged add failure');
  const listen = () => entities.collectionChanged.addEventListener((_collection, added) => {
    if (added.length) throw cause;
  });
  let removeThrower = order === 'before' ? listen() : () => {};
  // Only the primitive allocation boundary is replaced; collection, properties and Visualizer are real.
  const visualizer = new PointVisualizer({
    getPoint(entity: Entity) { const point = { id: entity }; points.push(point); return point; },
    removePoint() {}, removeBillboard() {},
  } as unknown as ConstructorParameters<typeof PointVisualizer>[0], entities);
  if (order === 'after') removeThrower = listen();
  const handle = createFleetEntities(entities, () => true);
  const failure = caught(() => handle.apply(snapshot(), hooks()));
  expect(failure.cause).toBe(cause);
  expect(entities.values).toHaveLength(0); // Membership rollback really succeeded.
  removeThrower();
  const current = entities.add(new Entity({ id: 'TRUCK_001', position: Cartesian3.fromDegrees(116, 39, 50), point: { pixelSize: 12 } }));
  visualizer.update(time);
  expect(points).toHaveLength(order === 'before' ? 0 : 1);
  expect(points.every(point => point.id !== current)).toBe(true);
  expect(points.some(point => point.id === current)).toBe(false);
  expect(failure.restored).toBe(false);
  visualizer.destroy(); handle.destroy();
});

test.each(['before', 'after'] as const)('notification_failure_is_fatal_with_visualizer_subscribed_%s: remove', order => {
  const entities = new EntityCollection();
  const points = new Map<Entity, { id: Entity }>();
  let armed = false;
  const cause = new Error('public collectionChanged remove failure');
  const listen = () => entities.collectionChanged.addEventListener((_collection, _added, removed) => {
    if (armed && removed.length) throw cause;
  });
  let removeThrower = order === 'before' ? listen() : () => {};
  const visualizer = new PointVisualizer({
    getPoint(entity: Entity) { const point = { id: entity }; points.set(entity, point); return point; },
    removePoint(entity: Entity) { points.delete(entity); }, removeBillboard() {},
  } as unknown as ConstructorParameters<typeof PointVisualizer>[0], entities);
  if (order === 'after') removeThrower = listen();
  const handle = createFleetEntities(entities, () => true);
  handle.apply(snapshot(), hooks()); visualizer.update(time);
  const old = remember(handle);
  expect(points.size).toBe(3);
  armed = true;
  const failure = caught(() => handle.apply(snapshot(wire => { wire.vehicles.shift(); }), hooks()));
  expectRemembered(entities, handle, old); // Same objects, properties, styles and coordinates restored.
  removeThrower();
  entities.remove(old[1].entity); // Public removal succeeds but no longer reaches the Visualizer.
  visualizer.update(time);
  expect(entities.values).toHaveLength(2);
  expect(points.has(old[1].entity)).toBe(true);
  expect(points.has(old[0].entity)).toBe(order === 'before');
  expect(failure.cause).toBe(cause);
  expect(failure.restored).toBe(false);
  visualizer.destroy(); handle.destroy();
});

// C-I1: healthy notifications after hook/preparation failure remain safely recoverable.
test('notification_safe_hook_and_preparation_failures_keep_real_visualizer_recoverable', () => {
  const entities = new EntityCollection();
  const points = new Map<Entity, { id: Entity; position?: Cartesian3 }>();
  const visualizer = new PointVisualizer({
    getPoint(entity: Entity) {
      let stored: Cartesian3 | undefined;
      // Real PointPrimitive.position copies the Visualizer's reused scratch Cartesian3.
      const point = { id: entity, get position() { return stored; },
        set position(value: Cartesian3 | undefined) { stored = value ? Cartesian3.clone(value) : undefined; } };
      points.set(entity, point); return point;
    },
    removePoint(entity: Entity) { points.delete(entity); }, removeBillboard() {},
  } as unknown as ConstructorParameters<typeof PointVisualizer>[0], entities);
  const handle = createFleetEntities(entities, () => true);
  handle.apply(snapshot(), hooks()); visualizer.update(time);
  const old = remember(handle);
  const invalid = makeFleetSnapshotFixture(); invalid.vehicles[2].longitude = Number.NaN;
  expect(caught(() => handle.apply(invalid as unknown as FleetSnapshot, hooks())).restored).toBe(true);
  const cause = new Error('controller hook failed with healthy collection');
  const failure = caught(() => handle.apply(replacementSnapshot(), { ...hooks(), afterReconcile() { throw cause; } }));
  expect(failure.restored).toBe(true); expect(failure.cause).toBe(cause);
  expectRemembered(entities, handle, old);
  visualizer.update(time); expect(points.size).toBe(3);
  const next = snapshot(wire => { wire.vehicles.forEach(vehicle => { vehicle.longitude += 0.001; }); });
  handle.apply(next, hooks()); visualizer.update(time);
  for (const [index, vehicle] of next.vehicles.entries()) {
    const entity = handle.getOwnedEntity(vehicle.vehicle_id)!;
    expect(entity).toBe(old[index].entity); expect(entity.position).toBe(old[index].position);
    const expected = Cartesian3.fromDegrees(vehicle.longitude, vehicle.latitude, vehicle.height);
    expect(entity.position?.getValue(time)).toEqual(expected);
    expect(points.get(entity)?.position).toEqual(expected);
  }
  handle.destroy(); visualizer.destroy();
});

// C-I1 also applies to collectionChanged raised by in-place property updates.
test('notification_failure_during_real_property_update_is_fatal', () => {
  const { entities, statics, handle } = setup();
  handle.apply(snapshot(), hooks()); const old = remember(handle);
  let once = true;
  const cause = new Error('changed notification failed');
  const remove = entities.collectionChanged.addEventListener((_collection, _added, _removed, changed) => {
    if (once && changed.includes(old[0].entity)) { once = false; throw cause; }
  });
  const failure = caught(() => handle.apply(snapshot(wire => { wire.vehicles[0].longitude += 0.001; }), hooks()));
  expect(failure.restored).toBe(false); expect(failure.cause).toBe(cause);
  expectRemembered(entities, handle, old); expectStatics(entities, statics);
  remove(); handle.destroy();
});
