import { expect, test, vi } from 'vitest';
import { Cartesian3, Cartographic, Math as CesiumMath, type Viewer } from 'cesium';
import type { VehicleTelemetry } from '../realtime/vehicleTelemetry';
import { focusVehicle } from './camera';

test('positions the camera above the vehicle with a downward view', () => {
  const setView = vi.fn<Viewer['camera']['setView']>();
  // Only the public camera boundary is exercised; no Viewer or WebGL is created.
  const viewer = { camera: { setView } } as unknown as Viewer;
  const telemetry: VehicleTelemetry = {
    vehicle_id: 'TRUCK_001', timestamp: '2026-10-01T13:18:02.936773+00:00',
    longitude: 116.4254, latitude: 39.9177, height: 50,
    heading: 45, speed: 25, soc: 54.6, load: 65, status: 'running',
  };
  focusVehicle(viewer, telemetry);
  expect(setView).toHaveBeenCalledTimes(1);
  const options = setView.mock.calls[0][0];
  expect(options?.destination).toBeInstanceOf(Cartesian3);
  if (!(options?.destination instanceof Cartesian3)) throw new Error('Expected Cartesian destination');
  const position = Cartographic.fromCartesian(options.destination);
  expect(CesiumMath.toDegrees(position.longitude)).toBeCloseTo(116.4254, 8);
  expect(CesiumMath.toDegrees(position.latitude)).toBeCloseTo(39.9177, 8);
  expect(position.height).toBeCloseTo(1050, 3);
  expect(options.orientation).toEqual({ heading: 0, pitch: -Math.PI / 2, roll: 0 });
});
