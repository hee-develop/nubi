import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const newApp = () => createApp(openDb(':memory:'));

const point = (seq: number, lat = 37.5 + seq * 0.0001) => ({
  seq,
  ts: new Date(Date.UTC(2026, 10, 8, 0, 0, seq)).toISOString(),
  lat,
  lon: 127.0,
});

const startTrip = async (app: ReturnType<typeof newApp>) => {
  const res = await app.request(
    '/trips',
    json({ vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-08T00:00:00.000Z', odometerStartKm: 100 }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { tripId: string }).tripId;
};

describe('trips', () => {
  it('생성 → 점 적재(중복 포함) → 종료 → 조회', async () => {
    const app = newApp();
    const tripId = await startTrip(app);

    const first = await app.request(`/trips/${tripId}/points`, json({ points: [point(0), point(1), point(2)] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: 3, duplicated: 0 });

    const second = await app.request(`/trips/${tripId}/points`, json({ points: [point(2), point(3)] }));
    expect(await second.json()).toEqual({ accepted: 1, duplicated: 1 });

    const end = await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T00:01:00.000Z', odometerEndKm: 100.5 }));
    expect(end.status).toBe(200);
    const summary = (await end.json()) as { tripId: string; pointCount: number; distanceM: number; durationS: number };
    expect(summary.pointCount).toBe(4);
    expect(summary.durationS).toBe(60);
    // 위도 0.0003도 ≈ 33.4m
    expect(summary.distanceM).toBeGreaterThan(33);
    expect(summary.distanceM).toBeLessThan(34);

    const again = await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T00:09:00.000Z' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(summary);

    const detail = (await (await app.request(`/trips/${tripId}`)).json()) as {
      endedAt: string;
      odometerEndKm: number;
      points: { seq: number }[];
    };
    expect(detail.endedAt).toBe('2026-11-08T00:01:00.000Z');
    expect(detail.odometerEndKm).toBe(100.5);
    expect(detail.points.map((p) => p.seq)).toEqual([0, 1, 2, 3]);

    const list = (await (await app.request('/trips?vehicleId=v1&limit=10')).json()) as { trips: { tripId: string; points?: unknown }[] };
    expect(list.trips).toHaveLength(1);
    expect(list.trips[0].tripId).toBe(tripId);
    expect(list.trips[0].points).toBeUndefined();
    expect(((await (await app.request('/trips?vehicleId=other')).json()) as { trips: unknown[] }).trips).toHaveLength(0);
  });

  it('배치 500점은 허용하고 501점은 400', async () => {
    const app = newApp();
    const tripId = await startTrip(app);
    const ok = await app.request(`/trips/${tripId}/points`, json({ points: Array.from({ length: 500 }, (_, i) => point(i)) }));
    expect(ok.status).toBe(200);
    const tooMany = await app.request(`/trips/${tripId}/points`, json({ points: Array.from({ length: 501 }, (_, i) => point(1000 + i)) }));
    expect(tooMany.status).toBe(400);
  });

  it('잘못된 body는 400, 없는 트립은 404', async () => {
    const app = newApp();
    expect((await app.request('/trips', json({ vehicleId: 'v1' }))).status).toBe(400);
    expect((await app.request('/trips', { method: 'POST', body: 'not json' })).status).toBe(400);
    const tripId = await startTrip(app);
    expect((await app.request(`/trips/${tripId}/points`, json({ points: [{ ...point(0), lat: 123 }] }))).status).toBe(400);
    expect((await app.request(`/trips/${tripId}/points`, json({ points: [{ ...point(0), gear: 'X' }] }))).status).toBe(400);
    expect((await app.request(`/trips/${tripId}/end`, json({}))).status).toBe(400);
    expect((await app.request('/trips/nope/points', json({ points: [point(0)] }))).status).toBe(404);
    expect((await app.request('/trips/nope')).status).toBe(404);
  });
});
