import { expect, test } from 'vitest';
import { parseVehicleTelemetry } from './vehicleTelemetry';

function makeValidTelemetry() {
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

test('accepts UTC microseconds and returns a ten-field copy', () => {
  const input = makeValidTelemetry();
  const result = parseVehicleTelemetry(input);

  expect(result).toEqual(input);
  expect(result).not.toBe(input);
  expect(Object.keys(result!)).toHaveLength(10);
  expect(result?.timestamp).toBe('2026-10-01T13:18:02.936773+00:00');
});

function expectRejected(input: unknown) {
  expect(() => parseVehicleTelemetry(input)).not.toThrow();
  expect(parseVehicleTelemetry(input)).toBeNull();
}

test.each([
  { label: 'null', input: null },
  { label: 'undefined', input: undefined },
  { label: 'string', input: 'telemetry' },
  { label: 'number', input: 42 },
  { label: 'boolean', input: true },
  { label: 'array', input: [] },
])('rejects non-object input: $label', ({ input }) => {
  expectRejected(input);
});

test('rejects missing vehicle_id', () => {
  const input: Record<string, unknown> = makeValidTelemetry();
  delete input.vehicle_id;
  expectRejected(input);
});

test.each([42, null, '', ' TRUCK_001 ', 'TRUCK_002'])(
  'rejects wrong vehicle_id: %j',
  (vehicle_id) => {
    expectRejected({ ...makeValidTelemetry(), vehicle_id });
  },
);

test('rejects missing longitude', () => {
  const input: Record<string, unknown> = makeValidTelemetry();
  delete input.longitude;
  expectRejected(input);
});

test.each(['116', null])('rejects non-numeric longitude: %j', (longitude) => {
  expectRejected({ ...makeValidTelemetry(), longitude });
});

test.each(['39', null])('rejects non-numeric latitude: %j', (latitude) => {
  expectRejected({ ...makeValidTelemetry(), latitude });
});

test.each([
  'not-a-date',
  '2026-10-01T13:18:02',
  '2026-10-01T13:18:02+08:00',
  '2026-10-01',
  '2026-02-29T13:18:02Z',
  '2026-04-31T13:18:02Z',
  '2026-10-01T24:00:00Z',
  '2026-10-01T13:18:60Z',
  '0000-10-01T13:18:02Z',
  '2026-10-01T13:18:02.1234567Z',
  '2026-00-01T13:18:02Z',
  '2026-10-00T13:18:02Z',
  '2026-10-01T13:60:02Z',
  '2026-10-01T13:18:02Z\n',
  42,
  null,
])('rejects invalid UTC timestamp: %j', (timestamp) => {
  expectRejected({ ...makeValidTelemetry(), timestamp });
});

test.each([
  '2024-02-29T13:18:02Z',
  '2026-10-01T13:18:02+00:00',
  '2026-10-01T13:18:02.1Z',
  '2026-10-01T13:18:02.123Z',
  '2026-10-01T13:18:02.123456Z',
  '2026-10-01T13:18:02.123456+00:00',
  '0001-01-01T00:00:00Z',
  '9999-12-31T23:59:59Z',
])('preserves valid protocol UTC timestamp: %s', (timestamp) => {
  const input = { ...makeValidTelemetry(), timestamp };
  expect(parseVehicleTelemetry(input)).toEqual(input);
  expect(parseVehicleTelemetry(input)?.timestamp).toBe(timestamp);
});

test.each([
  'vehicle_id', 'timestamp', 'longitude', 'latitude', 'height',
  'heading', 'speed', 'soc', 'load', 'status',
])('rejects missing protocol field: %s', (field) => {
  const input: Record<string, unknown> = makeValidTelemetry();
  delete input[field];
  expectRejected(input);
});

test.each([42, null, '', '   '])('rejects invalid status: %j', (status) => {
  expectRejected({ ...makeValidTelemetry(), status });
});

test('preserves a nonempty status string without trimming it', () => {
  const input = { ...makeValidTelemetry(), status: ' running ' };
  expect(parseVehicleTelemetry(input)?.status).toBe(' running ');
});

const numericFields = [
  'longitude', 'latitude', 'height', 'heading', 'speed', 'soc', 'load',
] as const;

const invalidNumbers = [
  { label: 'null', value: null },
  { label: 'string', value: '25' },
  { label: 'boolean', value: false },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: '-Infinity', value: -Infinity },
];

test.each(numericFields.flatMap((field) => (
  invalidNumbers.map(({ label, value }) => ({ field, label, value }))
)))('rejects $label in numeric field $field', ({ field, value }) => {
  expectRejected({ ...makeValidTelemetry(), [field]: value });
});

test.each([
  { field: 'longitude', value: -180.1 },
  { field: 'longitude', value: 180.1 },
  { field: 'latitude', value: -90.1 },
  { field: 'latitude', value: 90.1 },
  { field: 'heading', value: -1 },
  { field: 'heading', value: 360 },
  { field: 'speed', value: -1 },
  { field: 'soc', value: -0.1 },
  { field: 'soc', value: 100.1 },
])('rejects out-of-range $field: $value', ({ field, value }) => {
  expectRejected({ ...makeValidTelemetry(), [field]: value });
});

test.each([
  { field: 'longitude', value: -180 },
  { field: 'longitude', value: 180 },
  { field: 'latitude', value: -90 },
  { field: 'latitude', value: 90 },
  { field: 'heading', value: 0 },
  { field: 'heading', value: 359.9 },
  { field: 'speed', value: 0 },
  { field: 'soc', value: 0 },
  { field: 'soc', value: 100 },
  { field: 'height', value: -10 },
  { field: 'load', value: -10 },
])('accepts permitted $field: $value without conversion', ({ field, value }) => {
  const input = { ...makeValidTelemetry(), [field]: value };
  expect(parseVehicleTelemetry(input)).toEqual(input);
});

test('ignores extra fields and leaves a frozen input unchanged', () => {
  const expected = makeValidTelemetry();
  const input = Object.freeze({ ...expected, debug: Object.freeze({ source: 'test' }) });
  const result = parseVehicleTelemetry(input);

  expect(result).toEqual(expected);
  expect(result).not.toBe(input);
  expect(Object.keys(result!)).toHaveLength(10);
  expect(result).not.toHaveProperty('debug');
  expect(input.debug).toEqual({ source: 'test' });
  expect(input.timestamp).toBe('2026-10-01T13:18:02.936773+00:00');
});
