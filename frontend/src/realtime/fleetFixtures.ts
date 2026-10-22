/** Protocol-only data: no scene geometry or route calculations. */
export function makeFleetSnapshotFixture() {
  const timestamp = '2026-10-14T04:00:00.000001+00:00';
  return {
    schema_version: 1,
    session_id: '11111111-1111-4111-8111-111111111111',
    sequence: 0,
    timestamp,
    simulation_time_seconds: 0,
    vehicles: [
      { vehicle_id: 'TRUCK_001', timestamp, longitude: 116, latitude: 39, height: 50,
        heading: 0, speed: 25, soc: 90, load: 65, status: 'running' },
      { vehicle_id: 'TRUCK_002', timestamp, longitude: 117, latitude: 40, height: 55,
        heading: 120, speed: 25, soc: 80, load: 40, status: 'running' },
      { vehicle_id: 'TRUCK_003', timestamp, longitude: 118, latitude: 41, height: 60,
        heading: 240, speed: 25, soc: 70, load: 80, status: 'running' },
    ],
  };
}
