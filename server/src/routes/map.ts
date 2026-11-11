import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import type { LiveMatcher } from '../matching/live.js';
import { RG, REGIONS_ATTRIBUTION, type Regions } from '../regions/index.js';
import { ATTRIBUTION, DRIVEN_CTE, RD, VEHICLE_SET_SQL, type Roads } from '../roads/index.js';
import { VISITED_CTE } from './regions.js';

/** `/map/base` 한 응답의 way 상한. 넘으면 중요한 등급부터 남기고 `truncated: true`. */
export const MAP_MAX_WAYS = 8_000;
export const MAP_MAX_LIVE_WAYS = 3_000;
/** 바램 판정 기준일(T2의 shared/fade.ts `isFaded`와 같은 365일). */
export const FADE_DAYS = 365;

type Cls = 'mw' | 'pr' | 'sc' | 'mn';

/** z별 한 변 상한(도). */
export const maxSpanDeg = (z: number) => (z < 9 ? 6 : z < 11 ? 2 : z < 13 ? 0.5 : 0.15);

/** z별로 그릴 등급(계약서 3장): z<9 mw, z<11 +pr, z<13 +sc, 그 위 전부. */
export const classesForZ = (z: number): Cls[] => (z < 9 ? ['mw'] : z < 11 ? ['mw', 'pr'] : z < 13 ? ['mw', 'pr', 'sc'] : ['mw', 'pr', 'sc', 'mn']);

const clsOf = (highway: string): Cls => {
  const major = highway.replace(/_link$/, '');
  if (major === 'motorway' || major === 'trunk') return 'mw';
  if (major === 'primary') return 'pr';
  if (major === 'secondary' || major === 'tertiary') return 'sc';
  return 'mn';
};

const CLS_HIGHWAYS: Record<Cls, string[]> = {
  mw: ['motorway', 'trunk'],
  pr: ['primary'],
  sc: ['secondary', 'tertiary'],
  mn: ['unclassified', 'residential'],
};

/** 한 단계 중요도(작을수록 중요). 상한을 넘을 때 중요한 길부터 남긴다. */
const RANK_SQL = `CASE w.highway WHEN 'motorway' THEN 0 WHEN 'trunk' THEN 0 WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 WHEN 'tertiary' THEN 2 ELSE 3 END`;

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
export const mapRoutes = (db: Db, getRoads: () => Roads | null, getRegions: () => Regions | null, live?: LiveMatcher, now: () => number = Date.now) => {
  const unavailable = () => ({ error: 'roads_db_unavailable' as const });

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
      const vehicleId = rawVehicle ? canonicalVehicleId(db, rawVehicle) : null;
      const highways = classesForZ(z).flatMap((k) => CLS_HIGHWAYS[k]);
      // 낮은 z에서는 짧은 연결로(_link)를 빼고, 이름 없는 way(그 차량 완료율에 안 들어가는 길)는 항상 뺀다.
      const linkFilter = z < 13 ? "AND w.highway NOT LIKE '%\\_link' ESCAPE '\\'" : '';
      // 낮은 z에서는 화면에서 1.5픽셀도 안 되는 짧은 조각을 뺀다(상한 8,000을 큰 길에 쓰려고).
      const tinyFilter = z < 13 ? `AND (w.maxlon - w.minlon) + (w.maxlat - w.minlat) >= ${pixelDeg(z) * 1.5}` : '';
      const sql = `${vehicleId ? `WITH ${DRIVEN_CTE}` : ''}
        SELECT w.way_id, w.highway, w.road_key, w.geom_json${vehicleId ? ', d.cov, d.last' : ''}
        FROM ${RD}.ways w ${vehicleId ? 'LEFT JOIN d ON d.way_id = w.way_id' : ''}
        WHERE w.way_id IN (SELECT way_id FROM ${RD}.ways_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
          AND w.highway IN (${highways.map(() => '?').join(',')}) ${linkFilter} AND w.road_key NOT LIKE 'unnamed:%' ${tinyFilter}
        ORDER BY ${RANK_SQL}, w.length_m DESC, w.way_id LIMIT ?`;
      const args = [...(vehicleId ? [vehicleId, vehicleId] : []), bbox.maxlon, bbox.minlon, bbox.maxlat, bbox.minlat, ...highways, MAP_MAX_WAYS + 1];
      const rows = db.prepare(sql).all(...args) as {
        way_id: number;
        highway: string;
        road_key: string;
        geom_json: string;
        cov?: number | null;
        last?: string | null;
      }[];
      const truncated = rows.length > MAP_MAX_WAYS;
      const ways = rows.slice(0, MAP_MAX_WAYS).map((r) => {
        const cls = clsOf(r.highway);
        return {
          id: r.way_id,
          cls,
          rk: r.road_key,
          c: shapeFor(JSON.parse(r.geom_json) as Pt[], z),
          ...(r.last ? { d: { at: r.last, cov: Math.round((r.cov ?? 0) * 100) / 100 } } : {}),
        };
      });
      return c.json({ z, truncated, snapshotMonth: roads.month, attribution: ATTRIBUTION, ways }, 200);
    })
    .get('/map/regions', (c) => {
      // 시군구 칠. `/regions/geo`는 bbox 한 변이 3°를 넘으면 거절해 전국 보기를 못 그리므로, z별로 단순화한 도형을 상한 없이 주는 지도 전용 경로를 둔다.
      const regions = getRegions();
      if (!regions) return c.json({ error: 'regions_db_unavailable' as const }, 503);
      const z = parseZ(c.req.query('z'));
      if (z === null) return c.json({ error: 'invalid_z' as const }, 400);
      const bbox = parseBbox(c.req.query('bbox'));
      if (!bbox) return c.json({ error: 'invalid_bbox' as const }, 400);
      const vehicleId = canonicalVehicleId(db, c.req.query('vehicleId') ?? '');
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
              faded: r.level > 0 && r.last_at !== null && nowMs - Date.parse(r.last_at) > FADE_DAYS * 86_400_000,
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
      const prog = db.prepare('SELECT up_to_seq FROM trip_live WHERE trip_id = ?').get(tripId) as { up_to_seq: number } | undefined;
      const status = live?.isBusy(tripId) ? ('running' as const) : prog ? ('ready' as const) : ('idle' as const);
      // 도로 DB가 없으면(ATTACH 안 됨) 도형을 붙일 수 없으니 빈 목록이다.
      const rows = (getRoads()
        ? db
        .prepare(
          `SELECT l.way_id, l.is_new, w.geom_json FROM trip_live_ways l LEFT JOIN ${RD}.ways w ON w.way_id = l.way_id
           WHERE l.trip_id = ? ORDER BY l.rowid LIMIT ?`,
        )
        .all(tripId, MAP_MAX_LIVE_WAYS)
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
          ways: rows
            .filter((r) => r.geom_json !== null)
            .map((r) => ({ id: r.way_id, c: (JSON.parse(r.geom_json!) as Pt[]).map(([x, y]) => [r5(x), r5(y)]), isNew: r.is_new === 1 })),
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
