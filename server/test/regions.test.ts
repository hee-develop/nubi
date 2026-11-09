import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { pointInMulti, pointInRing } from '../src/regions/index.js';
import { thinSamples } from '../src/regions/judge.js';
import { fakeValhalla, getJson, json, newApp, REGIONS_TEST_DB, ROADS_TEST_DB, type TestApp } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-regions-'));
const NATIONAL = new URL('../data/regions/regions.sqlite', import.meta.url).pathname;

type R = {
  code: string;
  name: string;
  sido: string;
  sidoName: string;
  rect: [number, number, number, number];
  d89?: boolean;
  d92?: boolean;
};
/** 직사각형 시군구만 담은 합성 지역 DB(스키마는 scripts/build-regions.mjs와 같다). */
const makeRegionsDb = (path: string, regions: R[], alias: [string, string][] = []) => {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE regions(code TEXT PRIMARY KEY, sido_code TEXT NOT NULL, name TEXT NOT NULL, sido_name TEXT NOT NULL,
      depop_89 INTEGER NOT NULL DEFAULT 0, depop_92 INTEGER NOT NULL DEFAULT 0, area_km2 REAL NOT NULL, polygons INTEGER NOT NULL,
      minlon REAL, minlat REAL, maxlon REAL, maxlat REAL, geom_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE regions_rtree USING rtree(region_id, minlon, maxlon, minlat, maxlat);
    CREATE TABLE region_alias(old_code TEXT PRIMARY KEY, new_code TEXT NOT NULL, new_name TEXT NOT NULL, new_sido_code TEXT NOT NULL, new_sido_name TEXT NOT NULL);
    CREATE TABLE snapshot(month TEXT PRIMARY KEY, built_at TEXT NOT NULL, source_name TEXT NOT NULL, region_count INTEGER NOT NULL,
      polygon_count INTEGER NOT NULL, depop_89_count INTEGER NOT NULL, depop_92_count INTEGER NOT NULL, note TEXT);`);
  for (const r of regions) {
    const [a, b, c, d] = r.rect;
    const geom = JSON.stringify({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [a, b],
            [c, b],
            [c, d],
            [a, d],
            [a, b],
          ],
        ],
      ],
    });
    const info = db
      .prepare('INSERT INTO regions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.code, r.sido, r.name, r.sidoName, r.d89 ? 1 : 0, r.d92 || r.d89 ? 1 : 0, 1, 1, a, b, c, d, geom);
    db.prepare('INSERT INTO regions_rtree VALUES (?,?,?,?,?)').run(Number(info.lastInsertRowid), a, c, b, d);
  }
  for (const [o, n] of alias) db.prepare('INSERT INTO region_alias VALUES (?,?,?,?,?)').run(o, n, n, '12', '통합');
  db.prepare("INSERT INTO snapshot VALUES ('209901','x','x',?,?,0,0,NULL)").run(regions.length, regions.length);
  db.close();
  return path;
};

// A 중앙, B 동(경계 공유), D 북(경계 공유, 안 가 봄), E 서(경계 공유, 인구감소지역), F 동쪽 약 200m 떨어짐(이웃 아님), C 멀리.
const LAYOUT: R[] = [
  { code: '11111', name: 'A구', sido: '11', sidoName: '가시', rect: [127.0, 37.0, 127.1, 37.1] },
  { code: '11112', name: 'B구', sido: '11', sidoName: '가시', rect: [127.1, 37.0, 127.2, 37.1] },
  { code: '11113', name: 'C군', sido: '11', sidoName: '가시', rect: [128.0, 37.0, 128.1, 37.1], d89: true },
  { code: '11114', name: 'D구', sido: '11', sidoName: '가시', rect: [127.0, 37.1, 127.1, 37.2] },
  { code: '11115', name: 'E군', sido: '11', sidoName: '가시', rect: [126.9, 37.0, 127.0, 37.1], d89: true },
  { code: '11116', name: 'F구', sido: '11', sidoName: '가시', rect: [127.2022, 37.0, 127.3, 37.1], d92: true },
];
const IN = { A: [127.05, 37.05], B: [127.15, 37.05], C: [128.05, 37.05], D: [127.05, 37.15], E: [126.95, 37.05] } as const;

const regionsApp = (extra: { alias?: [string, string][]; db?: ReturnType<typeof openDb> } = {}) => {
  const path = makeRegionsDb(join(tmp(), 'r.sqlite'), LAYOUT, extra.alias);
  return createApp(extra.db ?? openDb(':memory:'), { vehicleHmacKey: 'k', retryDelayMs: 5, roadsPath: ROADS_TEST_DB, regionsPath: path });
};

const ms = (iso: string) => Date.parse(iso);
const iso = (base: string, plusMin = 0) => new Date(ms(base) + plusMin * 60_000).toISOString();

/** 점이 20개 미만이라 맵매칭은 too_short로 끝나고 시군구 판정만 한다. 각 점은 [lon, lat], 1초 간격. */
const trip = async (app: TestApp, vehicleId: string, startAt: string, pts: (readonly [number, number])[], opts: { end?: boolean } = {}) => {
  const start = await app.request('/trips', json({ localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: startAt }));
  const { tripId } = (await start.json()) as { tripId: string };
  const points = pts
    .map(([lon, lat], seq) => ({ seq, ts: iso(startAt, 0).replace(/\.\d+Z$/, '') + '.000Z', lat, lon }))
    .map((p, i) => ({ ...p, ts: new Date(ms(startAt) + i * 1000).toISOString() }));
  await app.request(`/trips/${tripId}/points`, json({ points }));
  if (opts.end !== false) {
    await app.request(`/trips/${tripId}/end`, json({ endedAt: points.at(-1)!.ts, odometerEndKm: null }));
    await app.matching.idle();
  }
  return { tripId, endedAt: points.at(-1)!.ts };
};
const level = async (app: TestApp, v: string, code: string) =>
  ((await getJson(app, `/regions/list?vehicleId=${v}`)).body.items as { code: string; level: number }[]).find((i) => i.code === code)!
    .level;

describe('point-in-polygon', () => {
  const sq = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  const hole = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ];
  it('고리 안·밖, 구멍(도넛)과 MultiPolygon any', () => {
    expect(pointInRing(5, 5, sq)).toBe(true);
    expect(pointInRing(11, 5, sq)).toBe(false);
    expect(pointInMulti(5, 5, [[sq]])).toBe(true);
    expect(pointInMulti(5, 5, [[sq, hole]])).toBe(false); // 구멍 안은 밖
    expect(pointInMulti(2, 2, [[sq, hole]])).toBe(true);
    const far = [
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 30],
      [20, 20],
    ];
    expect(pointInMulti(25, 25, [[sq, hole], [far]])).toBe(true);
    expect(pointInMulti(15, 15, [[sq, hole], [far]])).toBe(false);
  });
  it('경계 바로 안쪽·바깥쪽 점을 가른다(미세 오차 1e-9도)', () => {
    expect(pointInRing(10 - 1e-9, 5, sq)).toBe(true);
    expect(pointInRing(10 + 1e-9, 5, sq)).toBe(false);
    expect(pointInRing(5, 1e-9, sq)).toBe(true);
    expect(pointInRing(5, -1e-9, sq)).toBe(false);
  });
  it('실제 픽스처: 세종대로 첫 점은 종로구, 끝 점은 중구', async () => {
    const app = newApp();
    const { body } = await getJson(app, '/regions/geo?vehicleId=v&bbox=126.9,37.5,127.1,37.6');
    const byCode = Object.fromEntries(body.features.map((f: any) => [f.properties.code, f.geometry.coordinates]));
    expect(pointInMulti(126.977065, 37.575162, byCode['11110'])).toBe(true);
    expect(pointInMulti(126.977065, 37.575162, byCode['11140'])).toBe(false);
    expect(pointInMulti(126.976073, 37.562023, byCode['11140'])).toBe(true);
  });
});

describe('표본 솎기', () => {
  it('200m 간격으로 솎고 처음·끝은 항상 남기며 상한을 넘으면 균등하게 줄인다', () => {
    const pts = Array.from({ length: 101 }, (_, i) => ({ lat: 37 + (i * 25) / 111_195, lon: 127, ts: String(i) }));
    const t = thinSamples(pts);
    expect(t[0]).toBe(pts[0]);
    expect(t.at(-1)).toBe(pts.at(-1));
    expect(t.length).toBeGreaterThanOrEqual(12);
    expect(t.length).toBeLessThanOrEqual(14); // 2,500m / 200m
    const many = Array.from({ length: 10_000 }, (_, i) => ({ lat: 37 + (i * 250) / 111_195, lon: 127, ts: String(i) }));
    const capped = thinSamples(many);
    expect(capped.length).toBe(2_000);
    expect(capped.at(-1)).toBe(many.at(-1));
  });
});

describe('판정: 통과', () => {
  it('통과는 level 1이고 처음 지난 시군구만 newPassed에 담긴다', async () => {
    const app = regionsApp();
    const t1 = await trip(app, 'v1', '2026-11-09T01:00:00Z', [IN.A, IN.B]);
    const m1 = (await getJson(app, `/trips/${t1.tripId}/matching`)).body;
    expect(m1.status).toBe('done');
    expect(m1.result.regions).toMatchObject({
      passed: ['11111', '11112'],
      newPassed: ['11111', '11112'],
      newPassedNames: ['A구', 'B구'],
      visitPending: '11112',
    });
    const t2 = await trip(app, 'v1', '2026-11-09T01:05:00Z', [IN.A, IN.D]);
    const m2 = (await getJson(app, `/trips/${t2.tripId}/matching`)).body;
    expect(m2.result.regions).toMatchObject({ passed: ['11111', '11114'], newPassed: ['11114'] });
    const s = (await getJson(app, '/regions/summary?vehicleId=v1')).body;
    expect(s).toMatchObject({ total: 6, colored: 3, byLevel: { '1': 3, '2': 0, '3': 0 } });
    // 다른 차량의 기록과 섞이지 않는다
    expect((await getJson(app, '/regions/summary?vehicleId=other')).body.colored).toBe(0);
  });

  it('시군구 밖에서 끝난 트립은 pending이 없고 passed도 비어 있다', async () => {
    const app = regionsApp();
    const t = await trip(app, 'v1', '2026-11-09T01:00:00Z', [
      [120, 30],
      [120.001, 30],
    ]);
    expect((await getJson(app, `/trips/${t.tripId}/matching`)).body.result.regions).toMatchObject({
      passed: [],
      newPassed: [],
      visitPending: null,
    });
  });
});

describe('판정: 방문·숙박', () => {
  const T0 = '2026-11-09T01:00:00Z'; // KST 10:00

  it('간격 10분 미만은 방문이 아니고 정확히 10분이면 방문(level 2)', async () => {
    const app = regionsApp();
    const a = await trip(app, 'gap9', T0, [IN.A, IN.A]);
    await trip(app, 'gap9', iso(a.endedAt, 9), [IN.A, IN.A]);
    expect(await level(app, 'gap9', '11111')).toBe(1);
    const b = await trip(app, 'gap10', T0, [IN.A, IN.A]);
    await trip(app, 'gap10', iso(b.endedAt, 10), [IN.A, IN.A]);
    expect(await level(app, 'gap10', '11111')).toBe(2);
    const s = (await getJson(app, '/regions/summary?vehicleId=gap10')).body;
    expect(s.byLevel).toEqual({ '1': 0, '2': 1, '3': 0 });
    expect(s.lastEvent).toMatchObject({ kind: 'visit', code: '11111', name: 'A구' });
  });

  it('방문은 다음 트립 Start 시점에 확정되고(Start만으로 반영), 종료 지점이 아닌 시군구는 통과로 남는다', async () => {
    const app = regionsApp();
    const a = await trip(app, 'v', T0, [IN.A, IN.B]); // B에서 종료
    await app.request('/trips', json({ localId: 'next', vehicleId: 'v', driverId: 'v', startedAt: iso(a.endedAt, 30) }));
    expect(await level(app, 'v', '11112')).toBe(2);
    expect(await level(app, 'v', '11111')).toBe(1);
  });

  it('숙박: 6시간 이상 + 자정(KST) 통과 + 같은 시군구에서 시작(첫 점이 올라온 뒤 확정)', async () => {
    const app = regionsApp();
    const a = await trip(app, 'v', '2026-11-09T12:00:00Z', [IN.A, IN.A]); // KST 21:00
    // 다음 날 06:00 KST(+9h)
    const startAt = iso(a.endedAt, 9 * 60);
    await app.request('/trips', json({ localId: 'n', vehicleId: 'v', driverId: 'v', startedAt: startAt }));
    expect(await level(app, 'v', '11111')).toBe(2); // Start 직후는 방문, 시작 지점을 아직 모른다
    const tripId = ((await getJson(app, '/trips?vehicleId=v')).body.trips as { tripId: string; localId: string }[]).find(
      (t) => t.localId === 'n',
    )!.tripId;
    await app.request(`/trips/${tripId}/points`, json({ points: [{ seq: 0, ts: startAt, lat: IN.A[1], lon: IN.A[0] }] }));
    expect(await level(app, 'v', '11111')).toBe(3);
    const s = (await getJson(app, '/regions/summary?vehicleId=v')).body;
    expect(s.lastEvent).toMatchObject({ kind: 'stay', code: '11111' });
    expect(s.byLevel).toEqual({ '1': 0, '2': 0, '3': 1 });
  });

  it('숙박 아님: 자정을 안 넘긴 6시간·자정을 넘긴 5시간 59분·다른 시군구에서 시작', async () => {
    const app = regionsApp();
    // 6시간 이상이지만 자정(KST)을 안 지남: 01:00Z(10:00 KST) → 08:00Z(17:00 KST)
    const a = await trip(app, 'noMidnight', '2026-11-09T01:00:00Z', [IN.A, IN.A]);
    await trip(app, 'noMidnight', iso(a.endedAt, 7 * 60), [IN.A, IN.A]);
    expect(await level(app, 'noMidnight', '11111')).toBe(2);
    // 자정을 지났지만 6시간 미만: 14:00Z(23:00 KST) → 19:59Z(04:59 KST)
    const b = await trip(app, 'short', '2026-11-09T14:00:00Z', [IN.A, IN.A]);
    await trip(app, 'short', iso(b.endedAt, 5 * 60 + 59), [IN.A, IN.A]);
    expect(await level(app, 'short', '11111')).toBe(2);
    // 다른 시군구에서 시작: 방문만
    const c = await trip(app, 'other', '2026-11-09T12:00:00Z', [IN.A, IN.A]);
    await trip(app, 'other', iso(c.endedAt, 9 * 60), [IN.B, IN.B]);
    expect(await level(app, 'other', '11111')).toBe(2);
    expect(await level(app, 'other', '11112')).toBe(1);
  });

  it('단계는 내려가지 않는다: 숙박(3) 뒤 짧은 간격 방문·통과가 와도 3', async () => {
    const app = regionsApp();
    const a = await trip(app, 'v', '2026-11-09T12:00:00Z', [IN.A, IN.A]);
    const b = await trip(app, 'v', iso(a.endedAt, 9 * 60), [IN.A, IN.A]);
    expect(await level(app, 'v', '11111')).toBe(3);
    await trip(app, 'v', iso(b.endedAt, 11), [IN.A, IN.A]); // 방문 간격
    await trip(app, 'v', iso(b.endedAt, 60), [IN.A, IN.B]); // 통과
    expect(await level(app, 'v', '11111')).toBe(3);
  });

  it('24시간 배치: 다음 트립이 안 오면 24시간 뒤 방문으로 확정, 그 전에는 그대로', async () => {
    const app = regionsApp();
    const a = await trip(app, 'v', T0, [IN.C, IN.C]);
    expect(app.regionsBatch(ms(a.endedAt) + 23 * 3_600_000)).toBe(0);
    expect(await level(app, 'v', '11113')).toBe(1);
    expect(app.regionsBatch(ms(a.endedAt) + 24 * 3_600_000 + 1)).toBe(1);
    expect(await level(app, 'v', '11113')).toBe(2);
    expect((await getJson(app, '/regions/summary?vehicleId=v')).body.lastEvent).toMatchObject({ kind: 'visit', code: '11113' });
    expect(app.regionsBatch(ms(a.endedAt) + 48 * 3_600_000)).toBe(0); // 멱등
  });

  it('매칭이 늦어도(다음 트립이 먼저 시작) 판정이 빠지지 않는다', async () => {
    const app = regionsApp();
    const a = await trip(app, 'v', T0, [IN.A, IN.A], { end: false });
    // 다음 트립 Start가 먼저 도착
    await app.request('/trips', json({ localId: 'x', vehicleId: 'v', driverId: 'v', startedAt: iso(T0, 60) }));
    await app.request(`/trips/${a.tripId}/end`, json({ endedAt: a.endedAt, odometerEndKm: null }));
    await app.matching.idle();
    expect(await level(app, 'v', '11111')).toBe(2);
  });
});

describe('통합특별시 alias 합산', () => {
  it('옛 코드로 쌓인 기록은 새 코드로 합산된다(단계 최댓값·횟수 합·시각 min/max)', async () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO visited_regions VALUES (?,?,?,?,?,?,?,?)');
    ins.run('v1', '99999', 3, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 2, 1, 1);
    ins.run('v1', '11113', 1, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', 1, 0, 0);
    ins.run('v2', '99999', 2, '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z', 1, 1, 0);
    db.prepare("INSERT INTO region_pending VALUES ('t1','v1','99999','2026-04-01T00:00:00Z',0)").run();
    const app = regionsApp({ alias: [['99999', '11113']], db });
    const rows = db.prepare('SELECT * FROM visited_regions ORDER BY vehicle_id, code').all();
    expect(rows).toEqual([
      {
        vehicle_id: 'v1',
        code: '11113',
        level: 3,
        first_at: '2026-01-01T00:00:00Z',
        last_at: '2026-03-02T00:00:00Z',
        passes: 3,
        visits: 1,
        stays: 1,
      },
      {
        vehicle_id: 'v2',
        code: '11113',
        level: 2,
        first_at: '2026-01-05T00:00:00Z',
        last_at: '2026-01-06T00:00:00Z',
        passes: 1,
        visits: 1,
        stays: 0,
      },
    ]);
    expect(db.prepare('SELECT code FROM region_pending').get()).toEqual({ code: '11113' });
    expect(await level(app, 'v1', '11113')).toBe(3);
  });
});

describe('조회 API', () => {
  it('summary: 도감 분모·인구감소지역(89/92) 집계와 byLevel', async () => {
    const app = regionsApp();
    await trip(app, 'v', '2026-11-09T01:00:00Z', [IN.C, IN.C]);
    const s = (await getJson(app, '/regions/summary?vehicleId=v')).body;
    // C군은 89·92 모두, F구는 92만(신규 편입), E군은 89·92
    expect(s).toMatchObject({ total: 6, colored: 1, depop: { total89: 2, colored89: 1, total92: 3, colored92: 1 } });
    expect(s.attribution).toContain('vuski/admdongkor');
    expect(s.snapshotMonth).toBe('209901');
    expect((await getJson(app, '/regions/summary')).status).toBe(400);
  });

  it('list: filter·sort', async () => {
    const app = regionsApp();
    await trip(app, 'v', '2026-11-09T01:00:00Z', [IN.A, IN.A]);
    await trip(app, 'v', '2026-11-09T03:00:00Z', [IN.C, IN.C]);
    const get = async (qs: string) => ((await getJson(app, `/regions/list?vehicleId=v&${qs}`)).body.items as any[]).map((i) => i.code);
    expect(await get('filter=all&sort=name')).toEqual(['11111', '11112', '11113', '11114', '11115', '11116']);
    expect(await get('filter=depop')).toEqual(['11113', '11115', '11116']);
    expect(await get('filter=uncolored')).toEqual(['11112', '11114', '11115', '11116']);
    expect((await get('sort=recent')).slice(0, 2)).toEqual(['11113', '11111']); // 최근 지난 순, 미방문은 뒤
    expect((await getJson(app, '/regions/list?vehicleId=v&filter=x')).status).toBe(400);
    const c = ((await getJson(app, '/regions/list?vehicleId=v')).body.items as any[]).find((i) => i.code === '11113');
    expect(c).toMatchObject({ name: 'C군', sidoName: '가시', level: 1, depop89: true, depop92: true });
    expect(c.firstAt).toBeTruthy();
  });

  it('geo: bbox 검증(한 변 ≤ 3°)·GeoJSON·level 속성', async () => {
    const app = regionsApp();
    await trip(app, 'v', '2026-11-09T01:00:00Z', [IN.A, IN.A]);
    const ok = (await getJson(app, '/regions/geo?vehicleId=v&bbox=126.95,37.0,127.15,37.1')).body;
    expect(ok.type).toBe('FeatureCollection');
    const props = Object.fromEntries(ok.features.map((f: any) => [f.properties.code, f.properties]));
    expect(props['11111']).toEqual({ code: '11111', name: 'A구', level: 1, depop89: false });
    expect(props['11115'].depop89).toBe(true);
    expect(ok.features[0].geometry.type).toBe('MultiPolygon');
    expect(ok.attribution).toContain('CC BY 4.0');
    expect((await getJson(app, '/regions/geo?vehicleId=v&bbox=120,30,123.1,31')).status).toBe(400); // 경도 3.1°
    expect((await getJson(app, '/regions/geo?vehicleId=v&bbox=120,30,123,33')).status).toBe(200); // 정확히 3°
    expect((await getJson(app, '/regions/geo?vehicleId=v&bbox=bad')).status).toBe(400);
  });

  it('neighbors: 경계 공유(50m 미만)만, 안 가 본 곳 → 인구감소지역 → 이름 순', async () => {
    const app = regionsApp();
    await trip(app, 'v', '2026-11-09T01:00:00Z', [IN.B, IN.B]); // B는 이미 칠함
    const body = (await getJson(app, '/regions/neighbors?code=11111&vehicleId=v')).body;
    // A의 이웃: B(동, 칠함), D(북), E(서, 인구감소). F는 B 너머라 아님.
    expect(body.items.map((i: any) => i.code)).toEqual(['11115', '11114', '11112']);
    expect(body.items[0]).toMatchObject({ name: 'E군', level: 0, depop89: true, distanceM: 0 });
    expect(body.items[2].level).toBe(1);
    // B의 이웃: A(변 공유)와 D(꼭짓점만 닿음). F는 약 200m 떨어져 있어 이웃이 아니다
    const b = (await getJson(app, '/regions/neighbors?code=11112')).body;
    expect(b.items.map((i: any) => i.code)).toEqual(['11111', '11114']);
    expect(body.attribution).toBeTruthy();
    expect((await getJson(app, '/regions/neighbors?code=00000')).status).toBe(404);
    expect((await getJson(app, '/regions/neighbors')).status).toBe(400);
  });
});

describe('지역 DB 없음', () => {
  it('지역 API는 503, 매칭은 regions_db_unavailable로 재시도 대기', async () => {
    const app = newApp({ regionsPath: null, valhalla: { fetchFn: fakeValhalla(() => ({ edges: [], matched_points: [] })) } });
    for (const path of [
      '/regions/summary?vehicleId=v',
      '/regions/list?vehicleId=v',
      '/regions/geo?bbox=1,1,2,2',
      '/regions/neighbors?code=11110',
    ]) {
      const r = await getJson(app, path);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: 'regions_db_unavailable', snapshotMonth: null });
      expect(r.body.attribution).toContain('SGIS');
    }
    const t = await trip(app, 'v', '2026-11-09T01:00:00Z', [IN.A, IN.A], { end: true });
    const m = (await getJson(app, `/trips/${t.tripId}/matching`)).body;
    expect(m).toMatchObject({ status: 'failed', error: 'retryable:regions_db_unavailable' });
    app.matching.stop();
  });
});

describe.skipIf(!existsSync(NATIONAL))('전국 지역 DB(server/data/regions/regions.sqlite)', () => {
  it('도감 분모 229·인구감소지역 89/92, 세종대로 점은 종로구·중구', async () => {
    const app = createApp(openDb(':memory:'), { vehicleHmacKey: 'k', roadsPath: ROADS_TEST_DB, regionsPath: NATIONAL });
    const s = (await getJson(app, '/regions/summary?vehicleId=none')).body;
    expect(s).toMatchObject({ total: 229, colored: 0, depop: { total89: 89, colored89: 0, total92: 92, colored92: 0 } });
    const wrap = app as unknown as TestApp;
    const t = await trip(wrap, 'v', '2026-11-09T01:00:00Z', [
      [126.977065, 37.575162],
      [126.976073, 37.562023],
    ]);
    expect((await getJson(wrap, `/trips/${t.tripId}/matching`)).body.result.regions.newPassedNames).toEqual(['종로구', '중구']);
    // 종로구의 이웃에는 중구가 들어가고, 이웃 목록은 안 가 본 곳이 먼저다(종로구·중구는 방금 칠함 → 뒤로)
    const n = (await getJson(wrap, '/regions/neighbors?code=11110&vehicleId=v')).body.items as { code: string; level: number }[];
    expect(n.map((i) => i.code)).toContain('11140');
    expect(n.findIndex((i) => i.level > 0)).toBeGreaterThan(n.findIndex((i) => i.level === 0));
    // 통합특별시: 광주 동구(옛 29110)는 새 코드 12210
    const g = (await getJson(wrap, '/regions/list?vehicleId=v')).body.items as { code: string; sidoName: string }[];
    expect(g.find((i) => i.code === '12210')?.sidoName).toBe('전남광주통합특별시');
  });
});

describe('픽스처', () => {
  it('regions-test.sqlite는 종로·중·용산·성동 + 홍천·양구·인제를 담는다', async () => {
    const app = newApp();
    const s = (await getJson(app, '/regions/summary?vehicleId=v')).body;
    expect(s).toMatchObject({ total: 7, depop: { total89: 2, total92: 2 } });
    expect(REGIONS_TEST_DB).toContain('regions-test.sqlite');
  });
});
