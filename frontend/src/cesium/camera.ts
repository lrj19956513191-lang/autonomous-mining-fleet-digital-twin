import { Cartesian3, type Viewer } from 'cesium';
import type { VehicleTelemetry } from '../realtime/vehicleTelemetry';

export function focusVehicle(viewer: Viewer, telemetry: VehicleTelemetry): void {
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(
      telemetry.longitude, telemetry.latitude, telemetry.height + 1000,
    ),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}
