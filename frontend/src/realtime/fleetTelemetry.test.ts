import { expect, test } from 'vitest';
import { createFleetSnapshotGate, parseFleetSnapshot, type FleetSnapshot } from './fleetTelemetry';
import { makeFleetSnapshotFixture } from './fleetFixtures';

test('parses_full_fleet_profile_and_calendar', () => {
  const valid = makeFleetSnapshotFixture();
  const result = parseFleetSnapshot(valid);
  expect(result).toEqual(valid);
  expect(result?.vehicles).toHaveLength(3);
  expect(result).not.toBe(valid);
  expect(result?.vehicles).not.toBe(valid.vehicles);
  for (let index = 0; index < 3; index += 1) {
    expect(result?.vehicles[index]).not.toBe(valid.vehicles[index]);
    expect(Object.isFrozen(result?.vehicles[index])).toBe(true);
  }
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result?.vehicles)).toBe(true);
  expect(parseFleetSnapshot({ ...valid, vehicles: [] })?.vehicles).toEqual([]);
  expect(parseFleetSnapshot({ ...valid, sequence: 9007199254740991, simulation_time_seconds: 1 }))
    .not.toBeNull();
  expect(parseFleetSnapshot({ ...valid, sequence: 9007199254740992, simulation_time_seconds: 1 }))
    .toBeNull();
  expect(parseFleetSnapshot({ ...valid, vehicles: [valid.vehicles[0], valid.vehicles[0]] })).toBeNull();
  expect(parseFleetSnapshot({ ...valid, sequence: 0, simulation_time_seconds: 1 })).toBeNull();
  expect(parseFleetSnapshot({ ...valid, sequence: 1, simulation_time_seconds: 0 })).toBeNull();
  valid.vehicles[0].longitude = 0;
  valid.vehicles.pop();
  expect(result?.vehicles[0].longitude).toBe(116);
  expect(result?.vehicles).toHaveLength(3);
});

const validTimestamps = [
  '0001-01-01T00:00:00Z', '9999-12-31T23:59:59+00:00',
  '2000-02-29T23:59:59Z', '2024-02-29T00:00:00+00:00',
  ...['Z', '+00:00'].flatMap((zone) => ['', '.1', '.12', '.123', '.1234', '.12345', '.123456']
    .map((fraction) => `2026-10-14T04:00:00${fraction}${zone}`)),
];
test.each(validTimestamps)('profile preserves valid calendar timestamp %s', (timestamp) => {
  const input = makeFleetSnapshotFixture();
  input.timestamp = timestamp;
  input.vehicles.forEach((vehicle) => { vehicle.timestamp = timestamp; });
  expect(parseFleetSnapshot(input)?.timestamp).toBe(timestamp);
});

test.each([
  ['longitude', -180], ['longitude', 180], ['latitude', -90], ['latitude', 90],
  ['heading', 0], ['heading', 359.9], ['speed', 0], ['soc', 0], ['soc', 100],
  ['height', -10], ['load', -10],
] as const)('profile accepts permitted %s %s', (field, value) => {
  const input = makeFleetSnapshotFixture();
  input.vehicles[0][field] = value;
  expect(parseFleetSnapshot(input)?.vehicles[0][field]).toBe(value);
});

test('profile accepts stopped zero speed and full-match vehicle IDs', () => {
  const input = makeFleetSnapshotFixture();
  input.vehicles[0].status = 'stopped'; input.vehicles[0].speed = 0;
  input.vehicles[0].vehicle_id = 'TRUCK_000'; input.vehicles[1].vehicle_id = 'TRUCK_999';
  expect(parseFleetSnapshot(input)?.vehicles[0].status).toBe('stopped');
});

function expectProfileRejected(input: unknown) {
  expect(() => parseFleetSnapshot(input)).not.toThrow();
  expect(parseFleetSnapshot(input)).toBeNull();
}
const snapshotFields = ['schema_version', 'session_id', 'sequence', 'timestamp', 'simulation_time_seconds', 'vehicles'];
const vehicleFields = ['vehicle_id', 'timestamp', 'longitude', 'latitude', 'height', 'heading', 'speed', 'soc', 'load', 'status'];

test.each(snapshotFields)('profile rejects missing snapshot field %s', (field) => {
  const input: Record<string, unknown> = makeFleetSnapshotFixture();
  delete input[field]; expectProfileRejected(input);
});
test.each(vehicleFields)('profile rejects missing vehicle field %s throughout fleet', (field) => {
  for (const index of [0, 1, 2]) {
    const input = makeFleetSnapshotFixture();
    delete (input.vehicles[index] as Record<string, unknown>)[field];
    expectProfileRejected(input);
  }
});
test('profile rejects extra or inherited replacement keys', () => {
  const valid = makeFleetSnapshotFixture();
  expectProfileRejected({ ...valid, extra: true });
  for (const index of [0, 1, 2]) {
    const input = makeFleetSnapshotFixture();
    Object.assign(input.vehicles[index], { extra: true }); expectProfileRejected(input);
  }
  expectProfileRejected({ ...valid, [Symbol('extra')]: true });
  const inherited = Object.assign(Object.create({ sequence: 0 }), valid);
  delete inherited.sequence; expectProfileRejected(inherited);
});

test.each([null, undefined, true, 1, 'fleet', [], () => null])('profile rejects non-object input %j', (input) => {
  expectProfileRejected(input);
});
test.each([null, undefined, true, 1, 'vehicles', {}, [null], [1], [[]], Array(1)])(
  'profile rejects malformed vehicles %j', (vehicles) => {
    expectProfileRejected({ ...makeFleetSnapshotFixture(), vehicles });
  },
);
test.each([true, 0, 2, 1.1, '1', null, NaN, Infinity, {}])('profile rejects schema version %j', (schema_version) => {
  expectProfileRejected({ ...makeFleetSnapshotFixture(), schema_version });
});
test.each([
  '', null, 1, {}, '11111111-1111-1111-8111-111111111111',
  '11111111-1111-4111-7111-111111111111', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  '11111111111141118111111111111111', '11111111-1111-4111-8111-111111111111\n',
  ' 11111111-1111-4111-8111-111111111111',
])('profile rejects invalid session UUID %j', (session_id) => {
  expectProfileRejected({ ...makeFleetSnapshotFixture(), session_id });
});
test.each(['8', true, null, {}, NaN, Infinity, -Infinity, -1, 1.5, 9007199254740992])(
  'profile rejects invalid sequence %j', (sequence) => {
    expectProfileRejected({ ...makeFleetSnapshotFixture(), sequence, simulation_time_seconds: 1 });
  },
);
test.each(['0', true, null, {}, NaN, Infinity, -Infinity, -1])(
  'profile rejects invalid simulation clock %j', (simulation_time_seconds) => {
    expectProfileRejected({ ...makeFleetSnapshotFixture(), sequence: 1, simulation_time_seconds });
  },
);
const invalidTimestamps = [
  null, true, 1, {}, '', '2026-10-14', '2026-10-14T04:00:00',
  '2026-10-14T04:00:00+08:00', '2026-10-14T04:00:00-00:00',
  '0000-01-01T00:00:00Z', '10000-01-01T00:00:00Z',
  '1900-02-29T04:00:00Z', '2026-02-29T04:00:00Z', '2026-04-31T04:00:00Z',
  '2026-00-14T04:00:00Z', '2026-13-14T04:00:00Z',
  '2026-10-00T04:00:00Z', '2026-10-32T04:00:00Z',
  '2026-10-14T24:00:00Z', '2026-10-14T04:60:00Z', '2026-10-14T04:00:60Z',
  '2026-10-14T04:00:00.Z', '2026-10-14T04:00:00.1234567Z',
  '2026-10-14T04:00:00Z\n', '2026-10-14T04:00:00Z ',
];
test.each(invalidTimestamps)('profile rejects invalid calendar or timestamp form %j', (timestamp) => {
  const input = makeFleetSnapshotFixture();
  Object.assign(input, { timestamp });
  input.vehicles.forEach((vehicle) => { Object.assign(vehicle, { timestamp }); });
  expectProfileRejected(input);
});
test('profile requires exactly identical timestamp strings in every vehicle', () => {
  for (const index of [0, 1, 2]) {
    const input = makeFleetSnapshotFixture();
    input.vehicles[index].timestamp = '2026-10-14T04:00:00.000001Z';
    expectProfileRejected(input);
  }
});
const numericVehicleFields = ['longitude', 'latitude', 'height', 'heading', 'speed', 'soc', 'load'];
test.each(numericVehicleFields.flatMap((field) =>
  [null, true, '25', {}, [], NaN, Infinity, -Infinity].map((value) => ({ field, value })),
))('profile rejects non-finite or non-number vehicle $field: $value', ({ field, value }) => {
  const input = makeFleetSnapshotFixture();
  Object.assign(input.vehicles[2], { [field]: value }); expectProfileRejected(input);
});
test.each([
  ['longitude', -180.1], ['longitude', 180.1], ['latitude', -90.1], ['latitude', 90.1],
  ['heading', -1], ['heading', 360], ['speed', -1], ['soc', -1], ['soc', 100.1],
])('profile rejects out-of-range vehicle %s %s', (field, value) => {
  const input = makeFleetSnapshotFixture();
  Object.assign(input.vehicles[1], { [field]: value }); expectProfileRejected(input);
});
test.each([null, true, {}, '', 'TRUCK_01', 'TRUCK_0001', 'truck_001', 'TRUCK_001\n', ' TRUCK_001']) (
  'profile rejects malformed vehicle ID %j', (vehicle_id) => {
    const input = makeFleetSnapshotFixture();
    Object.assign(input.vehicles[0], { vehicle_id }); expectProfileRejected(input);
  },
);
test.each([null, true, {}, '', ' running ', 'RUNNING', 'faulted'])('profile rejects vehicle status %j', (status) => {
  const input = makeFleetSnapshotFixture();
  Object.assign(input.vehicles[0], { status }); expectProfileRejected(input);
});
test('profile rejects stopped vehicles with positive speed and accepts frozen input', () => {
  const input = makeFleetSnapshotFixture(); input.vehicles[1].status = 'stopped';
  expectProfileRejected(input);
  input.vehicles[1].speed = 0;
  input.vehicles.forEach(Object.freeze); Object.freeze(input.vehicles); Object.freeze(input);
  expect(parseFleetSnapshot(input)).toEqual(input);
});

function snapshotAt(sequence: number, time: number, session_id = '11111111-1111-4111-8111-111111111111') {
  const parsed = parseFleetSnapshot({ ...makeFleetSnapshotFixture(), session_id, sequence, simulation_time_seconds: time });
  expect(parsed).not.toBeNull();
  return parsed!;
}

test('session_sequence_gate_is_connection_local', () => {
  const gate = createFleetSnapshotGate();
  expect(gate.accept(snapshotAt(5, 2))).toBe(true);
  expect(gate.accept(snapshotAt(9, 3))).toBe(true);
  const otherSession = snapshotAt(0, 0, '22222222-2222-4222-a222-222222222222');
  expect(gate.accept(otherSession)).toBe(false);
  const nextConnection = createFleetSnapshotGate();
  expect(nextConnection.accept(otherSession)).toBe(true);
  expect(nextConnection.accept(snapshotAt(1, 1, otherSession.session_id))).toBe(true);
  expect(gate.accept(snapshotAt(10, 4))).toBe(true);
});

test.each([
  { sequence: 1, simulation_time_seconds: 0 },
  { sequence: 0, simulation_time_seconds: 1 },
])('gate rejects invalid first clock without establishing baseline: %j', (clock) => {
  const gate = createFleetSnapshotGate();
  expect(gate.accept({ ...snapshotAt(0, 0), ...clock })).toBe(false);
  expect(gate.accept(snapshotAt(0, 0, '22222222-2222-4222-9222-222222222222'))).toBe(true);
});

test.each([
  { sequence: 5, time: 5 }, { sequence: 4, time: 6 }, { sequence: 5, time: 6 },
  { sequence: 6, time: 5 }, { sequence: 8, time: 4 },
])('gate rejects duplicate or backwards clock without poisoning baseline: %j', ({ sequence, time }) => {
  const gate = createFleetSnapshotGate();
  expect(gate.accept(snapshotAt(5, 5))).toBe(true);
  expect(gate.accept(snapshotAt(sequence, time))).toBe(false);
  expect(gate.accept(snapshotAt(6, 6))).toBe(true);
});

test('gate validates clock relationship after baseline and allows UTC to move backwards', () => {
  const gate = createFleetSnapshotGate();
  expect(gate.accept(snapshotAt(0, 0))).toBe(true);
  expect(gate.accept({ ...snapshotAt(0, 0), sequence: 1 })).toBe(false);
  const input = makeFleetSnapshotFixture();
  input.sequence = 1; input.simulation_time_seconds = 0.5;
  input.timestamp = '0001-01-01T00:00:00Z';
  input.vehicles.forEach((vehicle) => { vehicle.timestamp = input.timestamp; });
  const earlierUtc = parseFleetSnapshot(input)!;
  expect(gate.accept(earlierUtc)).toBe(true);
  expect(gate.accept({ ...earlierUtc, sequence: 0, simulation_time_seconds: 1 })).toBe(false);
  expect(gate.accept(snapshotAt(2, 1))).toBe(true);
});

test('gate and frozen snapshots resist external mutation', () => {
  const gate = createFleetSnapshotGate();
  const input = makeFleetSnapshotFixture();
  const first = parseFleetSnapshot(input)!;
  expect(gate.accept(first)).toBe(true);
  input.session_id = '22222222-2222-4222-a222-222222222222'; input.sequence = 100;
  input.simulation_time_seconds = 100; input.vehicles[0].longitude = 0;
  expect(Reflect.set(first, 'sequence', 100)).toBe(false);
  expect(Reflect.set(first.vehicles[0], 'longitude', 0)).toBe(false);
  expect(first.sequence).toBe(0); expect(first.vehicles[0].longitude).toBe(116);
  expect(gate.accept(snapshotAt(1, 1))).toBe(true);
  // Even a structurally typed mutable caller cannot change the stored baseline.
  const mutable: FleetSnapshot = { ...snapshotAt(2, 2) };
  expect(gate.accept(mutable)).toBe(true);
  Reflect.set(mutable, 'sequence', 100); Reflect.set(mutable, 'simulation_time_seconds', 100);
  expect(gate.accept(snapshotAt(3, 3))).toBe(true);
});
