import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { openDb } from '../src/db/index.js';

export const ROADS_TEST_DB = fileURLToPath(new URL('./fixtures/roads-test.sqlite', import.meta.url));
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

export const newApp = (options: AppOptions = {}) =>
  createApp(openDb(':memory:'), { vehicleHmacKey: 'test-key', roadsPath: ROADS_TEST_DB, retryDelayMs: 5, ...options });
export type TestApp = ReturnType<typeof newApp>;

/** 서울 시청 부근을 북쪽으로 달리는 점 [n]개(약 [stepM]m 간격). */
export const makePoints = (n: number, stepM = 25, lat0 = 37.5665, lon = 126.978) =>
  Array.from({ length: n }, (_, seq) => ({
    seq,
    ts: new Date(Date.UTC(2026, 10, 9, 0, 0, seq * 2)).toISOString(),
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
  oneway?: 'yes' | null;
  lengthM: number;
  /** [lon, lat] 시작점. way는 이 점에서 동쪽으로 뻗는 직선으로 만든다. */
  at?: [number, number];
  name?: string;
};

/** 도로 DB 스키마(scripts/build-road-db.mjs)를 따르는 합성 DB. 분리 차로는 `oneway: 'yes'`·주요 4등급이면 총길이를 1/2로 센다. */
export const makeRoadsDb = async (path: string, ways: SynthWay[], month = '209901') => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ways(way_id INTEGER PRIMARY KEY, road_key TEXT NOT NULL, highway TEXT NOT NULL, name TEXT, ref TEXT, length_m REAL NOT NULL, oneway TEXT, eff_length_m REAL NOT NULL, minlon REAL, minlat REAL, maxlon REAL, maxlat REAL, geom_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE ways_rtree USING rtree(way_id, minlon, maxlon, minlat, maxlat);
    CREATE TABLE roads(road_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, highway_major TEXT NOT NULL, total_length_m REAL NOT NULL, way_count INTEGER NOT NULL, names_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE snapshot(month TEXT PRIMARY KEY, built_at TEXT NOT NULL, pbf_name TEXT NOT NULL, pbf_timestamp TEXT, total_named_length_m REAL NOT NULL, total_all_length_m REAL NOT NULL, by_class_json TEXT NOT NULL);
  `);
  const roads = new Map<string, { len: number; n: number; hw: string; names: Set<string> }>();
  let totalNamed = 0;
  db.exec('BEGIN');
  for (const w of ways) {
    const hw = w.highway ?? 'primary';
    const half = w.oneway === 'yes' && ['motorway', 'trunk', 'primary', 'secondary'].includes(hw);
    const eff = half ? w.lengthM / 2 : w.lengthM;
    const [lon, lat] = w.at ?? [127, 37];
    const dLon = w.lengthM / (111_195 * Math.cos((lat * Math.PI) / 180));
    db.prepare('INSERT INTO ways VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      w.id,
      w.roadKey,
      hw,
      w.name ?? null,
      null,
      w.lengthM,
      w.oneway ?? null,
      eff,
      lon,
      lat,
      lon + dLon,
      lat,
      JSON.stringify([
        [lon, lat],
        [lon + dLon, lat],
      ]),
    );
    db.prepare('INSERT INTO ways_rtree VALUES (?,?,?,?,?)').run(w.id, lon, lon + dLon, lat, lat);
    if (w.roadKey.startsWith('unnamed:')) continue;
    totalNamed += eff;
    const r = roads.get(w.roadKey) ?? { len: 0, n: 0, hw, names: new Set<string>() };
    r.len += eff;
    r.n++;
    if (w.name) r.names.add(w.name);
    roads.set(w.roadKey, r);
  }
  for (const [key, r] of roads) {
    db.prepare('INSERT INTO roads VALUES (?,?,?,?,?,?)').run(key, key.replace(/^\w+:/, ''), r.hw, r.len, r.n, JSON.stringify([...r.names]));
  }
  db.exec('COMMIT');
  db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?)').run(
    month,
    new Date().toISOString(),
    'synthetic.pbf',
    null,
    totalNamed,
    totalNamed,
    '{}',
  );
  db.close();
  return path;
};
