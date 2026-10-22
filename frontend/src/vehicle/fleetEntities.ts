import {
  Cartesian3, Color, ConstantPositionProperty, ConstantProperty, EntityCollection, JulianDate,
  type Entity, type LabelGraphics, type PointGraphics, type Property,
} from 'cesium';
import { parseFleetSnapshot, type FleetSnapshot } from '../realtime/fleetTelemetry';
import { upsertVehicleEntity } from './vehicleEntity';

export interface FleetReconcileHooks<T> {
  capture(): T;
  beforeRemove(id: string, entity: Entity): void;
  afterReconcile(snapshot: FleetSnapshot): void;
  restore(checkpoint: T): void;
  isActive(): boolean;
}
export interface FleetEntitiesHandle {
  apply<T>(snapshot: FleetSnapshot, hooks: FleetReconcileHooks<T>): void;
  getOwnedEntity(id: string): Entity | undefined;
  setSelected(id: string | null): void;
  destroy(): void;
}
export class FleetRenderError extends Error {
  constructor(message: string, readonly restored: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = 'FleetRenderError';
  }
}

const checkpointTime = JulianDate.fromIso8601('2000-01-01T00:00:00Z');
const pointKeys = ['show', 'pixelSize', 'heightReference', 'color', 'outlineColor', 'outlineWidth',
  'scaleByDistance', 'translucencyByDistance', 'distanceDisplayCondition', 'disableDepthTestDistance'];
const labelKeys = ['show', 'text', 'font', 'style', 'scale', 'showBackground', 'backgroundColor',
  'backgroundPadding', 'pixelOffset', 'eyeOffset', 'horizontalOrigin', 'verticalOrigin', 'heightReference',
  'fillColor', 'outlineColor', 'outlineWidth', 'translucencyByDistance', 'pixelOffsetScaleByDistance',
  'scaleByDistance', 'distanceDisplayCondition', 'disableDepthTestDistance'];
type Graphics = PointGraphics | LabelGraphics;
interface PropertyCheckpoint { key: string; property: Property | undefined; value: unknown }
function captureGraphics(graphics: Graphics | undefined, keys: string[]): PropertyCheckpoint[] {
  if (!graphics) return [];
  const properties = graphics as unknown as Record<string, Property | undefined>;
  return keys.map(key => {
    const property = properties[key];
    return { key, property, value: property instanceof ConstantProperty ? property.getValue(checkpointTime) : undefined };
  });
}
function restoreGraphics(graphics: Graphics | undefined, checkpoint: PropertyCheckpoint[], step: (operation: () => void) => void) {
  if (!graphics) return;
  const properties = graphics as unknown as Record<string, Property | undefined>;
  for (const { key, property, value } of checkpoint) {
    if (properties[key] !== property) step(() => { properties[key] = property; });
    if (property instanceof ConstantProperty) step(() => property.setValue(value));
  }
}
function backup(entity: Entity) {
  if (!(entity.position instanceof ConstantPositionProperty)) throw new Error('Invalid owned vehicle position');
  return { entity, position: entity.position, value: entity.position.getValue(checkpointTime),
    point: entity.point, label: entity.label,
    pointValues: captureGraphics(entity.point, pointKeys), labelValues: captureGraphics(entity.label, labelKeys) };
}
interface Selection {
  entity: Entity;
  color: Color;
  width: number;
}
function outline(entity: Entity, color: Color, width: number, step: (operation: () => void) => void) {
  if (!(entity.point?.outlineColor instanceof ConstantProperty)
    || !(entity.point.outlineWidth instanceof ConstantProperty)) throw new Error('Invalid vehicle outline');
  const colorProperty = entity.point.outlineColor;
  const widthProperty = entity.point.outlineWidth;
  step(() => colorProperty.setValue(color));
  step(() => widthProperty.setValue(width));
}

export function createFleetEntities(entities: EntityCollection, isActive: () => boolean): FleetEntitiesHandle {
  let owned = new Map<string, Entity>();
  // Includes attempted insertions before add can synchronously throw or trigger teardown.
  const resources = new Set<Entity>();
  let destroyed = false;
  let destroying = false;
  let applying = false;
  let mutationFailed = false;
  let transactionActive: (() => boolean) | undefined;
  let selection: Selection | undefined;
  const active = () => !destroyed && isActive();
  const live = () => active() && (!transactionActive || transactionActive());
  const check = () => { if (!live()) throw new FleetRenderError('Fleet lifecycle ended during reconciliation', false); };
  const step = <T,>(operation: () => T): T => {
    check();
    const result = operation();
    check();
    return result;
  };
  // A throwing Cesium mutation may have interrupted collection notification dispatch.
  // Final membership/properties cannot certify that downstream Visualizers recovered.
  const mutate = <T,>(operation: () => T): T => step(() => {
    try { return operation(); }
    catch (error) { mutationFailed = true; throw error; }
  });
  const handle: FleetEntitiesHandle = {
    apply(snapshot, hooks) {
      if (!active() || !hooks.isActive()) return;
      if (applying) throw new FleetRenderError('Reentrant fleet transaction', true);
      applying = true;
      mutationFailed = false;
      transactionActive = () => hooks.isActive();
      const previous = new Map(owned);
      const previousSelection = selection;
      const backups: (ReturnType<typeof backup> & { attached: boolean })[] = [];
      const additions: Entity[] = [];
      const touched = new Set(previous.values());
      let checkpoint: ReturnType<typeof hooks.capture> | undefined;
      let captured = false;
      let began = false;
      try {
        const validated = parseFleetSnapshot(snapshot);
        if (!validated) throw new Error('Invalid fleet snapshot');
        const prepared = new Map<string, Entity>();
        for (const vehicle of validated.vehicles) {
          check();
          const present = entities.getById(vehicle.vehicle_id);
          if (present && present !== owned.get(vehicle.vehicle_id)) throw new Error('Fleet ID is externally owned');
          const temporary = new EntityCollection();
          const entity = step(() => upsertVehicleEntity(temporary, vehicle));
          const position = entity.position?.getValue(checkpointTime);
          if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) throw new Error('Invalid fleet position');
          step(() => temporary.remove(entity));
          prepared.set(entity.id, entity);
        }
        for (const entity of owned.values()) backups.push({ ...backup(entity), attached: entities.getById(entity.id) === entity });
        began = true;
        checkpoint = step(() => hooks.capture());
        captured = true;
        const staged = new Map<string, Entity>();
        for (const vehicle of validated.vehicles) {
          check();
          const existing = owned.get(vehicle.vehicle_id);
          if (existing && entities.getById(existing.id) === existing) {
            mutate(() => upsertVehicleEntity(entities, vehicle));
            if (entities.getById(existing.id) !== existing) throw new Error('Owned vehicle identity changed during update');
            staged.set(existing.id, existing);
          } else {
            const entity = prepared.get(vehicle.vehicle_id)!;
            additions.push(entity);
            touched.add(entity);
            resources.add(entity);
            mutate(() => entities.add(entity));
            if (entities.getById(entity.id) !== entity) throw new Error('Owned vehicle insertion was not retained');
            staged.set(entity.id, entity);
          }
        }
        for (const [id, entity] of previous) {
          check();
          if (staged.get(id) === entity) continue;
          step(() => hooks.beforeRemove(id, entity));
          if (selection?.entity === entity) handle.setSelected(null);
          check();
          if (entities.getById(id) === entity) mutate(() => entities.remove(entity));
          if (entities.getById(id) === entity) throw new Error('Removed vehicle remains attached');
        }
        check();
        owned = staged;
        step(() => hooks.afterReconcile(validated));
        // Later hooks can reattach an earlier removed original, so audit both sides of the package.
        for (const entity of touched) {
          const present = entities.getById(entity.id) === entity;
          if (present !== (staged.get(entity.id) === entity)) throw new Error('Fleet membership changed before commit');
        }
        for (const entity of touched) if (staged.get(entity.id) !== entity) resources.delete(entity);
      } catch (cause) {
        const errors: unknown[] = [];
        const attempt = (operation: () => void) => { try { operation(); } catch (error) { errors.push(error); } };
        // Once either lifecycle gate ends, restoring a removed entity would resurrect stale resources.
        if (!live()) {
          attempt(() => handle.destroy());
          throw new FleetRenderError('Fleet lifecycle ended; reconciliation was not restored', false,
            errors.length ? new AggregateError([cause, ...errors], 'Fleet termination cleanup failed', { cause }) : cause);
        }
        if (!began) throw new FleetRenderError('Fleet preparation failed', true, cause);
        if (!captured) errors.push(new Error('Controller checkpoint capture did not complete'));
        for (const entity of additions) {
          if (!live()) break;
          attempt(() => {
            if (entities.getById(entity.id) === entity) mutate(() => entities.remove(entity));
            check();
            if (entities.getById(entity.id) === entity) throw new Error('Added fleet entity remains attached');
          });
        }
        for (const saved of backups) {
          if (!live()) break;
          attempt(() => {
            const current = entities.getById(saved.entity.id);
            if (saved.attached && current && current !== saved.entity) throw new Error('External replacement prevents restoration');
            if (saved.entity.position !== saved.position) mutate(() => { saved.entity.position = saved.position; });
            mutate(() => saved.position.setValue(Cartesian3.clone(saved.value)));
            if (saved.entity.point !== saved.point) mutate(() => { saved.entity.point = saved.point; });
            if (saved.entity.label !== saved.label) mutate(() => { saved.entity.label = saved.label; });
            restoreGraphics(saved.point, saved.pointValues, mutate);
            restoreGraphics(saved.label, saved.labelValues, mutate);
            check();
            if (saved.attached && !entities.getById(saved.entity.id)) mutate(() => entities.add(saved.entity));
          });
        }
        if (live()) {
          owned = previous;
          selection = previousSelection;
          if (captured) attempt(() => step(() => hooks.restore(checkpoint!)));
          for (const saved of backups) {
            if (!live()) break;
            attempt(() => {
              if (saved.attached ? entities.getById(saved.entity.id) !== saved.entity : entities.getById(saved.entity.id) === saved.entity) {
                throw new Error('Fleet membership was not restored');
              }
              if (saved.entity.position !== saved.position || !Cartesian3.equals(saved.position.getValue(checkpointTime), saved.value)
                || saved.entity.point !== saved.point || saved.entity.label !== saved.label) {
                throw new Error('Fleet attributes were not restored');
              }
              for (const [graphics, values] of [[saved.point, saved.pointValues], [saved.label, saved.labelValues]] as const) {
                const properties = graphics as unknown as Record<string, Property | undefined> | undefined;
                for (const { key, property, value } of values) {
                  if (properties?.[key] !== property
                    || (property instanceof ConstantProperty && !property.equals(new ConstantProperty(value)))) {
                    throw new Error('Fleet graphics were not restored');
                  }
                }
              }
            });
          }
        }
        // Keep every attempted insertion recorded until all property and controller callbacks finish.
        if (live()) {
          for (const entity of additions) attempt(() => {
            if (entities.getById(entity.id) === entity) throw new Error('Rolled-back addition was reattached');
          });
          if (errors.length === 0) for (const entity of additions) resources.delete(entity);
        }
        if (!live()) {
          errors.push(new Error('Fleet lifecycle ended during rollback'));
          attempt(() => handle.destroy());
        }
        throw new FleetRenderError(mutationFailed
          ? 'Fleet reconciliation failed; Cesium notification recovery unconfirmed' : 'Fleet reconciliation failed',
          !mutationFailed && errors.length === 0,
          errors.length ? new AggregateError([cause, ...errors], 'Fleet reconciliation and rollback failed', { cause }) : cause);
      } finally {
        applying = false;
        transactionActive = undefined;
      }
    },
    getOwnedEntity(id) {
      const entity = owned.get(id);
      return live() && entity && entities.getById(id) === entity ? entity : undefined;
    },
    setSelected(id) {
      if (!live()) return;
      const target = id === null ? undefined : handle.getOwnedEntity(id);
      if (id !== null && !target) return;
      if (selection?.entity === target) return;
      if (selection && entities.getById(selection.entity.id) === selection.entity) outline(selection.entity, selection.color, selection.width, mutate);
      check();
      selection = undefined;
      if (target) {
        const color: Color = target.point!.outlineColor!.getValue(checkpointTime);
        const width: number = target.point!.outlineWidth!.getValue(checkpointTime);
        selection = { entity: target, color, width };
        outline(target, Color.CYAN, 3, mutate);
      }
    },
    destroy() {
      destroyed = true;
      if (destroying) return;
      destroying = true;
      const errors: unknown[] = [];
      try {
        const touched = [...resources];
        for (const entity of touched) {
          try {
            if (entities.getById(entity.id) === entity) entities.remove(entity);
          } catch (error) { errors.push(error); }
        }
        // A later removal listener can reattach an earlier object. Unregister only after every callback.
        for (const entity of touched) {
          try {
            if (entities.getById(entity.id) !== entity) resources.delete(entity);
            else errors.push(new Error(`Fleet resource release unconfirmed: ${entity.id}`));
          } catch (error) { errors.push(error); }
        }
        owned.clear();
        selection = undefined;
      } finally {
        destroying = false;
      }
      if (errors.length) throw new FleetRenderError('Fleet cleanup failed; resource release diagnostics attached', false,
        new AggregateError(errors, 'Fleet cleanup errors'));
    },
  };
  return handle;
}
