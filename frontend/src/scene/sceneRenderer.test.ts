import { expect, test, vi } from 'vitest';
import { ArcType, Cartesian3, Cartographic, Color, Entity, EntityCollection, JulianDate, PolygonHierarchy } from 'cesium';
import { parseMineScene, type MineScene, type SceneAreaFeature } from './sceneClient';
import { makeSceneInput } from './sceneFixtures';
import { upsertVehicleEntity } from '../vehicle/vehicleEntity';
import { renderMineScene, SceneRenderError } from './sceneRenderer';

function makeScene(): MineScene {
  const scene = parseMineScene(makeSceneInput());
  if (!scene) throw new Error('Expected valid source scene');
  return scene;
}

function addVehicle(entities: EntityCollection) {
  return upsertVehicleEntity(entities, {
    vehicle_id: 'TRUCK_001', timestamp: '2026-10-01T13:18:02+00:00',
    longitude: 116.4254, latitude: 39.9177, height: 50,
    heading: 45, speed: 25, soc: 55, load: 65, status: 'running',
  });
}

const sceneIds = [
  'ROAD_001', 'ROAD_002', 'ROAD_003', 'ROAD_004', 'ROAD_005',
  'ROAD_006', 'ROAD_007', 'ROAD_008', 'ROAD_009', 'MINE_BOUNDARY',
  'AREA_LOADING', 'AREA_DUMPING', 'AREA_FACILITY',
].map(id => `scene:DEMO_MINE:${id}`);

// Catches extra node/route/vehicle creation, omitted features and overwritten vehicles.
test('renders_thirteen_scene_entities', () => {
  const entities = new EntityCollection();
  const vehicle = addVehicle(entities);
  renderMineScene(entities, makeScene());
  expect(entities.values).toHaveLength(14);
  expect(entities.values.filter(entity => entity.id !== 'TRUCK_001').map(entity => entity.id).sort())
    .toEqual([...sceneIds].sort());
  expect(entities.getById('TRUCK_001')).toBe(vehicle);
  for (const id of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8']) {
    expect(entities.getById(id)).toBeUndefined();
    expect(entities.getById(`scene:DEMO_MINE:${id}`)).toBeUndefined();
  }
});

const time = JulianDate.fromIso8601('2026-10-01T13:18:02Z');

test('static_cleanup_notification_throw_still_attempts_all_owned_removals', () => {
  const entities = new EntityCollection(); const vehicle = addVehicle(entities);
  const handle = renderMineScene(entities, makeScene());
  const cause = new Error('STATIC_REMOVE_NOTIFICATION_ONCE'); let failed = false;
  entities.collectionChanged.addEventListener((_collection, _added, removed) => {
    if (!failed && removed.some(entity => entity.id.startsWith('scene:'))) { failed = true; throw cause; }
  });
  let failure: unknown;
  try { handle.destroy(); } catch (error) { failure = error; }
  expect(failed).toBe(true); expect(entities.values).toEqual([vehicle]);
  expect(failure).toBeInstanceOf(SceneRenderError);
  expect((failure as Error).message).toContain('unconfirmed');
  expect(((failure as Error).cause as AggregateError).errors).toContain(cause);
  expect(() => handle.destroy()).not.toThrow(); expect(entities.values).toEqual([vehicle]);
});

test('static_rollback_preserves_primary_cause_and_attempts_remaining_removals', () => {
  const entities = new EntityCollection(); const vehicle = addVehicle(entities);
  const primary = new Error('STATIC_ADD_NOTIFICATION_ONCE'); const cleanup = new Error('rollback remove unavailable');
  let adds = 0;
  entities.collectionChanged.addEventListener((_collection, added) => {
    if (added.some(entity => entity.id.startsWith('scene:')) && ++adds === 4) throw primary;
  });
  const remove = entities.remove.bind(entities); const attempts: Entity[] = [];
  const spy = vi.spyOn(entities, 'remove').mockImplementation(entity => {
    attempts.push(entity!); if (attempts.length === 1) throw cleanup; return remove(entity);
  });
  let failure: unknown;
  try { renderMineScene(entities, makeScene()); } catch (error) { failure = error; } finally { spy.mockRestore(); }
  expect(attempts).toHaveLength(4);
  expect(entities.values).toEqual([vehicle, attempts[0]]);
  expect(failure).toBeInstanceOf(SceneRenderError);
  const combined = (failure as Error).cause as AggregateError;
  expect(combined).toBeInstanceOf(AggregateError); expect(combined.cause).toBe(primary);
  expect(combined.errors[0]).toBe(primary);
  expect((combined.errors[1] as Error).message).toContain('unconfirmed');
  expect(((combined.errors[1] as Error).cause as AggregateError).errors).toContain(cleanup);
});

// Catches dropped/reordered supplied vertices, height offsets, geodesic regeneration and ground clamp.
test('renders_shared_road_positions_and_style', () => {
  const entities = new EntityCollection();
  const scene = makeScene();
  const road1 = scene.features.features.find(feature => feature.id === 'ROAD_001');
  if (!road1 || road1.geometry.type !== 'LineString') throw new Error('Expected ROAD_001');
  road1.geometry.coordinates.splice(1, 0, [116.3901, 39.89998, 50.05]);
  renderMineScene(entities, scene);
  const roads = scene.features.features.filter(feature => feature.geometry.type === 'LineString');
  expect(roads).toHaveLength(9);
  for (const road of roads) {
    if (road.geometry.type !== 'LineString') throw new Error('Expected road geometry');
    const polyline = entities.getById(`scene:DEMO_MINE:${road.id}`)?.polyline;
    expect(polyline).toBeDefined();
    const positions: Cartesian3[] = polyline!.positions!.getValue(time);
    expect(positions).toHaveLength(road.geometry.coordinates.length);
    road.geometry.coordinates.forEach((position, index) => {
      expect(positions[index]).toEqual(Cartesian3.fromDegrees(...position));
    });
    expect(polyline!.material?.getValue(time).color).toEqual(Color.LIGHTGRAY);
    expect(polyline!.width?.getValue(time)).toBe(4);
    expect(polyline!.arcType?.getValue(time)).toBe(ArcType.NONE);
    expect(polyline!.clampToGround?.getValue(time)).toBe(false);
  }
  const firstEnd: Cartesian3[] = entities.getById('scene:DEMO_MINE:ROAD_001')!.polyline!.positions!.getValue(time);
  const nextStart: Cartesian3[] = entities.getById('scene:DEMO_MINE:ROAD_002')!.polyline!.positions!.getValue(time);
  expect(firstEnd.at(-1)).toEqual(nextStart[0]);
});

// Catches incorrect boundary interpolation, polygon closure/fill and lost ellipsoid heights.
test('renders_boundary_and_area_heights', () => {
  const entities = new EntityCollection();
  const scene = makeScene();
  renderMineScene(entities, scene);
  const boundary = entities.getById('scene:DEMO_MINE:MINE_BOUNDARY')!;
  const line = boundary.polyline!;
  expect(boundary.polygon).toBeUndefined();
  expect(line.material?.getValue(time).color).toEqual(Color.SILVER.withAlpha(0.6));
  expect(line.width?.getValue(time)).toBe(2);
  expect(line.arcType?.getValue(time)).toBe(ArcType.GEODESIC);
  expect(line.granularity?.getValue(time)).toBe(1e-6);
  expect(line.clampToGround?.getValue(time)).toBe(false);
  const areaColors = {
    AREA_LOADING: Color.ORANGE.withAlpha(0.35),
    AREA_DUMPING: Color.ROYALBLUE.withAlpha(0.35),
    AREA_FACILITY: Color.GRAY.withAlpha(0.30),
  };
  const polygons = scene.features.features.filter(
    (feature): feature is SceneAreaFeature => feature.geometry.type === 'Polygon',
  );
  for (const feature of polygons) {
    const ring = feature.geometry.coordinates[0];
    let positions: Cartesian3[];
    if (feature.id === 'MINE_BOUNDARY') {
      positions = line.positions!.getValue(time);
      expect(positions).toHaveLength(5);
      expect(positions[0]).toEqual(positions.at(-1));
    } else {
      const entity = entities.getById(`scene:DEMO_MINE:${feature.id}`)!;
      expect(entity.polyline).toBeUndefined();
      const polygon = entity.polygon!;
      const hierarchy: PolygonHierarchy = polygon.hierarchy!.getValue(time);
      expect(hierarchy).toBeInstanceOf(PolygonHierarchy);
      expect(hierarchy.holes).toHaveLength(0);
      positions = hierarchy.positions;
      expect(positions).toHaveLength(4);
      expect(positions[0]).not.toEqual(positions.at(-1));
      expect(polygon.material?.getValue(time).color).toEqual(areaColors[feature.id]);
      expect(polygon.perPositionHeight?.getValue(time)).toBe(true);
      expect(polygon.height).toBeUndefined();
      expect(polygon.extrudedHeight).toBeUndefined();
      expect(polygon.heightReference).toBeUndefined();
      expect(polygon.extrudedHeightReference).toBeUndefined();
    }
    positions.forEach((position, index) => {
      expect(position).toEqual(Cartesian3.fromDegrees(...ring[index]));
      expect(Cartographic.fromCartesian(position).height).toBeCloseTo(45, 6);
    });
  }
});

// Catches partial overwrite on repeated loads and loss of the first handle's ownership.
test('rejects_duplicate_scene_before_any_add', () => {
  const entities = new EntityCollection();
  const vehicle = addVehicle(entities);
  const handle = renderMineScene(entities, makeScene());
  const original = [...entities.values];
  const additions: Entity[] = [];
  entities.collectionChanged.addEventListener((_collection, added) => additions.push(...added));
  expect(() => renderMineScene(entities, makeScene())).toThrowError(SceneRenderError);
  expect(() => renderMineScene(entities, makeScene())).toThrowError(
    new SceneRenderError('scene already rendered'),
  );
  expect(additions).toHaveLength(0);
  expect(entities.values).toHaveLength(14);
  original.forEach(entity => expect(entities.getById(entity.id)).toBe(entity));
  handle.destroy();
  expect(entities.values).toEqual([vehicle]);
});

// Occupying even the last planned ID must fail before any real collection insertion.
test.each(sceneIds)('rejects_duplicate_scene_before_any_add: preoccupied %s', id => {
  const entities = new EntityCollection();
  const vehicle = addVehicle(entities);
  const external = entities.add(new Entity({ id }));
  const additions: Entity[] = [];
  entities.collectionChanged.addEventListener((_collection, added) => additions.push(...added));
  expect(() => renderMineScene(entities, makeScene())).toThrowError(SceneRenderError);
  expect(() => renderMineScene(entities, makeScene())).toThrowError(
    new SceneRenderError('scene already rendered'),
  );
  expect(additions).toHaveLength(0);
  expect(entities.values).toHaveLength(2);
  expect(entities.getById('TRUCK_001')).toBe(vehicle);
  expect(entities.getById(id)).toBe(external);
});

// Catches leaking earlier adds and the fourth entity when add inserts before throwing.
test.each(['before insertion', 'after insertion'] as const)(
  'rolls_back_only_current_entities: fourth add fails %s', phase => {
    const entities = new EntityCollection();
    const vehicle = addVehicle(entities);
    const external = entities.add(new Entity({ id: 'external-survey' }));
    const cause = new Error(`Fourth add failed ${phase}`);
    const constructed: Entity[] = [];
    const inserted: Entity[] = [];
    entities.collectionChanged.addEventListener((_collection, added) => inserted.push(...added));
    const realAdd = entities.add.bind(entities);
    let atFailure: Entity[] = [];
    const add = vi.spyOn(entities, 'add').mockImplementation(entity => {
      if (!(entity instanceof Entity)) throw new Error('Renderer must construct entities before adding');
      constructed.push(entity);
      if (constructed.length === 4) {
        if (phase === 'after insertion') realAdd(entity);
        atFailure = [...entities.values];
        throw cause;
      }
      return realAdd(entity);
    });
    let failure: unknown;
    try {
      renderMineScene(entities, makeScene());
    } catch (error) {
      failure = error;
    } finally {
      add.mockRestore();
    }
    expect(constructed).toHaveLength(4);
    expect(inserted).toHaveLength(phase === 'after insertion' ? 4 : 3);
    inserted.forEach((entity, index) => expect(entity).toBe(constructed[index]));
    expect(atFailure).toHaveLength(phase === 'after insertion' ? 6 : 5);
    expect(atFailure.includes(constructed[3])).toBe(phase === 'after insertion');
    expect(entities.values).toHaveLength(2);
    expect(entities.getById(vehicle.id)).toBe(vehicle);
    expect(entities.getById(external.id)).toBe(external);
    constructed.forEach(entity => expect(entities.getById(entity.id)).toBeUndefined());
    expect(failure).toBeInstanceOf(SceneRenderError);
    expect((failure as SceneRenderError).cause).toBe(cause);
    const retry = renderMineScene(entities, makeScene());
    expect(entities.values).toHaveLength(15);
    retry.destroy();
    expect(entities.values).toEqual([vehicle, external]);
  },
);

// Catches duplicate cleanup side effects and accumulated entities after rebuilding.
test('destroys_owned_entities_idempotently', () => {
  const entities = new EntityCollection();
  const vehicle = addVehicle(entities);
  const external = entities.add(new Entity({ id: 'external-survey' }));
  const handle = renderMineScene(entities, makeScene());
  handle.destroy();
  handle.destroy();
  expect(entities.values).toEqual([vehicle, external]);
  const rebuilt = renderMineScene(entities, makeScene());
  expect(entities.values).toHaveLength(15);
  expect(entities.getById(vehicle.id)).toBe(vehicle);
  expect(entities.getById(external.id)).toBe(external);
  rebuilt.destroy();
  expect(entities.values).toEqual([vehicle, external]);
});

// Cesium remove(Entity) removes by ID: guard identity to preserve external replacements.
test('destroys_owned_entities_idempotently: preserves external deletion and same-ID replacement', () => {
  const entities = new EntityCollection();
  const vehicle = addVehicle(entities);
  const external = entities.add(new Entity({ id: 'external-survey' }));
  const handle = renderMineScene(entities, makeScene());
  const replaced = entities.getById('scene:DEMO_MINE:ROAD_001')!;
  const deleted = entities.getById('scene:DEMO_MINE:AREA_LOADING')!;
  entities.remove(replaced);
  entities.remove(deleted);
  const replacement = entities.add(new Entity({ id: replaced.id }));
  expect(replacement).not.toBe(replaced);
  handle.destroy();
  handle.destroy();
  expect(entities.values).toHaveLength(3);
  expect(entities.getById(vehicle.id)).toBe(vehicle);
  expect(entities.getById(external.id)).toBe(external);
  expect(entities.getById(replaced.id)).toBe(replacement);
  expect(entities.getById(deleted.id)).toBeUndefined();
});

// A stale handle must not acquire ownership of a later render's objects under the same IDs.
test('destroys_owned_entities_idempotently: old handle preserves a new render', () => {
  const entities = new EntityCollection();
  const vehicle = addVehicle(entities);
  const old = renderMineScene(entities, makeScene());
  const oldRoad = entities.getById('scene:DEMO_MINE:ROAD_001');
  old.destroy();
  const current = renderMineScene(entities, makeScene());
  const rebuilt = [...entities.values];
  expect(entities.getById('scene:DEMO_MINE:ROAD_001')).not.toBe(oldRoad);
  old.destroy();
  expect(entities.values).toHaveLength(14);
  rebuilt.forEach(entity => expect(entities.getById(entity.id)).toBe(entity));
  current.destroy();
  expect(entities.values).toEqual([vehicle]);
});
