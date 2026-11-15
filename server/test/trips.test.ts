import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const newApp = () => createApp(openDb(':memory:'), { vehicleHmacKey: 'test-key', roadsPath: null });

const point = (seq: number, lat = 37.5 + seq * 0.0001) => ({
  seq,
  ts: new Date(Date.UTC(2026, 10, 8, 0, 0, seq)).toISOString(),
  lat,
  lon: 127.0,
});

const startTrip = async (app: ReturnType<typeof newApp>, localId: string = crypto.randomUUID(), vehicleId = 'v1') => {
  const res = await app.request(
    '/trips',
    json({ localId, vehicleId, driverId: vehicleId, startedAt: '2026-11-08T00:00:00.000Z', odometerStartKm: 100 }),
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
    expect((await app.request('/trips', json({ localId: 'a', vehicleId: 'v1', driverId: 'v1', startedAt: 'x' }))).status).toBe(400);
    expect((await app.request('/trips', { method: 'POST', body: 'not json' })).status).toBe(400);
    const tripId = await startTrip(app);
    expect((await app.request(`/trips/${tripId}/points`, json({ points: [{ ...point(0), lat: 123 }] }))).status).toBe(400);
    expect((await app.request(`/trips/${tripId}/points`, json({ points: [{ ...point(0), gear: 'X' }] }))).status).toBe(400);
    expect((await app.request(`/trips/${tripId}/end`, json({}))).status).toBe(400);
    expect((await app.request('/trips/nope/points', json({ points: [point(0)] }))).status).toBe(404);
    expect((await app.request('/trips/nope')).status).toBe(404);
  });

  it('같은 localId로 다시 만들어도 같은 tripId를 돌려주고 행은 하나다(멱등)', async () => {
    const app = newApp();
    const body = { localId: 'local-1', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-08T00:00:00.000Z' };
    const a = await app.request('/trips', json(body));
    const b = await app.request('/trips', json(body));
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    const idA = ((await a.json()) as { tripId: string }).tripId;
    expect(((await b.json()) as { tripId: string }).tripId).toBe(idA);
    expect(((await (await app.request('/trips')).json()) as { trips: unknown[] }).trips).toHaveLength(1);
    const detail = (await (await app.request(`/trips/${idA}`)).json()) as { localId: string };
    expect(detail.localId).toBe('local-1');
  });

  it('시각은 오프셋이 달라도 UTC로 정규화해 저장한다', async () => {
    const app = newApp();
    const res = await app.request(
      '/trips',
      json({ localId: 'tz', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-08T09:00:00+09:00' }),
    );
    const tripId = ((await res.json()) as { tripId: string }).tripId;
    await app.request(`/trips/${tripId}/points`, json({ points: [{ ...point(0), ts: '2026-11-08T09:00:01.500+09:00' }] }));
    await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T09:01:00+09:00' }));
    const d = (await (await app.request(`/trips/${tripId}`)).json()) as {
      startedAt: string;
      endedAt: string;
      durationS: number;
      points: { ts: string }[];
    };
    expect(d.startedAt).toBe('2026-11-08T00:00:00.000Z');
    expect(d.endedAt).toBe('2026-11-08T00:01:00.000Z');
    expect(d.points[0].ts).toBe('2026-11-08T00:00:01.500Z');
    expect(d.durationS).toBe(60);
  });

  it('요청 본문이 1MB를 넘으면 413', async () => {
    const app = newApp();
    const res = await app.request(
      '/trips',
      json({ localId: 'big', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-08T00:00:00Z', pad: 'x'.repeat(1_100_000) }),
    );
    expect(res.status).toBe(413);
  });

  it('범위 검증: headingDeg 0~360, id 길이 128 이하', async () => {
    const app = newApp();
    const tripId = await startTrip(app);
    const post = (p: object) => app.request(`/trips/${tripId}/points`, json({ points: [{ ...point(0), ...p }] }));
    expect((await post({ headingDeg: 360 })).status).toBe(200);
    expect((await post({ seq: 1, headingDeg: 0 })).status).toBe(200);
    expect((await post({ seq: 2, headingDeg: 360.1 })).status).toBe(400);
    expect((await post({ seq: 3, headingDeg: -1 })).status).toBe(400);
    const start = (o: object) =>
      app.request('/trips', json({ localId: 'ok', vehicleId: 'v', driverId: 'v', startedAt: '2026-11-08T00:00:00Z', ...o }));
    expect((await start({ vehicleId: 'v'.repeat(128), localId: 'l128' })).status).toBe(201);
    expect((await start({ vehicleId: 'v'.repeat(129), localId: 'l129' })).status).toBe(400);
    expect((await start({ localId: 'l'.repeat(129) })).status).toBe(400);
  });

  it('종료된 트립에 늦게 온 점도 받고 요약(종료 응답·상세·목록)이 서로 일치한다', async () => {
    const app = newApp();
    const tripId = await startTrip(app);
    await app.request(`/trips/${tripId}/points`, json({ points: [point(0), point(1)] }));
    const end = (await (await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T00:01:00Z' }))).json()) as {
      pointCount: number;
    };
    expect(end.pointCount).toBe(2);
    const late = await app.request(`/trips/${tripId}/points`, json({ points: [point(2), point(3)] }));
    expect(await late.json()).toEqual({ accepted: 2, duplicated: 0 });
    const detail = (await (await app.request(`/trips/${tripId}`)).json()) as { pointCount: number; distanceM: number; points: unknown[] };
    const list = (await (await app.request('/trips')).json()) as { trips: { pointCount: number; distanceM: number }[] };
    expect(detail.pointCount).toBe(4);
    expect(detail.points).toHaveLength(4);
    expect(list.trips[0].pointCount).toBe(4);
    expect(list.trips[0].distanceM).toBe(detail.distanceM);
    // 위도 0.0003도 ≈ 33.4m
    expect(detail.distanceM).toBeGreaterThan(33);
    expect(detail.distanceM).toBeLessThan(34);
  });

  it('목록은 트립 수와 상관없이 쿼리 1회로 요약까지 계산한다(N+1 없음)', async () => {
    const db = openDb(':memory:');
    const counted = createApp(db, { vehicleHmacKey: 'test-key', roadsPath: null });
    const prepare = vi.spyOn(db, 'prepare');
    const queriesFor = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const tripId = await startTrip(counted);
        await counted.request(`/trips/${tripId}/points`, json({ points: [point(0), point(1)] }));
      }
      prepare.mockClear();
      const res = await counted.request('/trips?limit=50');
      const body = (await res.json()) as { trips: { pointCount: number }[] };
      expect(body.trips.every((t) => t.pointCount === 2)).toBe(true);
      return prepare.mock.calls.length;
    };
    const one = await queriesFor(1);
    const many = await queriesFor(5);
    expect(one).toBe(1);
    expect(many).toBe(1);
  });
});
