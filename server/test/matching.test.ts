import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { isOdometerMismatch } from '../src/matching/pipeline.js';
import { splitTrace, MAX_DISTANCE_PER_REQUEST_M, MAX_POINTS_PER_REQUEST, traceAttributes } from '../src/matching/valhalla.js';
import { createMatchingWorker, queueMatching } from '../src/matching/worker.js';
import { attachRoads, roundPercent } from '../src/roads/index.js';
import {
  driveTrip,
  FIXTURE_NORTH,
  fakeValhalla,
  getJson,
  makePoints,
  makeRoadsDb,
  matchedResponse,
  newApp,
  ROADS_TEST_DB,
} from './helpers.js';

const fixture = JSON.parse(readFileSync(FIXTURE_NORTH, 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));

const settle = async (app: ReturnType<typeof newApp>, tripId: string) => {
  await app.matching.idle();
  return (await getJson(app, `/trips/${tripId}/matching`)).body;
};

describe('실제 Valhalla 응답 픽스처 파이프라인', () => {
  it('way 합산·ignored_ways·unnamed 제외·집계가 도로 DB와 맞는다', async () => {
    const fetchFn = fakeValhalla(() => fixture);
    const app = newApp({ valhalla: { fetchFn } });
    const { tripId, end } = await driveTrip(app, { points: makePoints(30) });
    expect(end.matching).toBe('queued');
    const m = await settle(app, tripId);

    expect(m.status).toBe('done');
    expect(m.attempts).toBe(1);
    expect(m.snapshotMonth).toBe('202611');
    expect(m.attribution).toContain('OpenStreetMap');
    // 요청 파라미터(사양 3-1)
    const body = fetchFn.calls[0]!.body;
    expect(body.costing).toBe('auto');
    expect(body.shape_match).toBe('map_snap');
    expect(body.trace_options).toEqual({ search_radius: 50, gps_accuracy: 10, breakage_distance: 2000 });
    expect(body.filters.attributes).toContain('edge.way_id');
    expect(body.shape).toHaveLength(30);
    expect(fetchFn.calls[0]!.url).toBe('http://127.0.0.1:8002/trace_attributes');

    const r = m.result;
    expect(r.outcome).toBe('counted');
    expect(r.ignoredWays).toBe(2); // service 등급 2개는 도로 DB에 없다
    expect(r.ignoredUnnamed).toBe(4); // 이름·번호 없는 way 4개
    expect(r.unmatchedRatio).toBeCloseTo(1 / 30, 3);
    // 매칭 길이 합산: 같은 way의 edge는 합친다(예: 506252728는 두 edge)
    const sums = new Map<number, number>();
    for (const e of fixture.edges) sums.set(e.way_id, (sums.get(e.way_id) ?? 0) + e.length * 1000);
    expect(r.matchedKm).toBeCloseTo([...sums.values()].reduce((a: number, b: number) => a + b, 0) / 1000, 3);
    // 인정된 way(커버리지 0.7 또는 500m 이상, 이름 있음)만 칠해진다. 기대값은 도로 DB에서 따로 계산한다.
    const { DatabaseSync } = await import('node:sqlite');
    const rd = new DatabaseSync(ROADS_TEST_DB, { readOnly: true });
    const expected: number[] = [];
    for (const [id, matchedM] of sums) {
      const w = rd.prepare('SELECT road_key, length_m FROM ways WHERE way_id = ?').get(id) as
        { road_key: string; length_m: number } | undefined;
      if (w && !w.road_key.startsWith('unnamed:') && (matchedM / w.length_m >= 0.7 || matchedM >= 500)) expected.push(id);
    }
    expect(r.newWays).toBe(expected.length);
    expect(await segmentIds(app, '126.9,37.4,127.4,37.9')).toEqual(expected.sort((a, b) => a - b));
    const summary = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
    expect(summary.nationalPercent).toBe(r.nationalPercentAfter);
    expect(r.nationalPercentBefore).toBe(0);
  });
});

describe('인정 규칙', () => {
  const setup = async (ways: Parameters<typeof makeRoadsDb>[1], edges: { way_id: number; length: number }[], unmatched = 0, pts = 40) => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'roads.sqlite'), ways);
    const app = newApp({ roadsPath, valhalla: { fetchFn: fakeValhalla(() => matchedResponse(edges, pts, unmatched)) } });
    return app;
  };
  const W = (id: number, lengthM: number, roadKey = `nm:r${id}`, extra = {}) => ({
    id,
    roadKey,
    lengthM,
    highway: 'residential',
    ...extra,
  });

  it('커버리지 0.7 이상 또는 매칭 500m 이상이면 인정, 미만이면 제외', async () => {
    const app = await setup(
      [W(1, 1000), W(2, 1000), W(3, 3000), W(4, 3000), W(5, 1000)],
      [
        { way_id: 1, length: 0.69 }, // 690m: 커버리지 0.69지만 500m 이상 → 인정
        { way_id: 2, length: 0.7 }, // 0.70 → 인정
        { way_id: 3, length: 0.5 }, // 500m(긴 way의 부분 주행) → 인정
        { way_id: 4, length: 0.499 }, // 499m, 0.166 → 제외
        { way_id: 5, length: 0.4 }, // edge 둘이 합쳐 0.7
        { way_id: 5, length: 0.3 },
      ],
    );
    const { tripId } = await driveTrip(app);
    const m = await settle(app, tripId);
    expect(m.result.outcome).toBe('counted');
    const ids = await segmentIds(app);
    // 4만 제외(499m, 커버리지 0.166)
    expect(ids).toEqual([1, 2, 3, 5]);
    expect(m.result.newWays).toBe(4);
    expect(m.result.roadsTouched.sort()).toEqual(['nm:r1', 'nm:r2', 'nm:r3', 'nm:r5']);
  });

  it('0.7 미만이면서 500m 미만이면 인정하지 않는다', async () => {
    const app = await setup(
      [W(1, 1000), W(2, 400)],
      [
        { way_id: 1, length: 0.499 },
        { way_id: 2, length: 0.27 },
      ],
    );
    const { tripId } = await driveTrip(app);
    const m = await settle(app, tripId);
    expect(m.result.newWays).toBe(0);
    expect(m.result.newKm).toBe(0);
    expect(await segmentIds(app)).toEqual([]);
  });

  it('왕복해도 커버리지는 1로 상한, 이름 없는 way는 집계에서 제외, 도로 DB에 없는 way는 ignoredWays', async () => {
    const app = await setup(
      [W(1, 1000), { id: 2, roadKey: 'unnamed:2', lengthM: 1000, highway: 'residential' }],
      [
        { way_id: 1, length: 1.0 },
        { way_id: 1, length: 1.0 }, // 반대 방향 왕복
        { way_id: 2, length: 1.0 },
        { way_id: 999999, length: 0.8 },
      ],
    );
    const { tripId } = await driveTrip(app);
    const m = await settle(app, tripId);
    expect(m.result).toMatchObject({ newWays: 1, ignoredWays: 1, ignoredUnnamed: 1, roadsTouched: ['nm:r1'] });
    expect(m.result.newKm).toBe(1); // 2km가 아니라 way 길이 1km
    const { body } = await getJson(app, '/coverage/segments?vehicleId=v1&bbox=126.9,36.9,127.9,37.9');
    expect(body.features.map((f: any) => f.properties.coverage)).toEqual([1]);
  });

  it('같은 way를 다시 달리면 새 도로가 아니다(newWays 0, newKm 0)', async () => {
    const app = await setup([W(1, 1000)], [{ way_id: 1, length: 1.0 }]);
    const a = await settle(app, (await driveTrip(app)).tripId);
    const b = await settle(app, (await driveTrip(app)).tripId);
    expect(a.result.newWays).toBe(1);
    expect(b.result.newWays).toBe(0);
    expect(b.result.newKm).toBe(0);
    expect(b.result.nationalPercentBefore).toBe(a.result.nationalPercentAfter);
  });

  it('unmatched 점이 50% 초과면 low_confidence로 인정하지 않고, 정확히 50%는 인정', async () => {
    const half = await setup([W(1, 1000)], [{ way_id: 1, length: 1.0 }], 20);
    expect((await settle(half, (await driveTrip(half)).tripId)).result.outcome).toBe('counted');
    const over = await setup([W(1, 1000)], [{ way_id: 1, length: 1.0 }], 21);
    const m = await settle(over, (await driveTrip(over)).tripId);
    expect(m.status).toBe('done');
    expect(m.result).toMatchObject({ outcome: 'low_confidence', reason: 'low_confidence', newWays: 0 });
    expect(await segmentIds(over)).toEqual([]);
  });

  it('20점 미만 또는 100m 미만이면 too_short로 건너뛰고 Valhalla를 부르지 않는다', async () => {
    const fetchFn = fakeValhalla(() => matchedResponse([], 1));
    const app = newApp({ valhalla: { fetchFn } });
    const few = await settle(app, (await driveTrip(app, { points: makePoints(19) })).tripId);
    expect(few.result).toMatchObject({ outcome: 'skipped', reason: 'too_short' });
    const near = await settle(app, (await driveTrip(app, { points: makePoints(30, 3) })).tripId);
    expect(near.result).toMatchObject({ outcome: 'skipped', reason: 'too_short' });
    expect(fetchFn.calls).toHaveLength(0);
  });

  it('오도미터 대조: GPS 길이가 odo×1.1+1km를 넘으면 suspect(인정 안 함), null·0·감소는 건너뛴다', async () => {
    const edges = [{ way_id: 1, length: 1.0 }];
    // 80점×25m ≈ 1975m, 오도미터 증가 0.1km → 한도 1110m → 초과
    const sus = await setup([W(1, 1000)], edges, 0, 80);
    const m = await settle(sus, (await driveTrip(sus, { points: makePoints(80), odoStart: 100, odoEnd: 100.1 })).tripId);
    expect(m.result).toMatchObject({ outcome: 'suspect', reason: 'odometer_mismatch', suspect: true, newWays: 0 });
    expect(await segmentIds(sus)).toEqual([]);
    // 에뮬레이터처럼 0·null·감소면 대조하지 않는다
    for (const [s, e] of [
      [0, 0],
      [null, null],
      [100, 90],
    ] as const) {
      const ok = await setup([W(1, 1000)], edges, 0, 80);
      const r = await settle(ok, (await driveTrip(ok, { points: makePoints(80), odoStart: s, odoEnd: e })).tripId);
      expect(r.result.outcome).toBe('counted');
    }
  });

  it('isOdometerMismatch 경계', () => {
    expect(isOdometerMismatch(1_000 + 2_200, 0, 2)).toBe(false); // 정확히 한도
    expect(isOdometerMismatch(1_000 + 2_200 + 1, 0, 2)).toBe(true);
    expect(isOdometerMismatch(99999, 5, 5)).toBe(false);
    expect(isOdometerMismatch(99999, null, 5)).toBe(false);
  });
});

describe('분리 차로(사양 6-3)', () => {
  it('상·하행이 별도 way인 주요 도로는 한 방향만 달려도 100%에 도달하고 완주로 센다', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'roads.sqlite'), [
      { id: 10, roadKey: 'nr:77', lengthM: 1000, highway: 'primary', oneway: 'yes', at: [127, 37] },
      { id: 11, roadKey: 'nr:77', lengthM: 1000, highway: 'primary', oneway: 'yes', at: [127, 37.0001] },
      // 같은 일방통행이라도 tertiary 이하는 1배로 센다
      { id: 20, roadKey: 'nm:골목', lengthM: 1000, highway: 'tertiary', oneway: 'yes', at: [127.1, 37] },
      { id: 21, roadKey: 'nm:골목', lengthM: 1000, highway: 'tertiary', oneway: 'yes', at: [127.1, 37.0001] },
    ]);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 10, length: 1 },
              { way_id: 20, length: 1 },
            ],
            40,
          ),
        ),
      },
    });
    await settle(app, (await driveTrip(app)).tripId);
    const { body } = await getJson(app, '/coverage/roads?vehicleId=v1&sort=length');
    const byKey = Object.fromEntries(body.items.map((i: any) => [i.roadKey, i]));
    expect(byKey['nr:77']).toMatchObject({ totalM: 1000, drivenM: 1000, percent: 100, completed: true });
    expect(byKey['nm:골목']).toMatchObject({ totalM: 2000, drivenM: 1000, percent: 50, completed: false });
    const s = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
    // 분모 = 1000(국도 총길이) + 2000(골목)
    expect(s.totalKm).toBe(3);
    expect(s.roadsCompleted).toBe(1);
    expect(s.roadsStarted).toBe(2);
    expect(s.nationalPercent).toBe(roundPercent((2000 / 3000) * 100));
    // 양방향을 다 달려도 도로 총길이를 넘지 않는다
    const both = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 10, length: 1 },
              { way_id: 11, length: 1 },
            ],
            40,
          ),
        ),
      },
    });
    await settle(both, (await driveTrip(both)).tripId);
    expect((await getJson(both, '/coverage/roads?vehicleId=v1')).body.items[0]).toMatchObject({ drivenM: 1000, percent: 100 });
  });
});

describe('Valhalla 요청 분할(사양 6-3)', () => {
  const line = (n: number, stepM: number) => makePoints(n, stepM).map(({ lat, lon }) => ({ lat, lon }));

  it('점 16,000개를 넘기 전에 나눈다', () => {
    const chunks = splitTrace(line(MAX_POINTS_PER_REQUEST + 5, 1));
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= MAX_POINTS_PER_REQUEST)).toBe(true);
  });

  it('누적 거리 150km를 넘기 전에 나누고 조각 경계 점은 겹친다', () => {
    const pts = line(1000, 400); // 400km
    const chunks = splitTrace(pts);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.at(-1)).toBe(chunks[1]![0]);
    for (const c of chunks) {
      const km = (c.length - 1) * 0.4;
      expect(km * 1000).toBeLessThanOrEqual(MAX_DISTANCE_PER_REQUEST_M + 1);
    }
  });

  it('조각마다 요청하고 way 길이·unmatched를 합친다', async () => {
    const fetchFn = fakeValhalla((body) => matchedResponse([{ way_id: 7, length: 1 }], body.shape.length, 1));
    const r = await traceAttributes(line(1000, 400), { fetchFn });
    expect(fetchFn.calls).toHaveLength(3);
    expect(r.wayLengthsM.get(7)).toBeCloseTo(3000);
    expect(r.unmatchedPoints).toBe(3);
  });
});

describe('워커 재시도', () => {
  it('네트워크 오류·5xx는 failed(retryable)로 두고 5분(테스트는 짧게) 뒤 재시도해 성공한다', async () => {
    let n = 0;
    const fetchFn = fakeValhalla((_b, call) => {
      n = call;
      if (call === 1) throw new TypeError('fetch failed');
      if (call === 2) return new Response('boom', { status: 503 });
      return matchedResponse([{ way_id: 1, length: 1 }], 40);
    });
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [{ id: 1, roadKey: 'nm:a', lengthM: 1000, highway: 'residential' }]);
    const app = newApp({ roadsPath, valhalla: { fetchFn }, retryDelayMs: 20 });
    const { tripId } = await driveTrip(app);
    await app.matching.idle();
    let m = (await getJson(app, `/trips/${tripId}/matching`)).body;
    expect(m.status).toBe('failed');
    expect(m.error).toMatch(/^retryable:/);
    for (let i = 0; i < 100 && m.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await app.matching.idle();
      m = (await getJson(app, `/trips/${tripId}/matching`)).body;
    }
    expect(m.status).toBe('done');
    expect(m.attempts).toBe(3);
    expect(n).toBe(3);
    app.matching.stop();
  });

  it('4xx는 failed(permanent)로 재시도하지 않는다', async () => {
    const fetchFn = fakeValhalla(() => new Response('{"error":"bad"}', { status: 400 }));
    const app = newApp({ valhalla: { fetchFn }, retryDelayMs: 5 });
    const { tripId } = await driveTrip(app);
    await app.matching.idle();
    await new Promise((r) => setTimeout(r, 40));
    await app.matching.idle();
    const m = (await getJson(app, `/trips/${tripId}/matching`)).body;
    expect(m).toMatchObject({ status: 'failed', attempts: 1 });
    expect(m.error).toMatch(/^permanent:/);
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('24시간이 지나도록 실패하면 영구 실패(retry_exhausted)로 바꾼다', async () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('t', 'l', 'v', 'v', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z')",
    ).run();
    for (const p of makePoints(30))
      db.prepare('INSERT INTO trip_points (trip_id, seq, ts, lat, lon) VALUES (?,?,?,?,?)').run('t', p.seq, p.ts, p.lat, p.lon);
    const roads = attachRoads(db, ROADS_TEST_DB);
    let clock = Date.parse('2026-11-09T00:00:00Z');
    queueMatching(db, 't');
    db.prepare('UPDATE trip_matching SET queued_at = ?').run(new Date(clock).toISOString());
    const worker = createMatchingWorker({
      db,
      roads: () => roads,
      trace: { fetchFn: fakeValhalla(() => new Response('x', { status: 502 })) },
      retryDelayMs: 1_000_000,
      now: () => clock,
    });
    worker.enqueue('t');
    await worker.idle();
    expect((db.prepare('SELECT error FROM trip_matching').get() as { error: string }).error).toMatch(/^retryable:/);
    clock += 25 * 3600 * 1000;
    worker.enqueue('t');
    await worker.idle();
    expect((db.prepare('SELECT error FROM trip_matching').get() as { error: string }).error).toMatch(/^permanent: retry_exhausted/);
    worker.stop();
  });

  it('도로 DB가 없으면 재시도 대기(failed retryable)로 둔다', async () => {
    const app = newApp({ roadsPath: null, valhalla: { fetchFn: fakeValhalla(() => matchedResponse([], 1)) }, retryDelayMs: 1_000_000 });
    const { tripId } = await driveTrip(app);
    const m = await settle(app, tripId);
    expect(m.status).toBe('failed');
    expect(m.error).toContain('roads_db_unavailable');
    app.matching.stop();
  });
});

describe('트립 API 연동', () => {
  it('End를 반복해도 매칭은 한 번만 큐에 들어가고, 없는 트립의 matching은 404', async () => {
    const fetchFn = fakeValhalla(() => matchedResponse([], 30));
    const app = newApp({ valhalla: { fetchFn } });
    const { tripId } = await driveTrip(app);
    const again = await app.request(`/trips/${tripId}/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endedAt: '2026-11-09T01:00:00Z' }),
    });
    expect(((await again.json()) as { matching: string }).matching).toBe('queued');
    await app.matching.idle();
    expect(fetchFn.calls).toHaveLength(1);
    expect((await getJson(app, '/trips/nope/matching')).status).toBe(404);
  });

  it('alias(UUID)로 올린 트립도 서버 발급 차량 ID의 집계에 들어간다', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [
      { id: 1, roadKey: 'nm:a', lengthM: 1000, highway: 'residential' },
      { id: 2, roadKey: 'nm:b', lengthM: 1000, highway: 'residential', at: [127.05, 37] },
    ]);
    let call = 0;
    const app = newApp({ roadsPath, valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: ++call, length: 1 }], 40)) } });
    await app.request('/vehicles/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromVehicleId: 'uuid-1', toVehicleId: 'srv-1' }),
    });
    await settle(app, (await driveTrip(app, { vehicleId: 'uuid-1' })).tripId);
    const b = await settle(app, (await driveTrip(app, { vehicleId: 'srv-1' })).tripId);
    expect(b.result.nationalPercentBefore).toBe(50);
    expect(b.result.nationalPercentAfter).toBe(100);
    expect((await getJson(app, '/coverage/summary?vehicleId=srv-1')).body.roadsStarted).toBe(2);
  });
});

const segmentIds = async (app: ReturnType<typeof newApp>, bbox = '126.9,36.9,127.9,37.9') => {
  const { body } = await getJson(app, `/coverage/segments?vehicleId=v1&bbox=${bbox}`);
  return body.features.map((f: any) => f.properties.wayId).sort((a: number, b: number) => a - b);
};
