import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { RG, REGIONS_ATTRIBUTION, type Regions } from '../regions/index.js';
import { neighborsOf } from '../regions/neighbors.js';
import { VEHICLE_SET_SQL } from '../roads/index.js';

export const MAX_REGION_BBOX_SPAN_DEG = 3;

/** 차량의 시군구별 기록(alias 합산) CTE `v(code, level, first_at, last_at)`. 바인딩 값은 [vehicleId] 두 번. */
const VISITED_CTE = `v AS (
  SELECT code, MAX(level) AS level, MIN(first_at) AS first_at, MAX(last_at) AS last_at
  FROM visited_regions WHERE vehicle_id IN ${VEHICLE_SET_SQL} GROUP BY code
)`;

/** 사양 03 5장. 모든 응답에 snapshotMonth·attribution(행정동 경계 출처)을 싣는다. 지역 DB가 없으면 503. */
export const regionsRoutes = (db: Db, getRegions: () => Regions | null) => {
  const base = (r: Regions | null) => ({ snapshotMonth: r?.month ?? null, attribution: REGIONS_ATTRIBUTION });
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
          `SELECT e.kind, e.code, e.at, e.trip_id, r.name, r.sido_name FROM region_events e JOIN ${RG}.regions r ON r.code = e.code
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
          depop: { total89: n.total89!, colored89: n.colored89!, total92: n.total92!, colored92: n.colored92! },
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
           SELECT r.code, r.name, r.sido_name, COALESCE(v.level, 0) AS level, r.depop_89, r.depop_92, v.first_at, v.last_at
           FROM ${RG}.regions r LEFT JOIN v ON v.code = r.code ${where} ORDER BY ${order}`,
        )
        .all(vehicleId, vehicleId) as {
        code: string;
        name: string;
        sido_name: string;
        level: number;
        depop_89: number;
        depop_92: number;
        first_at: string | null;
        last_at: string | null;
      }[];
      return c.json(
        {
          ...base(regions),
          items: rows.map((r) => ({
            code: r.code,
            name: r.name,
            sidoName: r.sido_name,
            level: r.level,
            depop89: r.depop_89 === 1,
            depop92: r.depop_92 === 1,
            firstAt: r.first_at,
            lastAt: r.last_at,
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
      const rows = db
        .prepare(
          `WITH ${VISITED_CTE}
           SELECT r.code, r.name, COALESCE(v.level, 0) AS level, r.depop_89, r.geom_json
           FROM ${RG}.regions r LEFT JOIN v ON v.code = r.code
           WHERE r.rowid IN (SELECT region_id FROM ${RG}.regions_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
           ORDER BY r.code`,
        )
        .all(vehicleId, vehicleId, maxlon, minlon, maxlat, minlat) as {
        code: string;
        name: string;
        level: number;
        depop_89: number;
        geom_json: string;
      }[];
      return c.json(
        {
          type: 'FeatureCollection' as const,
          ...base(regions),
          features: rows.map((r) => ({
            type: 'Feature' as const,
            geometry: JSON.parse(r.geom_json) as { type: 'MultiPolygon'; coordinates: number[][][][] },
            properties: { code: r.code, name: r.name, level: r.level, depop89: r.depop_89 === 1 },
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
      const items = found
        .map((f) => {
          const r = byCode.get(f.code)!;
          return {
            code: f.code,
            name: names.get(f.code)?.name ?? f.code,
            sidoName: names.get(f.code)?.sidoName ?? '',
            level: r.level,
            depop89: r.depop_89 === 1,
            depop92: r.depop_92 === 1,
            distanceM: f.distanceM,
          };
        })
        // 안 가 본 곳(level 0) 먼저, 그 안에서 인구감소지역(89 또는 92) 먼저, 그다음 이름순.
        .sort(
          (a, b) =>
            Number(b.level === 0) - Number(a.level === 0) ||
            Number(b.depop89 || b.depop92) - Number(a.depop89 || a.depop92) ||
            a.level - b.level ||
            a.name.localeCompare(b.name, 'ko'),
        );
      return c.json({ ...base(regions), code: code2, name: names.get(code2)?.name ?? code2, items }, 200);
    });
};
