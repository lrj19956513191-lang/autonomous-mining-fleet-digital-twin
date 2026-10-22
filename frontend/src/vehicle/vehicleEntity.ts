import { Cartesian2, Cartesian3, Color, ConstantPositionProperty, Entity, type EntityCollection } from 'cesium';
import type { VehicleTelemetry } from '../realtime/vehicleTelemetry';

export function upsertVehicleEntity(
  entities: EntityCollection,
  telemetry: VehicleTelemetry,
): Entity {
  const position = Cartesian3.fromDegrees(
    telemetry.longitude, telemetry.latitude, telemetry.height,
  );
  const existing = entities.getById(telemetry.vehicle_id);
  if (existing) {
    if (!(existing.position instanceof ConstantPositionProperty)) {
      throw new Error('Vehicle position must remain a ConstantPositionProperty');
    }
    existing.position.setValue(position);
    return existing;
  }
  return entities.add(new Entity({
    id: telemetry.vehicle_id,
    position: new ConstantPositionProperty(position),
    point: {
      pixelSize: 12, color: Color.YELLOW, outlineWidth: 2, outlineColor: Color.BLACK,
      disableDepthTestDistance: 2000,
    },
    label: { text: telemetry.vehicle_id, pixelOffset: new Cartesian2(0, -16), disableDepthTestDistance: 2000 },
  }));
}
