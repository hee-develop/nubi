import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { isOdometerMismatch } from '../src/matching/pipeline.js';
import { splitTrace, MAX_DISTANCE_PER_REQUEST_M, MAX_POINTS_PER_REQUEST, traceAttributes } from '../src/matching/valhalla.js';
import { createMatchingWorker, queueMatching } from '../src/matching/worker.js';
import { attachRoads, resolveRoadsPath, roundPercent } from '../src/roads/index.js';
import {
  driveTrip,
  expectNewKmConsistent,
  snapshotTotalKm,
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
    expect(m.snapshotMonth).toBe('209901'); // 픽스처는 실 DB와 구분되는 snapshot
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
    // newKm = 전국 달린 길이 증가분: 완료율 증가분과 맞물린다(사양 2장)
    expectNewKmConsistent(r, await snapshotTotalKm(ROADS_TEST_DB));
    expect(r.newKm).toBeCloseTo(summary.drivenKm, 1);
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

describe('묶음별 상한(사양 2장)', () => {
  // nr:90 = 분리 구간 2개(상·하행 각 1000m, 총길이 기여 500+500) + 양방향 구간 1개(500m). 총길이 1500m, 분리 상한 1000m, 양방향 상한 500m.
  const mixed = async () =>
    makeRoadsDb(join(tmp(), 'mixed.sqlite'), [
      { id: 10, roadKey: 'nr:90', lengthM: 1000, highway: 'primary', oneway: 'yes', at: [127, 37] },
      { id: 11, roadKey: 'nr:90', lengthM: 1000, highway: 'primary', oneway: 'yes', at: [127, 37.0001] },
      { id: 12, roadKey: 'nr:90', lengthM: 500, highway: 'primary', at: [127, 37.0002] },
    ]);

  it('분리 구간의 상·하행을 모두 달려도 양방향 구간의 몫을 채우지 못한다', async () => {
    const roadsPath = await mixed();
    const app = newApp({
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
    const m = await settle(app, (await driveTrip(app)).tripId);
    // 상·하행 2000m를 달렸지만 분리 묶음 상한은 1000m이고 양방향 구간(500m)은 한 번도 달리지 않았다.
    expect(m.result).toMatchObject({ newWays: 2, newKm: 1 });
    const road = (await getJson(app, '/coverage/roads?vehicleId=v1')).body.items[0];
    expect(road).toMatchObject({ roadKey: 'nr:90', totalM: 1500, drivenM: 1000, completed: false });
    expect(road.percent).toBeCloseTo(66.67, 2);
    const s = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
    expect(s).toMatchObject({ roadsStarted: 1, roadsCompleted: 0, drivenKm: 1, totalKm: 1.5 });
    expect(s.nationalPercent).toBe(roundPercent((1000 / 1500) * 100));
  });

  it('양방향 묶음만 단독으로 달리면 분리 구간 몫은 0이고 양방향 상한(500m)까지만 센다', async () => {
    const roadsPath = await mixed();
    const app = newApp({
      roadsPath,
      valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 12, length: 0.5 }], 40)) },
    });
    const m = await settle(app, (await driveTrip(app)).tripId);
    expect(m.result).toMatchObject({ newWays: 1, newKm: 0.5 });
    const road = (await getJson(app, '/coverage/roads?vehicleId=v1')).body.items[0];
    expect(road).toMatchObject({ roadKey: 'nr:90', totalM: 1500, drivenM: 500, completed: false });
    expect(road.percent).toBeCloseTo(33.33, 2);
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body).toMatchObject({ drivenKm: 0.5, totalKm: 1.5 });
  });

  it('양방향 구간까지 달려야 100%가 되고, 그때의 newKm은 새로 채운 몫(0.5km)이다', async () => {
    const roadsPath = await mixed();
    const ids = [[10, 11], [12]];
    let call = 0;
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            ids[call++]!.map((id) => ({ way_id: id, length: id === 12 ? 0.5 : 1 })),
            40,
          ),
        ),
      },
    });
    await settle(app, (await driveTrip(app)).tripId);
    const m = await settle(app, (await driveTrip(app)).tripId);
    expect(m.result).toMatchObject({ newWays: 1, newKm: 0.5 });
    expect((await getJson(app, '/coverage/roads?vehicleId=v1')).body.items[0]).toMatchObject({
      drivenM: 1500,
      percent: 100,
      completed: true,
    });
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body).toMatchObject({ roadsCompleted: 1, nationalPercent: 100 });
  });

  it('newKm은 매칭 전후 전국 달린 길이 차이라 way 길이 합과 다르고, 완료율 증가분과 맞물린다', async () => {
    const roadsPath = await mixed();
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 10, length: 1 },
              { way_id: 11, length: 1 },
              { way_id: 12, length: 0.5 },
            ],
            40,
          ),
        ),
      },
    });
    const m = await settle(app, (await driveTrip(app)).tripId);
    // way 길이 합은 2.5km지만 상한 적용 후 전국 달린 길이는 1.5km
    expect(m.result.newKm).toBe(1.5);
    expect(m.result.nationalPercentBefore).toBe(0);
    expect(m.result.nationalPercentAfter).toBe(100);
    expectNewKmConsistent(m.result, 1.5);
  });
});

describe('driven_ways 갱신(사양 4장 5)', () => {
  const setupDb = async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [{ id: 1, roadKey: 'nm:a', lengthM: 1000, highway: 'residential' }]);
    const db = openDb(':memory:');
    let length = 1;
    const app = createApp(db, {
      vehicleHmacKey: 'k',
      roadsPath,
      retryDelayMs: 5,
      valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length }], 40)) },
    });
    return { db, app, setLength: (l: number) => (length = l) };
  };
  const row = (db: ReturnType<typeof openDb>) =>
    db.prepare('SELECT coverage, first_driven_at, last_driven_at, trip_id_first FROM driven_ways').get() as {
      coverage: number;
      first_driven_at: string;
      last_driven_at: string;
      trip_id_first: string;
    };

  it('커버리지는 줄지 않고, first/last_driven_at·trip_id_first는 더 이른/늦은 값만 바꾼다', async () => {
    const { db, app, setLength } = await setupDb();
    // A: 9일 트립, 전체 주행(커버리지 1.0)
    const a = await driveTrip(app, { points: makePoints(40, 25, 37.5665, 126.978, 9) });
    await settle(app, a.tripId);
    expect(row(db)).toMatchObject({ coverage: 1, trip_id_first: a.tripId });
    // B: 8일 트립(더 이르다), 일부만 주행(0.75) → 커버리지는 1 그대로, first는 B로
    setLength(0.75);
    const b = await driveTrip(app, { points: makePoints(40, 25, 37.5665, 126.978, 8) });
    await settle(app, b.tripId);
    const afterB = row(db);
    expect(afterB.coverage).toBe(1);
    expect(afterB.trip_id_first).toBe(b.tripId);
    expect(afterB.first_driven_at.startsWith('2026-11-08')).toBe(true);
    expect(afterB.last_driven_at.startsWith('2026-11-09')).toBe(true); // 늦은 쪽(A) 유지
    // C: 10일 트립 → last만 갱신, first·trip_id_first는 그대로
    const c = await driveTrip(app, { points: makePoints(40, 25, 37.5665, 126.978, 10) });
    await settle(app, c.tripId);
    const afterC = row(db);
    expect(afterC.trip_id_first).toBe(b.tripId);
    expect(afterC.first_driven_at.startsWith('2026-11-08')).toBe(true);
    expect(afterC.last_driven_at.startsWith('2026-11-10')).toBe(true);
    // 요약의 달린 길이도 줄지 않는다
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body.drivenKm).toBe(1);
  });

  it('done 표시와 driven_ways 갱신은 같은 트랜잭션이라, 갱신 도중 실패하면 둘 다 반영되지 않는다', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [{ id: 1, roadKey: 'nm:a', lengthM: 1000, highway: 'residential' }]);
    const db = openDb(':memory:');
    // driven_ways 삽입이 실패하도록 트리거로 막는다
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON driven_ways BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const app = createApp(db, {
      vehicleHmacKey: 'k',
      roadsPath,
      retryDelayMs: 1_000_000,
      valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }], 40)) },
    });
    const { tripId } = await driveTrip(app);
    await app.matching.idle();
    const m = (await getJson(app, `/trips/${tripId}/matching`)).body;
    expect(m.status).toBe('failed');
    expect(m.error).toBe('retryable:internal');
    expect((db.prepare('SELECT COUNT(*) AS n FROM driven_ways').get() as { n: number }).n).toBe(0);
    app.matching.stop();
  });
});

describe('실패 사유 노출·워커 수명', () => {
  it('matching 응답의 error는 분류와 코드뿐이고 메시지는 담기지 않는다', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, {
      vehicleHmacKey: 'k',
      roadsPath: ROADS_TEST_DB,
      retryDelayMs: 1_000_000,
      valhalla: { fetchFn: fakeValhalla(() => new Response('upstream secret-host:8002 stack...', { status: 503 })) },
    });
    const { tripId } = await driveTrip(app);
    await app.matching.idle();
    const m = (await getJson(app, `/trips/${tripId}/matching`)).body;
    expect(m.error).toBe('retryable:http_503');
    // 예전 형식(메시지가 붙은 값)이 DB에 남아 있어도 메시지는 내보내지 않는다
    db.prepare('UPDATE trip_matching SET error = ?').run('retryable: ECONNREFUSED 10.0.0.5:8002');
    expect((await getJson(app, `/trips/${tripId}/matching`)).body.error).toBe('retryable:unknown');
    app.matching.stop();
  });

  const seedTrip = (db: ReturnType<typeof openDb>, id: string, status: string, error: string | null = null) => {
    db.prepare(
      'INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, `l-${id}`, 'v', 'v', '2026-11-09T00:00:00Z', '2026-11-09T00:10:00Z', '2026-11-09T00:00:00Z');
    for (const p of makePoints(30))
      db.prepare('INSERT INTO trip_points (trip_id, seq, ts, lat, lon) VALUES (?,?,?,?,?)').run(id, p.seq, p.ts, p.lat, p.lon);
    queueMatching(db, id);
    db.prepare('UPDATE trip_matching SET status = ?, error = ? WHERE trip_id = ?').run(status, error, id);
  };

  it('재기동 복구: queued·running·failed(retryable)는 다시 처리하고 done·failed(permanent)는 건드리지 않는다', async () => {
    const db = openDb(':memory:');
    const roads = attachRoads(db, ROADS_TEST_DB);
    seedTrip(db, 'q', 'queued');
    seedTrip(db, 'r', 'running');
    seedTrip(db, 'f', 'failed', 'retryable:network');
    seedTrip(db, 'p', 'failed', 'permanent:http_400');
    seedTrip(db, 'd', 'done');
    db.prepare("UPDATE trip_matching SET result_json = '{}', attempts = 1 WHERE trip_id = 'd'").run();
    const fetchFn = fakeValhalla(() => matchedResponse([], 30));
    const worker = createMatchingWorker({ db, roads: () => roads, trace: { fetchFn }, retryDelayMs: 1_000_000 });
    worker.start();
    await worker.idle();
    const status = (id: string) => db.prepare('SELECT status, error, attempts FROM trip_matching WHERE trip_id = ?').get(id) as any;
    for (const id of ['q', 'r', 'f']) expect(status(id), id).toMatchObject({ status: 'done', error: null, attempts: 1 });
    expect(status('p')).toMatchObject({ status: 'failed', error: 'permanent:http_400', attempts: 0 });
    expect(status('d')).toMatchObject({ status: 'done', attempts: 1 });
    expect(fetchFn.calls).toHaveLength(3);
    worker.stop();
  });

  it('stop() 뒤에는 남은 큐를 버리고 idle()이 멈추지 않고 돌아온다', async () => {
    const db = openDb(':memory:');
    const roads = attachRoads(db, ROADS_TEST_DB);
    for (const id of ['a', 'b', 'c']) seedTrip(db, id, 'queued');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = fakeValhalla(async () => {
      await gate;
      return matchedResponse([], 30);
    });
    const worker = createMatchingWorker({ db, roads: () => roads, trace: { fetchFn }, retryDelayMs: 1_000_000 });
    for (const id of ['a', 'b', 'c']) worker.enqueue(id);
    worker.stop(); // 첫 작업이 진행 중인 채로 멈춘다
    release();
    const outcome = await Promise.race([worker.idle().then(() => 'idle'), new Promise((r) => setTimeout(() => r('hang'), 1_000))]);
    expect(outcome).toBe('idle');
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('도로 DB 경로: 환경변수·data 폴더에 없으면 null이고 테스트 픽스처로 조용히 대체하지 않는다', () => {
    const empty = tmp();
    expect(resolveRoadsPath(undefined, empty)).toBeNull();
    expect(resolveRoadsPath('', empty)).toBeNull();
    expect(resolveRoadsPath('/x/y.sqlite', empty)).toBe('/x/y.sqlite');
  });

  it('/viewer는 NUBI_VIEWER=1이거나 production이 아닐 때만 등록한다', async () => {
    expect((await newApp({ viewer: true }).request('/viewer')).status).toBe(200);
    expect((await newApp({ viewer: false }).request('/viewer')).status).toBe(404);
    const prev = { env: process.env.NODE_ENV, v: process.env.NUBI_VIEWER };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.NUBI_VIEWER;
      expect((await newApp().request('/viewer')).status).toBe(404);
      process.env.NUBI_VIEWER = '1';
      expect((await newApp().request('/viewer')).status).toBe(200);
    } finally {
      process.env.NODE_ENV = prev.env;
      if (prev.v === undefined) delete process.env.NUBI_VIEWER;
      else process.env.NUBI_VIEWER = prev.v;
    }
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
    const pts = line(1000, 400); // 400km (걸음 400m < breakage 2,000m)
    const chunks = splitTrace(pts);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.at(-1)).toBe(chunks[1]![0]);
    for (const c of chunks) {
      const km = (c.length - 1) * 0.4;
      expect(km * 1000).toBeLessThanOrEqual(MAX_DISTANCE_PER_REQUEST_M + 1);
    }
  });

  it('한 걸음이 breakage_distance(2,000m)를 넘는 점프에서 조각을 끊고 겹치는 점 없이 새 조각이 시작된다', () => {
    const a = line(10, 25);
    const b = makePoints(10, 25, 37.5665 + 3_000 / 111_195).map(({ lat, lon }) => ({ lat, lon })); // 3km 북쪽에서 다시 시작
    const chunks = splitTrace([...a, ...b]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(a);
    expect(chunks[1]).toEqual(b);
  });

  it('점프 사이에 외따로 남은 점은 요청에서 빠지고 unmatched로 센다', async () => {
    const far = (km: number) => ({ lat: 37.5665 + (km * 1000) / 111_195, lon: 126.978 });
    const pts = [...line(5, 25), far(5), ...line(5, 25).map((p) => ({ ...p, lat: p.lat + 10_000 / 111_195 }))];
    const chunks = splitTrace(pts);
    expect(chunks).toHaveLength(2); // 가운데 외톨이 점(5km 지점)은 조각이 못 된다
    const fetchFn = fakeValhalla((body) => matchedResponse([{ way_id: 1, length: 0.1 }], body.shape.length));
    const r = await traceAttributes(pts, { fetchFn });
    expect(fetchFn.calls).toHaveLength(2);
    expect(r.unmatchedPoints).toBe(1);
    expect(r.matchedPoints).toBe(10);
  });

  it('첫 점·분할 직후에도 누적 거리 한도를 넘는 걸음은 받지 않는다', () => {
    const chunkKm = (c: { lat: number; lon: number }[]) =>
      c.slice(1).reduce((d, p, i) => d + Math.hypot((p.lat - c[i]!.lat) * 111_195, (p.lon - c[i]!.lon) * 88_000), 0);
    // 걸음 400m, 한도 1,000m(점프 기준 2,000m 미만): 모든 조각이 한도 이내
    const chunks = splitTrace(line(30, 400), MAX_POINTS_PER_REQUEST, 1_000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(chunkKm(c)).toBeLessThanOrEqual(1_000 + 1);
    // 걸음 자체가 한도(1,000m)보다 크면(점프 기준 이하라도) 이어 붙이지 않고 끊는다 → 한 점짜리 조각은 만들지 않는다
    expect(splitTrace(line(5, 1_500), MAX_POINTS_PER_REQUEST, 1_000)).toEqual([]);
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
    expect(m.error).toBe('retryable:network');
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
    expect(m.error).toBe('permanent:http_400');
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
    expect((db.prepare('SELECT error FROM trip_matching').get() as { error: string }).error).toBe('permanent:retry_exhausted');
    worker.stop();
  });

  it('도로 DB가 없으면 재시도 대기(failed retryable)로 둔다', async () => {
    const app = newApp({ roadsPath: null, valhalla: { fetchFn: fakeValhalla(() => matchedResponse([], 1)) }, retryDelayMs: 1_000_000 });
    const { tripId } = await driveTrip(app);
    const m = await settle(app, tripId);
    expect(m.status).toBe('failed');
    expect(m.error).toBe('retryable:roads_db_unavailable');
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
