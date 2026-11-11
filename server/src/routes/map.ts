import { Hono, type Context } from 'hono';
import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import type { LiveMatcher } from '../matching/live.js';
import { RG, REGIONS_ATTRIBUTION, type Regions } from '../regions/index.js';
import { ATTRIBUTION, DRIVEN_CTE, RD, VEHICLE_SET_SQL, type Roads } from '../roads/index.js';
import { authenticate, bearerOf, canAccessVehicle } from '../ext/auth.js';
import { parseAuthMode, type ExtDeps } from '../ext/util.js';
import { isFaded } from '../shared/fade.js';
import { VISITED_CTE } from './regions.js';

/** `/map/base` 한 응답의 way 상한. 넘으면 중요한 등급부터 남기고 `truncated: true`. */
export const MAP_MAX_WAYS = 8_000;
export const MAP_MAX_LIVE_WAYS = 3_000;
/** 도형 응답 서버 캐시 칸 수(최근 사용 순). 차량마다 다른 `d`는 캐시에 넣지 않고 매번 합친다. */
export const SHAPE_CACHE_MAX = 64;
/** `/map/regions` bbox 한 변 상한(도). 전국(약 8°)이 한 칸에 들어간다. */
export const MAX_REGION_SPAN_DEG = 20;
/** 소유 확인에 필요한 값. 차량 ID(쿼리)나 트립 ID(경로) 중 있는 것만 채운다. */
export type MapAccessRequest = { vehicleId?: string; tripId?: string };

/**
 * 지도 API의 접근 확인 지점(한 곳). T2 인증 규칙(ext/auth.ts)에 연결한다: `off`면 항상 허용, `optional`·`required`면 유효한 토큰이 있고
 * 요청이 가리키는 차량(쿼리 vehicleId·트립 소유 차량)이 모두 토큰 범위 안일 때만 허용(`optional`은 토큰이 아예 없으면 기존처럼 허용). false면 403이다.
 * 전역 미들웨어(ext.middleware)가 같은 검사를 앞에서 하므로 이중 방어이고, 라우트가 미들웨어 없이 마운트돼도 열리지 않게 한다.
 */
export const mapAccess =
  (deps: Pick<ExtDeps, 'db' | 'now' | 'options'>) =>
  (c: Context, req: MapAccessRequest): boolean => {
    const mode = deps.options.auth ?? parseAuthMode(process.env.NUBI_AUTH);
    if (mode === 'off') return true;
    if (!bearerOf(c)) return mode === 'optional';
    const info = authenticate(deps, c);
    if (!info) return false;
    return [req.vehicleId, req.tripId === undefined ? undefined : tripVehicle(deps.db, req.tripId)].every((v) => v === undefined || v === null || canAccessVehicle(deps.db, info, v));
  };

const tripVehicle = (db: Db, tripId: string): string | null => (db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(tripId) as { vehicle_id: string } | undefined)?.vehicle_id ?? null;

/** `/map/*` 요청 제한: 키(차량 ID, 없으면 `anon`)마다 [RATE_WINDOW_MS] 동안 [RATE_MAX]번. 전국 보기 한 화면이 칸 10여 개를 한꺼번에 묻는 것을 감안한 값이다. */
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX = 80;

type Cls = 'mw' | 'pr' | 'sc' | 'mn';

/** z별 한 변 상한(도). */
export const maxSpanDeg = (z: number) => (z < 9 ? 3 : z < 11 ? 2 : z < 13 ? 0.5 : 0.15);

/** z별로 그릴 등급(계약서 3장): z<9 mw, z<11 +pr, z<13 +sc, 그 위 전부. */
export const classesForZ = (z: number): Cls[] => (z < 9 ? ['mw'] : z < 11 ? ['mw', 'pr'] : z < 13 ? ['mw', 'pr', 'sc'] : ['mw', 'pr', 'sc', 'mn']);

const clsOf = (highway: string): Cls => {
  const major = highway.replace(/_link$/, '');
  if (major === 'motorway' || major === 'trunk') return 'mw';
  if (major === 'primary') return 'pr';
  if (major === 'secondary' || major === 'tertiary') return 'sc';
  return 'mn';
};

/** `_link`(연결로)는 목록에 넣고 z<13에서만 쿼리가 뺀다. */
const CLS_HIGHWAYS: Record<Cls, string[]> = {
  mw: ['motorway', 'trunk', 'motorway_link', 'trunk_link'],
  pr: ['primary', 'primary_link'],
  sc: ['secondary', 'tertiary', 'secondary_link', 'tertiary_link'],
  mn: ['unclassified', 'residential'],
};

/** 한 단계 중요도(작을수록 중요). 상한을 넘을 때 중요한 길부터 남긴다. */
const RANK_SQL = `CASE w.highway WHEN 'motorway' THEN 0 WHEN 'trunk' THEN 0 WHEN 'motorway_link' THEN 0 WHEN 'trunk_link' THEN 0 WHEN 'primary' THEN 1 WHEN 'primary_link' THEN 1 WHEN 'secondary' THEN 2 WHEN 'tertiary' THEN 2 WHEN 'secondary_link' THEN 2 WHEN 'tertiary_link' THEN 2 ELSE 3 END`;

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

type Pt = [number, number];

/** Douglas-Peucker(반복형). 허용 오차 [tol]은 도 단위(경도·위도 같은 값으로 취급, 한국 위도에서는 경도가 ~20% 짧아 지도에서 오차가 약간 작게 남는다). */
export const simplify = (pts: Pt[], tol: number): Pt[] => {
  if (pts.length <= 2 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      let d2: number;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > t2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
};

/** z에서 화면 1픽셀(256px 타일 기준)에 해당하는 도. */
export const pixelDeg = (z: number) => 360 / (256 * 2 ** z);

/** 좌표를 z에 맞춰 단순화하고 소수 5자리로 줄인다. 점이 2개 미만으로 줄지 않는다. */
export const shapeFor = (coords: Pt[], z: number): Pt[] => {
  const s = simplify(coords, pixelDeg(z));
  const out: Pt[] = [];
  for (const [x, y] of s) {
    const p: Pt = [r5(x), r5(y)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length >= 2 ? out : [[r5(coords[0]![0]), r5(coords[0]![1])], [r5(coords.at(-1)![0]), r5(coords.at(-1)![1])]];
};

const parseBbox = (raw: string | undefined) => {
  const b = (raw ?? '').split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
  if (b.length !== 4 || !b.every(Number.isFinite)) return null;
  const [minlon, minlat, maxlon, maxlat] = b as [number, number, number, number];
  if (minlon < -180 || maxlon > 180 || minlat < -90 || maxlat > 90 || minlon >= maxlon || minlat >= maxlat) return null;
  return { minlon, minlat, maxlon, maxlat };
};

const parseZ = (raw: string | undefined) => {
  if (!/^\d{1,2}$/.test(raw ?? '')) return null;
  const z = Number(raw);
  return z >= 0 && z <= 22 ? z : null;
};

/**
 * 차량 지도 API(계약서 05 3장): 바탕 도로(`/map/base`), 시군구 칠(`/map/regions`), 주행 중 잠정 새 도로(`/trips/:id/live`).
 * 바탕 타일은 쓰지 않는다. 서버가 주는 도형만 클라이언트가 그린다.
 */
export const mapRoutes = (
  db: Db,
  getRoads: () => Roads | null,
  getRegions: () => Regions | null,
  live?: LiveMatcher,
  now: () => number = Date.now,
  /** 접근 확인. 생략하면 전부 거부한다(fail-closed): app.ts가 [mapAccess]를 넘긴다. */
  access: (c: Context, req: MapAccessRequest) => boolean = () => false,
) => {
  const unavailable = () => ({ error: 'roads_db_unavailable' as const });
  const shapeCache = new Map<string, { ways: { id: number; cls: Cls; rk: string; c: Pt[] }[]; truncated: boolean }>();
  const hits = new Map<string, number[]>();
  /** 요청 제한(슬라이딩 창). 넘으면 true. */
  const limited = (key: string) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 2_000) for (const [k, v] of hits) if (t - v.at(-1)! >= RATE_WINDOW_MS) hits.delete(k);
    return list.length > RATE_MAX;
  };

  return new Hono()
    .get('/map/base', (c) => {
      const roads = getRoads();
      if (!roads) return c.json(unavailable(), 503);
      const z = parseZ(c.req.query('z'));
      if (z === null) return c.json({ error: 'invalid_z' as const }, 400);
      const bbox = parseBbox(c.req.query('bbox'));
      const span = maxSpanDeg(z);
      if (!bbox || bbox.maxlon - bbox.minlon > span || bbox.maxlat - bbox.minlat > span) return c.json({ error: 'invalid_bbox' as const }, 400);
      const rawVehicle = c.req.query('vehicleId');
      if (!access(c, { vehicleId: rawVehicle })) return c.json({ error: 'forbidden' as const }, 403);
      if (limited(rawVehicle ?? 'anon')) return c.json({ error: 'rate_limited' as const }, 429);
      const vehicleId = rawVehicle ? canonicalVehicleId(db, rawVehicle) : null;
      const highways = classesForZ(z).flatMap((k) => CLS_HIGHWAYS[k]);
      // 도형은 차량과 무관하니 (스냅샷 월·z·bbox) 단위로 캐시하고, 그 차량의 달린 길 정보(d)만 매번 합친다.
      const key = `${roads.month}|${z}|${[bbox.minlon, bbox.minlat, bbox.maxlon, bbox.maxlat].join(',')}`;
      let shaped = shapeCache.get(key);
      if (shaped) {
        shapeCache.delete(key);
      } else {
        // 낮은 z에서는 짧은 연결로(_link)를 빼고, 이름 없는 way(그 차량 완료율에 안 들어가는 길)는 항상 뺀다.
        const linkFilter = z < 13 ? "AND w.highway NOT LIKE '%\\_link' ESCAPE '\\'" : '';
        // 낮은 z에서는 화면에서 1.5픽셀도 안 되는 짧은 조각을 뺀다(상한 8,000을 큰 길에 쓰려고).
        const tinyFilter = z < 13 ? `AND (w.maxlon - w.minlon) + (w.maxlat - w.minlat) >= ${pixelDeg(z) * 1.5}` : '';
        const rows = db
          .prepare(
            `SELECT w.way_id, w.highway, w.road_key, w.geom_json FROM ${RD}.ways w
             WHERE w.way_id IN (SELECT way_id FROM ${RD}.ways_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
               AND w.highway IN (${highways.map(() => '?').join(',')}) ${linkFilter} AND w.road_key NOT LIKE 'unnamed:%' ${tinyFilter}
             ORDER BY ${RANK_SQL}, w.length_m DESC, w.way_id LIMIT ?`,
          )
          .all(bbox.maxlon, bbox.minlon, bbox.maxlat, bbox.minlat, ...highways, MAP_MAX_WAYS + 1) as { way_id: number; highway: string; road_key: string; geom_json: string }[];
        shaped = {
          truncated: rows.length > MAP_MAX_WAYS,
          ways: rows.slice(0, MAP_MAX_WAYS).map((r) => ({ id: r.way_id, cls: clsOf(r.highway), rk: r.road_key, c: shapeFor(JSON.parse(r.geom_json) as Pt[], z) })),
        };
      }
      shapeCache.set(key, shaped);
      while (shapeCache.size > SHAPE_CACHE_MAX) shapeCache.delete(shapeCache.keys().next().value!);
      const driven = new Map<number, { cov: number; last: string }>();
      if (vehicleId) {
        const rows = db
          .prepare(
            `WITH ${DRIVEN_CTE} SELECT d.way_id, d.cov, d.last FROM d
             WHERE d.way_id IN (SELECT way_id FROM ${RD}.ways_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)`,
          )
          .all(vehicleId, vehicleId, bbox.maxlon, bbox.minlon, bbox.maxlat, bbox.minlat) as { way_id: number; cov: number; last: string }[];
        for (const r of rows) driven.set(r.way_id, r);
      }
      const ways = shaped.ways.map((w) => {
        const d = driven.get(w.id);
        return d ? { ...w, d: { at: d.last, cov: Math.round(d.cov * 100) / 100 } } : w;
      });
      return c.json({ z, truncated: shaped.truncated, snapshotMonth: roads.month, attribution: ATTRIBUTION, ways }, 200);
    })
    .get('/map/regions', (c) => {
      // 시군구 칠. `/regions/geo`는 bbox 한 변이 3°를 넘으면 거절해 전국 보기를 못 그리므로, z별로 단순화한 도형을 상한 없이 주는 지도 전용 경로를 둔다.
      const regions = getRegions();
      if (!regions) return c.json({ error: 'regions_db_unavailable' as const }, 503);
      const parsedZ = parseZ(c.req.query('z'));
      if (parsedZ === null) return c.json({ error: 'invalid_z' as const }, 400);
      const z = Math.min(parsedZ, 13); // 13보다 확대해도 시군구 도형은 z13 단순화면 충분하다
      const bbox = parseBbox(c.req.query('bbox'));
      if (!bbox || bbox.maxlon - bbox.minlon > MAX_REGION_SPAN_DEG || bbox.maxlat - bbox.minlat > MAX_REGION_SPAN_DEG) return c.json({ error: 'invalid_bbox' as const }, 400);
      const rawVehicle = c.req.query('vehicleId');
      if (!access(c, { vehicleId: rawVehicle })) return c.json({ error: 'forbidden' as const }, 403);
      if (limited(rawVehicle ?? 'anon')) return c.json({ error: 'rate_limited' as const }, 429);
      const vehicleId = canonicalVehicleId(db, rawVehicle ?? '');
      const rows = db
        .prepare(
          `WITH ${VISITED_CTE}
           SELECT r.code, r.display_name, r.depop_92, r.geom_json, COALESCE(v.level, 0) AS level, v.last_at
           FROM ${RG}.regions r LEFT JOIN v ON v.code = r.code
           WHERE r.rowid IN (SELECT region_id FROM ${RG}.regions_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
           ORDER BY r.code`,
        )
        .all(vehicleId, vehicleId, bbox.maxlon, bbox.minlon, bbox.maxlat, bbox.minlat) as {
        code: string;
        display_name: string;
        depop_92: number;
        geom_json: string;
        level: number;
        last_at: string | null;
      }[];
      const nowMs = now();
      return c.json(
        {
          z,
          snapshotMonth: regions.month,
          attribution: REGIONS_ATTRIBUTION,
          regions: rows.map((r) => {
            const g = JSON.parse(r.geom_json) as { coordinates: Pt[][][] };
            const polys = g.coordinates
              .map((poly) => poly.map((ring) => closeRing(shapeFor(ring, z), ring)).filter((ring) => ring.length >= 4))
              .filter((poly) => poly.length > 0);
            return {
              code: r.code,
              name: r.display_name,
              level: r.level,
              depop: r.depop_92 === 1,
              faded: r.level > 0 && r.last_at !== null && isFaded(r.last_at, nowMs),
              p: polys,
            };
          }),
        },
        200,
      );
    })
    .get('/trips/:tripId/live', (c) => {
      const tripId = c.req.param('tripId');
      const trip = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(tripId) as { vehicle_id: string } | undefined;
      if (!trip) return c.json({ error: 'not_found' as const }, 404);
      if (!access(c, { tripId, vehicleId: trip.vehicle_id })) return c.json({ error: 'forbidden' as const }, 403);
      const sinceRaw = c.req.query('since');
      if (sinceRaw !== undefined && !/^\d{1,12}$/.test(sinceRaw)) return c.json({ error: 'invalid_since' as const }, 400);
      const since = Number(sinceRaw ?? 0);
      const prog = db.prepare('SELECT up_to_seq FROM trip_live WHERE trip_id = ?').get(tripId) as { up_to_seq: number } | undefined;
      const status = live?.isBusy(tripId) ? ('running' as const) : prog ? ('ready' as const) : ('idle' as const);
      const cursor = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM trip_live_ways WHERE trip_id = ?').get(tripId) as { m: number }).m;
      // `since` 이후(rowid)의 새 잠정 way만 준다. 처음 받을 때(since=0)와 한꺼번에 많이 쌓였을 때는 최신 쪽 [MAP_MAX_LIVE_WAYS]개만 남긴다.
      // 도로 DB가 없으면(ATTACH 안 됨) 도형을 붙일 수 없으니 빈 목록이다.
      const rows = (getRoads()
        ? (
            db
              .prepare(
                `SELECT l.way_id, l.is_new, w.geom_json FROM trip_live_ways l LEFT JOIN ${RD}.ways w ON w.way_id = l.way_id
                 WHERE l.trip_id = ? AND l.rowid > ? ORDER BY l.rowid DESC LIMIT ?`,
              )
              .all(tripId, since, MAP_MAX_LIVE_WAYS) as { way_id: number; is_new: number; geom_json: string | null }[]
          ).reverse()
        : []) as { way_id: number; is_new: number; geom_json: string | null }[];
      const last = db.prepare('SELECT lat, lon FROM trip_points WHERE trip_id = ? ORDER BY seq DESC LIMIT 1').get(tripId) as
        { lat: number; lon: number } | undefined;
      let region: { code: string; displayName: string; level: number; firstTime: boolean } | undefined;
      const regions = getRegions();
      if (last && regions) {
        const found = regions.locate(last.lon, last.lat);
        const code = found ? regions.canonical(found) : null;
        const info = code ? regions.names().get(code) : undefined;
        if (code && info) {
          const vehicleId = canonicalVehicleId(db, trip.vehicle_id);
          const lv = db
            .prepare(`SELECT COALESCE(MAX(level), 0) AS level FROM visited_regions WHERE code = ? AND vehicle_id IN ${VEHICLE_SET_SQL}`)
            .get(code, vehicleId, vehicleId) as { level: number };
          region = { code, displayName: info.displayName, level: lv.level, firstTime: lv.level === 0 };
        }
      }
      return c.json(
        {
          status,
          upToSeq: prog?.up_to_seq ?? -1,
          cursor,
          // 화면은 z14 기준이라 도형을 z14 단순화로 준다(응답 크기).
          ways: rows
            .filter((r) => r.geom_json !== null)
            .map((r) => ({ id: r.way_id, c: shapeFor(JSON.parse(r.geom_json!) as Pt[], 14), isNew: r.is_new === 1 })),
          ...(region ? { region } : {}),
        },
        200,
      );
    });
};

/** 단순화로 링이 3점 아래로 줄거나 열리면 원본 링의 처음·끝을 닫아 준다(채우기 오류 방지). */
const closeRing = (shaped: Pt[], original: Pt[]): Pt[] => {
  const ring = shaped.length >= 4 ? shaped : original.map(([x, y]) => [r5(x), r5(y)] as Pt);
  const f = ring[0]!;
  const l = ring.at(-1)!;
  return f[0] === l[0] && f[1] === l[1] ? ring : [...ring, f];
};
