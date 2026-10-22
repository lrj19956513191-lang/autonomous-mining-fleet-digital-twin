import { Entity, ScreenSpaceEventType, type Cartesian2, type Event, type Viewer } from 'cesium';
import type { FleetEntitiesHandle } from './fleetEntities';

export interface FleetInteractionCallbacks {
  onSelect(id: string | null): void;
  onInvalidTarget(id: string): void;
  isActive(): boolean;
}
export interface FleetInteractionHandle {
  select(id: string | null): void;
  beginBatch(): () => void;
  destroy(): void;
}

export function createFleetInteraction(viewer: Viewer, fleet: FleetEntitiesHandle,
  callbacks: FleetInteractionCallbacks): FleetInteractionHandle {
  let disposed = false;
  let destroying = false;
  let batchDepth = 0;
  let checking = false;
  let pending = false;
  // Resource identities only; selected/tracked UI state belongs to the controller.
  const identities = new Map<string, Entity>();
  // Notification provenance for the current unresolved association, not tracked UI state.
  let notifiedTracked: Entity | undefined;
  const input = viewer.screenSpaceEventHandler;
  type InputAction = ReturnType<typeof input.getInputAction>;
  const actions: { type: ScreenSpaceEventType; own: NonNullable<InputAction>; original: InputAction; released: boolean }[] = [];
  const listeners: { event: Event; listener: () => void; released: boolean }[] = [];
  const active = () => {
    if (disposed || !callbacks.isActive() || disposed) return false;
    const dead = viewer.isDestroyed();
    return !disposed && !dead;
  };
  const current = (id: string) => {
    if (!active()) return undefined;
    const entity = fleet.getOwnedEntity(id);
    if (!active()) return undefined;
    return entity && viewer.entities.getById(id) === entity ? entity : undefined;
  };
  const checkTargets = () => {
    // Disposal is checked before the transaction gate, including during synchronous callbacks.
    if (!active()) return;
    // Observe resolution/switch even when notifications are deferred by a batch or callback.
    if (viewer.trackedEntity !== notifiedTracked) notifiedTracked = undefined;
    if (!active()) return;
    pending = true;
    if (batchDepth || checking) return;
    checking = true;
    try {
      while (pending && active() && !batchDepth) {
        pending = false;
        const next = new Map<string, Entity>();
        for (const entity of [...viewer.entities.values]) {
          const owned = current(entity.id);
          if (!active()) return;
          if (owned === entity) next.set(entity.id, entity);
        }
        const invalid = [...identities].filter(([id, entity]) => next.get(id) !== entity).map(([id]) => id);
        for (const [id, entity] of next) if (!identities.has(id)) identities.set(id, entity);
        const tracked = viewer.trackedEntity;
        if (!active()) return;
        if (tracked && next.has(tracked.id) && next.get(tracked.id) !== tracked && notifiedTracked !== tracked) {
          // Mark notification only when its consumer is actually reached.
          if (!invalid.includes(tracked.id)) invalid.push(tracked.id);
        }
        for (const id of invalid) {
          if (!active() || batchDepth) return;
          const saved = identities.get(id);
          const owned = current(id);
          if (!active()) return;
          const identityLost = saved !== undefined && owned !== saved;
          const trackedLost = tracked?.id === id && viewer.trackedEntity === tracked
            && owned !== tracked && notifiedTracked !== tracked;
          if (!identityLost && !trackedLost) continue;
          if (identityLost) { identities.delete(id); pending = true; }
          if (trackedLost) notifiedTracked = tracked;
          callbacks.onInvalidTarget(id);
          if (!active()) return;
        }
      }
    } finally { checking = false; }
  };
  const handle: FleetInteractionHandle = {
    select(id) {
      if (!active() || batchDepth) return;
      if (id !== null && !current(id)) return;
      if (!active()) return;
      callbacks.onSelect(id);
      active();
    },
    beginBatch() {
      if (!active()) return () => {};
      batchDepth++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        batchDepth--;
        if (!active()) return;
        if (!batchDepth) checkTargets();
      };
    },
    destroy() {
      disposed = true;
      if (destroying) return;
      destroying = true;
      const errors: unknown[] = [];
      try {
        for (const action of actions) {
          if (action.released) continue;
          try {
            if (!viewer.isDestroyed() && input.getInputAction(action.type) === action.own) {
              if (action.original) input.setInputAction(action.original, action.type);
              else input.removeInputAction(action.type);
            }
            action.released = true;
          } catch (error) { errors.push(error); }
        }
        for (const resource of listeners) {
          if (resource.released) continue;
          try {
            resource.event.removeEventListener(resource.listener);
            resource.released = true;
          } catch (error) { errors.push(error); }
        }
        identities.clear();
        notifiedTracked = undefined;
      } finally { destroying = false; }
      if (errors.length) throw new AggregateError(errors, 'Fleet interaction cleanup failed');
    },
  };
  const click = (event: { position: Cartesian2 }) => {
    if (!active() || batchDepth) return;
    const picked: unknown = viewer.scene.pick(event.position);
    if (!active()) return;
    if (picked == null) { handle.select(null); return; }
    const entity = (picked as { id?: unknown }).id;
    if (!(entity instanceof Entity) || current(entity.id) !== entity || !active()) return;
    handle.select(entity.id);
  };
  try {
    checkTargets();
    for (const [type, own] of [[ScreenSpaceEventType.LEFT_CLICK, click],
      [ScreenSpaceEventType.LEFT_DOUBLE_CLICK, () => {}]] as const) {
      if (!active()) break;
      const original = input.getInputAction(type);
      if (!active()) break;
      // Record before setters/listeners that can synchronously end or throw after mutating.
      actions.push({ type, own, original, released: false });
      input.setInputAction(own, type);
      if (!active()) break;
    }
    for (const event of [viewer.entities.collectionChanged, viewer.trackedEntityChanged]) {
      if (!active()) break;
      const resource = { event, listener: checkTargets, released: false };
      listeners.push(resource);
      event.addEventListener(resource.listener);
      if (!active()) break;
    }
    if (!active()) handle.destroy();
  } catch (cause) {
    try { handle.destroy(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Fleet interaction setup and cleanup failed', { cause }); }
    throw cause;
  }
  return handle;
}
