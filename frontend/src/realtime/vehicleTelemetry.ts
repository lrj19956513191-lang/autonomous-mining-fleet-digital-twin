import { isFiniteNumber, isValidUtcTimestamp } from './telemetryGuards';

export interface VehicleTelemetry {
  vehicle_id: string;
  timestamp: string;
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  speed: number;
  soc: number;
  load: number;
  status: string;
}

export function parseVehicleTelemetry(input: unknown): VehicleTelemetry | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const {
    vehicle_id, timestamp, longitude, latitude, height, heading, speed, soc, load, status,
  } = input as Record<string, unknown>;
  if (vehicle_id !== 'TRUCK_001' || !isValidUtcTimestamp(timestamp)
    || typeof status !== 'string' || status.trim() === '') {
    return null;
  }
  if (!isFiniteNumber(longitude) || !isFiniteNumber(latitude) || !isFiniteNumber(height)
    || !isFiniteNumber(heading) || !isFiniteNumber(speed)
    || !isFiniteNumber(soc) || !isFiniteNumber(load)) {
    return null;
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
    || heading < 0 || heading >= 360 || speed < 0 || soc < 0 || soc > 100) {
    return null;
  }
  return {
    vehicle_id,
    timestamp,
    longitude,
    latitude,
    height,
    heading,
    speed,
    soc,
    load,
    status,
  };
}
