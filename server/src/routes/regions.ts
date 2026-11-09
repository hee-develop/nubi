import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { RG, REGIONS_ATTRIBUTION, type Regions } from '../regions/index.js';
import { nearestRegions, neighborsOf } from '../regions/neighbors.js';
import { VEHICLE_SET_SQL } from '../roads/index.js';

export const MAX_REGION_BBOX_SPAN_DEG = 3;
/** `/regions/geo` 도형 캐시: bbox 문자열 단위, 최대 개수·유효 시간. */
export const GEO_CACHE_MAX = 50;
export const GEO_CACHE_TTL_MS = 5 * 60_000;

/** 차량의 시군구별 기록(alias 합산) CTE `v(code, level, first_at, last_at)`. 바인딩 값은 [vehicleId] 두 번. */
const VISITED_CTE = `v AS (
  SELECT code, MAX(level) AS level, MIN(first_at) AS first_at, MAX(last_at) AS last_at,
    SUM(passes) AS passes, SUM(visits) AS visits, SUM(stays) AS stays
  FROM visited_regions WHERE vehicle_id IN ${VEHICLE_SET_SQL} GROUP BY code
)`;

/** 사양 03 5장. 모든 응답에 snapshotMonth·attribution(행정동 경계 출처)을 싣는다. 지역 DB가 없으면 503. */
export const regionsRoutes = (db: Db, getRegions: () => Regions | null) => {
  const base = (r: Regions | null) => ({ snapshotMonth: r?.month ?? null, attribution: REGIONS_ATTRIBUTION });
  const geoCache = new Map<
    string,
    {
      at: number;
      items: {
        code: string;
        name: string;
        displayName: string;
        depop89: boolean;
        geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
      }[];
    }
  >();
  const unavailable = () => ({ error: 'regions_db_unavailable' as const, snapshotMonth: null, attribution: REGIONS_ATTRIBUTION });

  return new Hono()
    .get('/summary', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' as const, ...base(getRegions()) }, 400);
      const regions = getRegions();
      if (!regions) return c.json(unavailable(), 503);
      const n = db
        .prepare(
          `WITH ${VISITED_CTE}
           SELECT COUNT(*) AS total,
             COALESCE(SUM(COALESCE(v.level, 0) >= 1), 0) AS colored,
             COALESCE(SUM(v.level = 1), 0) AS l1, COALESCE(SUM(v.level = 2), 0) AS l2, COALESCE(SUM(v.level = 3), 0) AS l3,
             COALESCE(SUM(r.depop_89), 0) AS total89, COALESCE(SUM(r.depop_89 = 1 AND COALESCE(v.level, 0) >= 1), 0) AS colored89,
             COALESCE(SUM(r.depop_92), 0) AS total92, COALESCE(SUM(r.depop_92 = 1 AND COALESCE(v.level, 0) >= 1), 0) AS colored92
           FROM ${RG}.regions r LEFT JOIN v ON v.code = r.code`,
        )
        .get(vehicleId, vehicleId) as Record<string, number>;
      const ev = db
        .prepare(
          `SELECT e.kind, e.code, e.at, e.trip_id, r.display_name AS name, r.sido_name FROM region_events e JOIN ${RG}.regions r ON r.code = e.code
           WHERE e.kind IN ('visit', 'stay') AND e.vehicle_id IN ${VEHICLE_SET_SQL}
           ORDER BY e.at DESC, CASE e.kind WHEN 'stay' THEN 1 ELSE 0 END DESC, e.id DESC LIMIT 1`,
        )
        .get(vehicleId, vehicleId) as
        { kind: string; code: string; at: string; trip_id: string; name: string; sido_name: string } | undefined;
      return c.json(
        {
          ...base(regions),
          total: n.total!,
          colored: n.colored!,
          byLevel: { '1': n.l1!, '2': n.l2!, '3': n.l3! },
          // 현행 지정 92곳이 기본(total·colored), 89곳(2021 지정)은 통계 인용용 참고 필드
          depop: { total: n.total92!, colored: n.colored92!, total89: n.total89!, colored89: n.colored89! },
          lastEvent: ev
            ? { kind: ev.kind as 'visit' | 'stay', code: ev.code, name: ev.name, sidoName: ev.sido_name, at: ev.at, tripId: ev.trip_id }
            : null,
        },
        200,
      );
    })
    .get('/list', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' as const, ...base(getRegions()) }, 400);
      const regions = getRegions();
      if (!regions) return c.json(unavailable(), 503);
      const filter = c.req.query('filter') ?? 'all';
      const sort = c.req.query('sort') ?? 'name';
      if (!['all', 'depop', 'uncolored'].includes(filter)) return c.json({ error: 'invalid_filter' as const, ...base(regions) }, 400);
      if (!['recent', 'name'].includes(sort)) return c.json({ error: 'invalid_sort' as const, ...base(regions) }, 400);
      const where = { all: '', depop: 'WHERE r.depop_89 = 1 OR r.depop_92 = 1', uncolored: 'WHERE COALESCE(v.level, 0) = 0' }[filter]!;
      // recent: 최근 지난 순(미방문은 뒤). name: 시도 코드 → 이름.
      const order = sort === 'recent' ? 'v.last_at IS NULL, v.last_at DESC, r.code' : 'r.sido_code, r.name, r.code';
      const rows = db
        .prepare(
          `WITH ${VISITED_CTE}
           SELECT r.code, r.name, r.display_name, r.sido_name, COALESCE(v.level, 0) AS level, r.depop_89, r.depop_92, v.first_at, v.last_at,
             COALESCE(v.passes, 0) AS passes, COALESCE(v.visits, 0) AS visits, COALESCE(v.stays, 0) AS stays
           FROM ${RG}.regions r LEFT JOIN v ON v.code = r.code ${where} ORDER BY ${order}`,
        )
        .all(vehicleId, vehicleId) as {
        code: string;
        name: string;
        display_name: string;
        sido_name: string;
        level: number;
        depop_89: number;
        depop_92: number;
        first_at: string | null;
        last_at: string | null;
        passes: number;
        visits: number;
        stays: number;
      }[];
      return c.json(
        {
          ...base(regions),
          items: rows.map((r) => ({
            code: r.code,
            name: r.name,
            displayName: r.display_name,
            sidoName: r.sido_name,
            level: r.level,
            depop89: r.depop_89 === 1,
            depop92: r.depop_92 === 1,
            firstAt: r.first_at,
            lastAt: r.last_at,
            passes: r.passes,
            visits: r.visits,
            stays: r.stays,
          })),
        },
        200,
      );
    })
    .get('/geo', (c) => {
      const regions = getRegions();
      if (!regions) return c.json(unavailable(), 503);
      const vehicleId = c.req.query('vehicleId') ?? '';
      const bbox = (c.req.query('bbox') ?? '').split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
      const [minlon, minlat, maxlon, maxlat] = bbox as [number, number, number, number];
      const valid =
        bbox.length === 4 &&
        bbox.every(Number.isFinite) &&
        minlon >= -180 &&
        maxlon <= 180 &&
        minlat >= -90 &&
        maxlat <= 90 &&
        minlon < maxlon &&
        minlat < maxlat &&
        maxlon - minlon <= MAX_REGION_BBOX_SPAN_DEG &&
        maxlat - minlat <= MAX_REGION_BBOX_SPAN_DEG;
      if (!valid) return c.json({ error: 'invalid_bbox' as const, ...base(regions) }, 400);
      // 도형(폴리곤 파싱 포함)은 bbox 단위로 캐시하고(최대 50개·5분), 차량별 단계는 가벼운 쿼리로 매번 새로 붙인다.
      const key = bbox.join(',');
      let shapes = geoCache.get(key);
      if (!shapes || shapes.at + GEO_CACHE_TTL_MS <= Date.now()) {
        const rows = db
          .prepare(
            `SELECT r.code, r.name, r.display_name, r.depop_89, r.geom_json FROM ${RG}.regions r
             WHERE r.rowid IN (SELECT region_id FROM ${RG}.regions_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
             ORDER BY r.code`,
          )
          .all(maxlon, minlon, maxlat, minlat) as {
          code: string;
          name: string;
          display_name: string;
          depop_89: number;
          geom_json: string;
        }[];
        shapes = {
          at: Date.now(),
          items: rows.map((r) => ({
            code: r.code,
            name: r.name,
            displayName: r.display_name,
            depop89: r.depop_89 === 1,
            geometry: JSON.parse(r.geom_json) as { type: 'MultiPolygon'; coordinates: number[][][][] },
          })),
        };
        geoCache.delete(key);
        geoCache.set(key, shapes);
        while (geoCache.size > GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value!);
      }
      const levels = new Map(
        (db.prepare(`WITH ${VISITED_CTE} SELECT code, level FROM v`).all(vehicleId, vehicleId) as { code: string; level: number }[]).map(
          (r) => [r.code, r.level],
        ),
      );
      return c.json(
        {
          type: 'FeatureCollection' as const,
          ...base(regions),
          features: shapes.items.map((r) => ({
            type: 'Feature' as const,
            geometry: r.geometry,
            properties: { code: r.code, name: r.name, displayName: r.displayName, level: levels.get(r.code) ?? 0, depop89: r.depop89 },
          })),
        },
        200,
      );
    })
    .get('/neighbors', (c) => {
      const regions = getRegions();
      if (!regions) return c.json(unavailable(), 503);
      const code = c.req.query('code') ?? '';
      if (!/^\d{5}$/.test(code)) return c.json({ error: 'code_required' as const, ...base(regions) }, 400);
      const code2 = regions.canonical(code);
      const found = neighborsOf(db, regions, code2);
      if (!found) return c.json({ error: 'not_found' as const, ...base(regions) }, 404);
      const vehicleId = c.req.query('vehicleId') ?? '';
      const names = regions.names();
      const info = db
        .prepare(
          `WITH ${VISITED_CTE} SELECT r.code, COALESCE(v.level, 0) AS level, r.depop_89, r.depop_92 FROM ${RG}.regions r LEFT JOIN v ON v.code = r.code`,
        )
        .all(vehicleId, vehicleId) as { code: string; level: number; depop_89: number; depop_92: number }[];
      const byCode = new Map(info.map((r) => [r.code, r]));
      const nearest = found.length === 0; // 이웃이 없는 섬 등: 중심점 거리순 가까운 3곳으로 대신한다
      const list = nearest ? nearestRegions(db, code2, 3) : found;
      const items = list
        .map((f) => {
          const r = byCode.get(f.code)!;
          return {
            code: f.code,
            name: names.get(f.code)?.name ?? f.code,
            displayName: names.get(f.code)?.displayName ?? f.code,
            sidoName: names.get(f.code)?.sidoName ?? '',
            level: r.level,
            depop89: r.depop_89 === 1,
            depop92: r.depop_92 === 1,
            distanceM: f.distanceM,
            ...(nearest ? { nearest: true as const } : {}),
          };
        })
        // 안 가 본 곳(level 0) 먼저, 그 안에서 인구감소지역(89 또는 92) 먼저, 그다음 이름순. 이웃 대신 가까운 곳이면 거리순 그대로.
        .sort((a, b) =>
          nearest
            ? 0
            : Number(b.level === 0) - Number(a.level === 0) ||
              Number(b.depop89 || b.depop92) - Number(a.depop89 || a.depop92) ||
              a.level - b.level ||
              a.name.localeCompare(b.name, 'ko'),
        );
      return c.json(
        {
          ...base(regions),
          code: code2,
          name: names.get(code2)?.name ?? code2,
          displayName: names.get(code2)?.displayName ?? code2,
          items,
        },
        200,
      );
    });
};
