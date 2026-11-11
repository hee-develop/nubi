import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { kstDayRange, kstMonthRange, iso, type ExtDeps } from '../ext/util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { RG } from '../regions/index.js';
import { RD, VEHICLE_SET_SQL } from '../roads/index.js';

const EARTH_RADIUS_M = 6_371_008.8;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Report = {
  tripCount: number;
  distanceKm: number;
  newKm: number;
  newWays: number;
  revivedKm: number;
  newRegions: { code: string; displayName: string; sidoName: string }[];
  newStays: { code: string; displayName: string; sidoName: string }[];
};

/** [fromMs, toMs) 사이에 시작한 그 차량의 트립 요약. 차량 ID는 정본이고 alias 트립을 합친다. */
const buildReport = (deps: ExtDeps, vehicleId: string, fromMs: number, toMs: number): Report & { daysDriven: number } => {
  const { db } = deps;
  const args = [vehicleId, vehicleId, iso(fromMs), iso(toMs)];
  const range = `FROM trips WHERE vehicle_id IN ${VEHICLE_SET_SQL} AND started_at >= ? AND started_at < ?`;
  const trips = db.prepare(`SELECT COUNT(*) AS n ${range}`).get(...args) as { n: number };
  const dist = db
    .prepare(
      `WITH p AS (
         SELECT trip_id, lat, lon, LAG(lat) OVER w AS plat, LAG(lon) OVER w AS plon FROM trip_points
         WHERE trip_id IN (SELECT id ${range}) WINDOW w AS (PARTITION BY trip_id ORDER BY seq)
       )
       SELECT COALESCE(SUM(CASE WHEN plat IS NULL THEN 0 ELSE
         2 * ${EARTH_RADIUS_M} * asin(min(1.0, sqrt(
           sin(radians(lat - plat) / 2) * sin(radians(lat - plat) / 2) +
           cos(radians(plat)) * cos(radians(lat)) * sin(radians(lon - plon) / 2) * sin(radians(lon - plon) / 2)))) END), 0) AS d FROM p`,
    )
    .get(...args) as { d: number };
  const matched = db
    .prepare(
      `SELECT COALESCE(SUM(json_extract(m.result_json, '$.newKm')), 0) AS km, COALESCE(SUM(json_extract(m.result_json, '$.newWays')), 0) AS ways
       FROM trip_matching m WHERE m.status = 'done' AND m.result_json IS NOT NULL AND m.trip_id IN (SELECT id ${range})`,
    )
    .get(...args) as { km: number; ways: number };
  const days = db.prepare(`SELECT COUNT(DISTINCT date(julianday(started_at) + 9.0/24)) AS n ${range}`).get(...args) as { n: number };
  const roads = deps.getRoads();
  const revived = roads
    ? (db
        .prepare(
          `SELECT COALESCE(SUM(w.eff_length_m), 0) AS m FROM way_revived r JOIN ${RD}.ways w ON w.way_id = r.way_id
           WHERE r.vehicle_id IN ${VEHICLE_SET_SQL} AND r.revived_at >= ? AND r.revived_at < ?`,
        )
        .get(vehicleId, vehicleId, iso(fromMs), iso(toMs)) as { m: number })
    : { m: 0 };
  const regionsOf = (kind: 'pass' | 'stay') =>
    deps.getRegions()
      ? (
          db
            .prepare(
              `SELECT r.code, r.display_name, r.sido_name FROM region_events e JOIN ${RG}.regions r ON r.code = e.code
               WHERE e.kind = ? AND e.trip_id IN (SELECT id ${range}) GROUP BY r.code ORDER BY MIN(e.at)`,
            )
            .all(kind, ...args) as { code: string; display_name: string; sido_name: string }[]
        ).map((r) => ({ code: r.code, displayName: r.display_name, sidoName: r.sido_name }))
      : [];
  return {
    tripCount: trips.n,
    distanceKm: round2(dist.d / 1000),
    newKm: round2(matched.km),
    newWays: matched.ways,
    revivedKm: round2(revived.m / 1000),
    newRegions: regionsOf('pass'),
    newStays: regionsOf('stay'),
    daysDriven: days.n,
  };
};

const needVehicle = (db: Db, id: string | undefined) => (id ? canonicalVehicleId(db, id) : null);

/** 일간·월간 리포트(KST). 새 도로 km·처음 지난 시군구·되살린 거리·트립 수·거리. 좌표·way id는 담지 않는다. */
export const reportsRoutes = (deps: ExtDeps) =>
  new Hono()
    .get('/reports/daily', (c) => {
      const vehicleId = needVehicle(deps.db, c.req.query('vehicleId'));
      if (!vehicleId) return c.json({ error: 'vehicleId_required' }, 400);
      const date = c.req.query('date') ?? '';
      const range = kstDayRange(date);
      if (!range) return c.json({ error: 'invalid_date' }, 400);
      const { daysDriven: _d, ...r } = buildReport(deps, vehicleId, range[0], range[1]);
      return c.json({ date, ...r }, 200);
    })
    .get('/reports/monthly', (c) => {
      const vehicleId = needVehicle(deps.db, c.req.query('vehicleId'));
      if (!vehicleId) return c.json({ error: 'vehicleId_required' }, 400);
      const month = c.req.query('month') ?? '';
      const range = kstMonthRange(month);
      if (!range) return c.json({ error: 'invalid_month' }, 400);
      return c.json({ month, ...buildReport(deps, vehicleId, range[0], range[1]) }, 200);
    });
