import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { openDb } from '../src/db/index.js';
// 도로 DB 규칙(분류·oneway·유효 길이·names_json·스키마)은 빌드 스크립트와 같은 모듈을 쓴다. 테스트가 규칙을 따로 구현하지 않는다.
// @ts-expect-error 타입 선언이 없는 .mjs
import { effLength, RoadAccumulator, SCHEMA_SQL, wayRecord, wayRowValues } from '../../scripts/road-rules.mjs';

export const ROADS_TEST_DB = fileURLToPath(new URL('./fixtures/roads-test.sqlite', import.meta.url));
export const REGIONS_TEST_DB = fileURLToPath(new URL('./fixtures/regions-test.sqlite', import.meta.url));
export const FIXTURE_NORTH = fileURLToPath(new URL('./fixtures/valhalla-e2e-north.json', import.meta.url));

export const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export type FakeEdge = { way_id: number; length: number };
export type FakeFetch = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
  calls: { url: string; body: any }[];
};

/** Valhalla를 흉내 내는 fetch. [respond]가 요청 본문을 받아 응답(JSON 또는 상태 코드)을 만든다. */
export const fakeValhalla = (respond: (body: any, n: number) => Response | object | Promise<Response | object>): FakeFetch => {
  const calls: { url: string; body: any }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    const out = await respond(body, calls.length);
    return out instanceof Response
      ? out
      : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FakeFetch;
  f.calls = calls;
  return f;
};

/** 모든 점이 matched인 응답. */
export const matchedResponse = (edges: FakeEdge[], pointCount: number, unmatched = 0) => ({
  units: 'kilometers',
  edges,
  matched_points: Array.from({ length: pointCount }, (_, i) => ({ type: i < unmatched ? 'unmatched' : 'matched', edge_index: 0 })),
});

/** 테스트 앱. 지역 DB도 도로 DB처럼 픽스처를 명시해 넘긴다(`regionsPath: null`이면 지역 DB 없음). 도로 DB는 항상 명시한다(기본은 테스트 픽스처). 로컬 전국 DB를 몰래 붙이지 않도록 `roadsPath: undefined`도 픽스처로 본다. */
export const newApp = (options: AppOptions = {}) =>
  createApp(openDb(':memory:'), {
    vehicleHmacKey: 'test-key',
    retryDelayMs: 5,
    liveMatching: false, // 실시간 잠정 매칭은 map.test.ts가 명시적으로 켠다(다른 테스트의 Valhalla 호출 수를 건드리지 않게)
    ...options,
    roadsPath: options.roadsPath === undefined ? ROADS_TEST_DB : options.roadsPath,
    regionsPath: options.regionsPath === undefined ? REGIONS_TEST_DB : options.regionsPath,
  });
export type TestApp = ReturnType<typeof newApp>;

/** 서울 시청 부근을 북쪽으로 달리는 점 [n]개(약 [stepM]m 간격). */
export const makePoints = (n: number, stepM = 25, lat0 = 37.5665, lon = 126.978, day = 9) =>
  Array.from({ length: n }, (_, seq) => ({
    seq,
    ts: new Date(Date.UTC(2026, 10, day, 0, 0, seq * 2)).toISOString(),
    lat: lat0 + (seq * stepM) / 111_195,
    lon,
  }));

/** 트립을 만들고 점을 올린 뒤 종료한다. 종료 응답과 tripId를 돌려준다. */
export const driveTrip = async (
  app: TestApp,
  opts: { vehicleId?: string; points?: ReturnType<typeof makePoints>; odoStart?: number | null; odoEnd?: number | null } = {},
) => {
  const vehicleId = opts.vehicleId ?? 'v1';
  const points = opts.points ?? makePoints(40);
  const start = await app.request(
    '/trips',
    json({
      localId: crypto.randomUUID(),
      vehicleId,
      driverId: vehicleId,
      startedAt: points[0]!.ts,
      odometerStartKm: opts.odoStart ?? null,
    }),
  );
  const { tripId } = (await start.json()) as { tripId: string };
  const up = await app.request(`/trips/${tripId}/points`, json({ points }));
  expect(up.status).toBe(200);
  const end = await app.request(`/trips/${tripId}/end`, json({ endedAt: points.at(-1)!.ts, odometerEndKm: opts.odoEnd ?? null }));
  expect(end.status).toBe(200);
  return { tripId, end: (await end.json()) as Record<string, unknown> };
};

export const getJson = async (app: TestApp, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as any };
};

export type SynthWay = {
  id: number;
  roadKey: string;
  highway?: string;
  /** OSM `oneway` 태그 값. motorway는 생략해도 일방통행(암묵)으로 본다. */
  oneway?: 'yes' | '-1' | 'no' | null;
  lengthM: number;
  /** [lon, lat] 시작점. way는 이 점에서 동쪽으로 뻗는 직선으로 만든다. */
  at?: [number, number];
  name?: string;
};

/** 도로 DB 스키마·규칙(scripts/road-rules.mjs)을 따르는 합성 DB. 분리 구간(주요 4등급 + 일방통행, motorway는 암묵)은 유효 길이를 1/2로 센다. */
export const makeRoadsDb = async (path: string, ways: SynthWay[], month = '209901') => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  const acc = new RoadAccumulator();
  let totalNamed = 0;
  db.exec('BEGIN');
  for (const w of ways) {
    const tags: Record<string, string> = { highway: w.highway ?? 'primary' };
    if (w.oneway) tags.oneway = w.oneway;
    if (w.name) tags.name = w.name;
    const [lon, lat] = w.at ?? [127, 37];
    const dLon = w.lengthM / (111_195 * Math.cos((lat * Math.PI) / 180));
    const rec = wayRecord(
      w.id,
      tags,
      [
        [lon, lat],
        [lon + dLon, lat],
      ],
      w.roadKey,
    );
    // 길이는 테스트가 정한 값 그대로 쓴다(하버사인 오차 없이 기대값을 정수로 적으려고).
    rec.len = w.lengthM;
    rec.eff = effLength(tags, w.lengthM);
    db.prepare('INSERT INTO ways VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...wayRowValues(rec));
    db.prepare('INSERT INTO ways_rtree VALUES (?,?,?,?,?)').run(w.id, rec.minlon, rec.maxlon, rec.minlat, rec.maxlat);
    if (rec.display === null) continue;
    totalNamed += rec.eff;
    acc.add(rec);
  }
  for (const r of acc.rows()) {
    db.prepare('INSERT INTO roads VALUES (?,?,?,?,?,?,?)').run(
      r.road_key,
      r.display_name,
      r.highway_major,
      r.total_length_m,
      r.split_length_m,
      r.way_count,
      r.names_json,
    );
  }
  db.exec('COMMIT');
  db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?,?)').run(
    month,
    new Date().toISOString(),
    'synthetic.pbf',
    null,
    totalNamed,
    totalNamed,
    '{}',
    null,
  );
  db.close();
  return path;
};

/** 도로 DB 스냅샷의 분모(km, 반올림 없음). */
export const snapshotTotalKm = async (path: string) => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare('SELECT total_named_length_m AS t FROM snapshot').get() as { t: number };
  db.close();
  return row.t / 1000;
};

/**
 * 사양 2장: `nationalPercentAfter − Before ≈ newKm / 분모 × 100`(퍼센트). 완료율은 소수 4자리로 반올림돼 있으므로
 * 비율로 환산한 오차 한도는 1e-6(두 값의 반올림 오차 합 1e-4 %p)에 newKm의 m 단위 반올림(0.0005km / 분모)을 더한 값이다.
 * 전국 분모(12만 km대)에서는 후자가 4e-9라 사실상 1e-6이고, 분모가 작은 테스트 DB에서만 후자가 눈에 띈다.
 */
export const expectNewKmConsistent = (
  r: { newKm: number; nationalPercentBefore: number; nationalPercentAfter: number },
  totalKm: number,
) => {
  const fromPercent = (r.nationalPercentAfter - r.nationalPercentBefore) / 100;
  expect(Math.abs(fromPercent - r.newKm / totalKm)).toBeLessThanOrEqual(1e-6 + 0.0005 / totalKm + 1e-9);
};
