import type { VehicleTelemetry } from './vehicleTelemetry';
import { isFiniteNumber, isValidUtcTimestamp } from './telemetryGuards';

export type FleetVehicleTelemetry = Readonly<VehicleTelemetry> & {
  readonly status: 'running' | 'stopped';
};

export interface FleetSnapshot {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly simulation_time_seconds: number;
  readonly vehicles: readonly FleetVehicleTelemetry[];
}

const snapshotKeys = [
  'schema_version', 'session_id', 'sequence', 'timestamp', 'simulation_time_seconds', 'vehicles',
];
const vehicleKeys = [
  'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height', 'heading', 'speed', 'soc', 'load', 'status',
];

function hasExactKeys(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && Reflect.ownKeys(input).length === keys.length
    && keys.every((key) => Object.hasOwn(input, key));
}

function matchesEntireString(value: unknown, pattern: RegExp): value is string {
  if (typeof value !== 'string') return false;
  return pattern.exec(value)?.[0].length === value.length;
}

function parseFleetVehicle(input: unknown, snapshotTimestamp: string): FleetVehicleTelemetry | null {
  if (!hasExactKeys(input, vehicleKeys)) return null;
  const { vehicle_id, timestamp, longitude, latitude, height, heading, speed, soc, load, status } = input;
  if (!matchesEntireString(vehicle_id, /^TRUCK_[0-9]{3}$/)
    || timestamp !== snapshotTimestamp || (status !== 'running' && status !== 'stopped')
    || !isFiniteNumber(longitude) || !isFiniteNumber(latitude) || !isFiniteNumber(height)
    || !isFiniteNumber(heading) || !isFiniteNumber(speed) || !isFiniteNumber(soc) || !isFiniteNumber(load)
    || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
    || heading < 0 || heading >= 360 || speed < 0 || soc < 0 || soc > 100
    || (status === 'stopped' && speed !== 0)) return null;
  return Object.freeze({ vehicle_id, timestamp, longitude, latitude, height, heading, speed, soc, load, status });
}

export function parseFleetSnapshot(input: unknown): FleetSnapshot | null {
  if (!hasExactKeys(input, snapshotKeys)) return null;
  const { schema_version, session_id, sequence, timestamp, simulation_time_seconds, vehicles } = input;
  if (schema_version !== 1
    || !matchesEntireString(session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    || !isFiniteNumber(sequence) || !Number.isSafeInteger(sequence) || sequence < 0
    || !isValidUtcTimestamp(timestamp) || !isFiniteNumber(simulation_time_seconds)
    || (sequence === 0 ? simulation_time_seconds !== 0 : simulation_time_seconds <= 0)
    || !Array.isArray(vehicles)) return null;

  const parsedVehicles: FleetVehicleTelemetry[] = [];
  const vehicleIds = new Set<string>();
  for (const candidate of vehicles) {
    const vehicle = parseFleetVehicle(candidate, timestamp);
    if (!vehicle || vehicleIds.has(vehicle.vehicle_id)) return null;
    vehicleIds.add(vehicle.vehicle_id);
    parsedVehicles.push(vehicle);
  }
  return Object.freeze({
    schema_version, session_id, sequence, timestamp, simulation_time_seconds,
    vehicles: Object.freeze(parsedVehicles),
  });
}

export function createFleetSnapshotGate(): { accept(snapshot: FleetSnapshot): boolean } {
  let baseline: Pick<FleetSnapshot, 'session_id' | 'sequence' | 'simulation_time_seconds'> | null = null;
  return {
    accept(snapshot) {
      const { session_id, sequence, simulation_time_seconds } = snapshot;
      if (!Number.isSafeInteger(sequence) || sequence < 0 || !isFiniteNumber(simulation_time_seconds)
        || (sequence === 0 ? simulation_time_seconds !== 0 : simulation_time_seconds <= 0)) return false;
      if (baseline && (session_id !== baseline.session_id || sequence <= baseline.sequence
        || simulation_time_seconds <= baseline.simulation_time_seconds)) return false;
      baseline = { session_id, sequence, simulation_time_seconds };
      return true;
    },
  };
}
