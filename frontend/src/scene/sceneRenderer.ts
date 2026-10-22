import { ArcType, Cartesian3, Color, Entity, PolygonHierarchy, type EntityCollection } from 'cesium';
import type { MineScene, SceneAreaFeature, SceneRoadFeature } from './sceneClient';

export class SceneRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SceneRenderError';
  }
}
export type SceneRenderHandle = { destroy(): void };

export function renderMineScene(entities: EntityCollection, scene: MineScene): SceneRenderHandle {
  const features = scene.features.features.filter(
    (feature): feature is SceneRoadFeature | SceneAreaFeature => feature.geometry.type !== 'Point',
  );
  if (features.some(feature => entities.getById(`scene:${scene.mine_id}:${feature.id}`))) {
    throw new SceneRenderError('scene already rendered');
  }
  const owned: Entity[] = [];
  const destroy = () => {
    const errors: unknown[] = [];
    for (const entity of owned) {
      // Cesium remove(Entity) removes by ID, so check the object before removing it.
      try { if (entities.getById(entity.id) === entity) entities.remove(entity); }
      catch (error) { errors.push(error); }
    }
    // Keep unresolved identities for an explicit cleanup retry; inspect after all callbacks.
    for (let index = owned.length - 1; index >= 0; index--) {
      try {
        if (entities.getById(owned[index].id) !== owned[index]) owned.splice(index, 1);
        else errors.push(new Error(`Scene resource release unconfirmed: ${owned[index].id}`));
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new SceneRenderError('Scene cleanup failed; resource release unconfirmed',
      { cause: new AggregateError(errors, 'Scene cleanup errors') });
  };
  try {
    for (const feature of features) {
      const id = `scene:${scene.mine_id}:${feature.id}`;
      let entity: Entity;
      if (feature.geometry.type === 'LineString') {
        entity = new Entity({ id, polyline: {
          positions: feature.geometry.coordinates.map(position => Cartesian3.fromDegrees(...position)),
          material: Color.LIGHTGRAY, width: 4, arcType: ArcType.NONE, clampToGround: false,
        } });
      } else {
        const ring = feature.geometry.coordinates[0];
        entity = feature.properties.kind === 'mine_boundary'
          ? new Entity({ id, polyline: {
            positions: ring.map(position => Cartesian3.fromDegrees(...position)),
            material: Color.SILVER.withAlpha(0.6), width: 2,
            arcType: ArcType.GEODESIC, granularity: 1e-6, clampToGround: false,
          } })
          : new Entity({ id, polygon: {
            hierarchy: new PolygonHierarchy(ring.slice(0, -1).map(position => Cartesian3.fromDegrees(...position))),
            material: feature.properties.kind === 'loading_area' ? Color.ORANGE.withAlpha(0.35)
              : feature.properties.kind === 'dumping_area' ? Color.ROYALBLUE.withAlpha(0.35)
                : Color.GRAY.withAlpha(0.30),
            perPositionHeight: true,
          } });
      }
      // Track before add: collection events can throw after the entity has been inserted.
      owned.push(entity);
      entities.add(entity);
    }
  } catch (cause) {
    try { destroy(); }
    catch (cleanupError) {
      throw new SceneRenderError('Unable to render mine scene; rollback release unconfirmed',
        { cause: new AggregateError([cause, cleanupError], 'Scene rendering and rollback failed', { cause }) });
    }
    throw new SceneRenderError('Unable to render mine scene', { cause });
  }
  return { destroy };
}
