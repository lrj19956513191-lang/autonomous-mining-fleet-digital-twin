import { expect, test } from 'vitest';
import {
  Cartesian2, Cartesian3, Cartographic, Color, ConstantPositionProperty, Ellipsoid, EntityCollection,
  JulianDate, Math as CesiumMath, ReferenceFrame,
} from 'cesium';
import type { VehicleTelemetry } from '../realtime/vehicleTelemetry';
import { upsertVehicleEntity } from './vehicleEntity';

function makeTelemetry(): VehicleTelemetry {
  return {
    vehicle_id: 'TRUCK_001',
    timestamp: '2026-10-01T13:18:02.936773+00:00',
    longitude: 116.42540000000118,
    latitude: 39.917700000000586,
    height: 50,
    heading: 45,
    speed: 25,
    soc: 54.600000000001344,
    load: 65,
    status: 'running',
  };
}

test('creates one vehicle entity in the supplied collection', () => {
  const entities = new EntityCollection();
  const entity = upsertVehicleEntity(entities, makeTelemetry());

  expect(entities.values).toHaveLength(1);
  expect(entity.id).toBe('TRUCK_001');
  expect(entities.getById('TRUCK_001')).toBe(entity);
});

test('creates a visible yellow point with a black outline', () => {
  const entity = upsertVehicleEntity(new EntityCollection(), makeTelemetry());
  expect(entity.point).toBeDefined();
  expect(entity.point?.pixelSize?.getValue(time)).toBe(12);
  expect(entity.point?.color?.getValue(time)).toEqual(Color.YELLOW);
  expect(entity.point?.outlineWidth?.getValue(time)).toBe(2);
  expect(entity.point?.outlineColor?.getValue(time)).toEqual(Color.BLACK);
});

const time = JulianDate.fromIso8601('2026-10-01T13:18:02Z');

test('creates an identity label sixteen pixels above the point', () => {
  const entity = upsertVehicleEntity(new EntityCollection(), makeTelemetry());
  expect(entity.label).toBeDefined();
  expect(entity.label?.text?.getValue(time)).toBe('TRUCK_001');
  expect(entity.label?.pixelOffset?.getValue(time)).toEqual(new Cartesian2(0, -16));
});

test('maps WGS84 degrees and ellipsoid height to a fixed constant position', () => {
  const telemetry = makeTelemetry();
  const entity = upsertVehicleEntity(new EntityCollection(), telemetry);

  expect(entity.position).toBeInstanceOf(ConstantPositionProperty);
  expect(entity.position?.referenceFrame).toBe(ReferenceFrame.FIXED);
  const position = entity.position?.getValue(time);
  expect(position).toBeDefined();
  if (!position) throw new Error('Expected vehicle position');
  const cartographic = Cartographic.fromCartesian(position);
  expect(Math.abs(CesiumMath.toDegrees(cartographic.longitude) - telemetry.longitude)).toBeLessThanOrEqual(1e-8);
  expect(Math.abs(CesiumMath.toDegrees(cartographic.latitude) - telemetry.latitude)).toBeLessThanOrEqual(1e-8);
  expect(Math.abs(cartographic.height - telemetry.height)).toBeLessThanOrEqual(1e-3);
});

test('maps zero longitude latitude and height to the WGS84 equatorial radius', () => {
  const entity = upsertVehicleEntity(new EntityCollection(), {
    ...makeTelemetry(), longitude: 0, latitude: 0, height: 0,
  });
  const position = entity.position?.getValue(time);
  expect(position).toBeDefined();
  if (!position) throw new Error('Expected vehicle position');
  expect(Cartesian3.equalsEpsilon(position, new Cartesian3(Ellipsoid.WGS84.maximumRadius, 0, 0), 0, 1e-3)).toBe(true);
});

test('reuses the same entity for later telemetry without duplicates', () => {
  const entities = new EntityCollection();
  const telemetry = makeTelemetry();
  const first = upsertVehicleEntity(entities, telemetry);
  const second = upsertVehicleEntity(entities, {
    ...telemetry, longitude: telemetry.longitude + 0.0001,
    latitude: telemetry.latitude + 0.00005,
  });
  expect(second).toBe(first);
  expect(entities.values).toHaveLength(1);
});

test('updates the existing position property to later longitude latitude and height', () => {
  const entities = new EntityCollection();
  const telemetry = makeTelemetry();
  const first = upsertVehicleEntity(entities, telemetry);
  const originalPositionProperty = first.position;
  const originalPosition = first.position?.getValue(time);
  const updated = {
    ...telemetry, longitude: telemetry.longitude + 0.0001,
    latitude: telemetry.latitude + 0.00005, height: 51,
  };
  const second = upsertVehicleEntity(entities, updated);
  expect(second).toBe(first);
  expect(second.position).toBe(originalPositionProperty);
  expect(entities.values).toHaveLength(1);
  const position = second.position?.getValue(time);
  if (!position) throw new Error('Expected updated vehicle position');
  const cartographic = Cartographic.fromCartesian(position);
  expect(CesiumMath.toDegrees(cartographic.longitude)).toBeCloseTo(updated.longitude, 8);
  expect(CesiumMath.toDegrees(cartographic.latitude)).toBeCloseTo(updated.latitude, 8);
  expect(cartographic.height).toBeCloseTo(updated.height, 3);
  expect(Cartesian3.equals(position, originalPosition)).toBe(false);
});

test('repeated snapshots preserve one entity and its position point and label objects', () => {
  const entities = new EntityCollection();
  const telemetry = makeTelemetry();
  const first = upsertVehicleEntity(entities, telemetry);
  const positionProperty = first.position;
  const point = first.point;
  const label = first.label;
  const updated = { ...telemetry, longitude: telemetry.longitude + 0.0001 };
  upsertVehicleEntity(entities, updated);
  const repeated = upsertVehicleEntity(entities, updated);

  expect(repeated).toBe(first);
  expect(entities.values).toHaveLength(1);
  expect(repeated.position).toBe(positionProperty);
  expect(repeated.point).toBe(point);
  expect(repeated.label).toBe(label);
});

// Catches missing/infinite depth overrides and replacing point/label depth properties on updates.
test('vehicle_point_and_label_have_finite_depth_threshold', () => {
  const entities = new EntityCollection();
  const telemetry = makeTelemetry();
  const entity = upsertVehicleEntity(entities, telemetry);
  const pointDepth = entity.point?.disableDepthTestDistance;
  const labelDepth = entity.label?.disableDepthTestDistance;
  expect(pointDepth?.getValue(time)).toBe(2000);
  expect(labelDepth?.getValue(time)).toBe(2000);
  expect(Number.isFinite(pointDepth?.getValue(time))).toBe(true);
  expect(Number.isFinite(labelDepth?.getValue(time))).toBe(true);
  const updated = upsertVehicleEntity(entities, { ...telemetry, height: 56 });
  expect(updated).toBe(entity);
  expect(updated.point?.disableDepthTestDistance).toBe(pointDepth);
  expect(updated.label?.disableDepthTestDistance).toBe(labelDepth);
  expect(updated.point?.disableDepthTestDistance?.getValue(time)).toBe(2000);
  expect(updated.label?.disableDepthTestDistance?.getValue(time)).toBe(2000);
});
