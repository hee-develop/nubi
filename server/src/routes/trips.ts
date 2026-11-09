import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { queueMatching } from '../matching/worker.js';

const MAX_POINTS_PER_BATCH = 500;
const MAX_ID_LENGTH = 128;
export const MAX_BODY_BYTES = 1024 * 1024;

const iso = z.string().datetime({ offset: true });
const nullableNumber = z.number().finite().nullish();
const id = z.string().min(1).max(MAX_ID_LENGTH);

/** 시각은 오프셋이 달라도 UTC(ISO, Z)로 정규화해 저장한다. */
const toUtc = (value: string) => new Date(value).toISOString();

const startBody = z.object({
  localId: id,
  vehicleId: id,
  driverId: id,
  startedAt: iso,
  odometerStartKm: nullableNumber,
});

const pointSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: iso,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  headingDeg: z.number().min(0).max(360).nullish(),
  confidence: nullableNumber,
  // 차량 앱은 속도를 수집하지 않는다. 과거 데이터 호환용으로만 받는다.
  speedKph: nullableNumber,
  gear: z.enum(['P', 'R', 'N', 'D']).nullish(),
});

const pointsBody = z.object({ points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_BATCH) });

const endBody = z.object({ endedAt: iso, odometerEndKm: nullableNumber });

type TripRow = {
  id: string;
  local_id: string | null;
  vehicle_id: string;
  driver_id: string;
  started_at: string;
  ended_at: string | null;
  odometer_start_km: number | null;
  odometer_end_km: number | null;
  point_count: number;
  distance_m: number;
};

type PointRow = {
  seq: number;
  ts: string;
  lat: number;
  lon: number;
  heading_deg: number | null;
  confidence: number | null;
  speed_kph: number | null;
  gear: string | null;
};

const EARTH_RADIUS_M = 6_371_008.8;

export const haversineM = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

const toPoint = (r: PointRow) => ({
  seq: r.seq,
  ts: r.ts,
  lat: r.lat,
  lon: r.lon,
  headingDeg: r.heading_deg,
  confidence: r.confidence,
  speedKph: r.speed_kph,
  gear: r.gear as 'P' | 'R' | 'N' | 'D' | null,
});

/**
 * 요약(점 수·거리)은 저장하지 않고 조회 때 SQL 한 번으로 계산한다. 종료 뒤에 늦게 도착한 점도 자동으로 반영되고, 목록도 쿼리 1회다.
 * [pageSql]은 `page` CTE 본문(트립 행을 고르는 SELECT)이다.
 */
const summaryQuery = (pageSql: string) => `
  WITH page AS (${pageSql}),
  p AS (
    SELECT trip_id, lat, lon,
           LAG(lat) OVER w AS plat, LAG(lon) OVER w AS plon
    FROM trip_points
    WHERE trip_id IN (SELECT id FROM page)
    WINDOW w AS (PARTITION BY trip_id ORDER BY seq)
  ),
  s AS (
    SELECT trip_id, COUNT(*) AS n,
           SUM(CASE WHEN plat IS NULL THEN 0 ELSE
             2 * ${EARTH_RADIUS_M} * asin(min(1.0, sqrt(
               sin(radians(lat - plat) / 2) * sin(radians(lat - plat) / 2) +
               cos(radians(plat)) * cos(radians(lat)) * sin(radians(lon - plon) / 2) * sin(radians(lon - plon) / 2)
             ))) END) AS d
    FROM p GROUP BY trip_id
  )
  SELECT page.*, COALESCE(s.n, 0) AS point_count, COALESCE(s.d, 0) AS distance_m
  FROM page LEFT JOIN s ON s.trip_id = page.id
  ORDER BY page.started_at DESC, page.created_at DESC`;

const toSummary = (trip: TripRow) => {
  const durationS = trip.ended_at ? Math.max(0, Math.round((Date.parse(trip.ended_at) - Date.parse(trip.started_at)) / 1000)) : null;
  return {
    tripId: trip.id,
    localId: trip.local_id,
    vehicleId: trip.vehicle_id,
    driverId: trip.driver_id,
    startedAt: trip.started_at,
    endedAt: trip.ended_at,
    odometerStartKm: trip.odometer_start_km,
    odometerEndKm: trip.odometer_end_km,
    pointCount: trip.point_count,
    distanceM: Math.round(trip.distance_m * 10) / 10,
    durationS,
  };
};

const getSummary = (db: Db, tripId: string) => {
  const row = db.prepare(summaryQuery('SELECT * FROM trips WHERE id = ?')).get(tripId) as TripRow | undefined;
  return row ? toSummary(row) : undefined;
};

const tripExists = (db: Db, tripId: string) => db.prepare('SELECT 1 AS x FROM trips WHERE id = ?').get(tripId) !== undefined;

const readJson = async (req: Request): Promise<unknown> => {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
};

/** 시군구 판정 훅(사양 03 4장). [onStarted]: 새 트립 Start를 받았을 때, [onPoints]: 점을 받았을 때(차량 ID). */
export type RegionHooks = { onStarted?: (vehicleId: string) => void; onPoints?: (vehicleId: string) => void };

/** [onEnded]: 트립이 처음 끝나 맵매칭 작업이 새로 큐에 들어갔을 때 부른다. */
export const tripsRoutes = (db: Db, onEnded: (tripId: string) => void = () => {}, hooks: RegionHooks = {}) =>
  new Hono()
    .use(
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: 'payload_too_large' }, 413),
      }),
    )
    .post('/', async (c) => {
      const parsed = startBody.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      const b = parsed.data;
      // 같은 (vehicleId, localId)로 다시 오면(재시도·응답 유실) 새로 만들지 않고 기존 tripId를 돌려준다.
      const r = db
        .prepare(
          'INSERT OR IGNORE INTO trips (id, local_id, vehicle_id, driver_id, started_at, odometer_start_km, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), b.localId, b.vehicleId, b.driverId, toUtc(b.startedAt), b.odometerStartKm ?? null, new Date().toISOString());
      const row = db.prepare('SELECT id FROM trips WHERE vehicle_id = ? AND local_id = ?').get(b.vehicleId, b.localId) as { id: string };
      hooks.onStarted?.(b.vehicleId);
      return c.json({ tripId: row.id }, Number(r.changes) > 0 ? 201 : 200);
    })
    .post('/:tripId/points', async (c) => {
      const tripId = c.req.param('tripId');
      const parsed = pointsBody.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      if (!tripExists(db, tripId)) return c.json({ error: 'not_found' }, 404);
      // 종료된 트립에도 점을 받는다. 재시도 순서 때문에 End보다 늦게 도착할 수 있고, 요약은 조회 때 계산하므로 항상 일치한다.
      const insert = db.prepare(
        'INSERT OR IGNORE INTO trip_points (trip_id, seq, ts, lat, lon, heading_deg, confidence, speed_kph, gear) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      let accepted = 0;
      db.exec('BEGIN');
      try {
        for (const p of parsed.data.points) {
          const r = insert.run(
            tripId,
            p.seq,
            toUtc(p.ts),
            p.lat,
            p.lon,
            p.headingDeg ?? null,
            p.confidence ?? null,
            p.speedKph ?? null,
            p.gear ?? null,
          );
          accepted += Number(r.changes);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      if (accepted > 0) {
        const t = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(tripId) as { vehicle_id: string };
        hooks.onPoints?.(t.vehicle_id);
      }
      return c.json({ accepted, duplicated: parsed.data.points.length - accepted }, 200);
    })
    .post('/:tripId/end', async (c) => {
      const parsed = endBody.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      const tripId = c.req.param('tripId');
      if (!tripExists(db, tripId)) return c.json({ error: 'not_found' }, 404);
      // 멱등: 이미 종료된 트립의 종료 시각은 그대로 둔다. 다만 처음 End(복구 End 등)에 오도미터가 없었고 이번 요청에 있으면 채운다.
      db.prepare('UPDATE trips SET ended_at = COALESCE(ended_at, ?), odometer_end_km = COALESCE(odometer_end_km, ?) WHERE id = ?').run(
        toUtc(parsed.data.endedAt),
        parsed.data.odometerEndKm ?? null,
        tripId,
      );
      const s = getSummary(db, tripId)!;
      // 맵매칭은 응답과 무관하게 뒤에서 돈다. 같은 End를 다시 받으면 큐에 다시 넣지 않는다(응답은 멱등하게 항상 queued, 실제 상태는 GET /trips/:id/matching).
      const m = queueMatching(db, tripId);
      if (m.created) onEnded(tripId);
      return c.json(
        { tripId: s.tripId, pointCount: s.pointCount, distanceM: s.distanceM, durationS: s.durationS ?? 0, matching: 'queued' as const },
        200,
      );
    })
    .get('/:tripId', (c) => {
      const summary = getSummary(db, c.req.param('tripId'));
      if (!summary) return c.json({ error: 'not_found' }, 404);
      const points = (db.prepare('SELECT * FROM trip_points WHERE trip_id = ? ORDER BY seq').all(summary.tripId) as PointRow[]).map(
        toPoint,
      );
      return c.json({ ...summary, points }, 200);
    })
    .get('/', (c) => {
      const vehicleId = c.req.query('vehicleId');
      const limitRaw = Number(c.req.query('limit') ?? 50);
      const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const rows = (
        vehicleId
          ? // alias(UUID로 대체해 올린 트립)로 연결된 트립도 함께 돌려준다.
            db
              .prepare(
                summaryQuery(
                  `SELECT * FROM trips WHERE vehicle_id = ? OR vehicle_id IN (SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?)
                   ORDER BY started_at DESC, created_at DESC LIMIT ?`,
                ),
              )
              .all(vehicleId, vehicleId, limit)
          : db.prepare(summaryQuery('SELECT * FROM trips ORDER BY started_at DESC, created_at DESC LIMIT ?')).all(limit)
      ) as TripRow[];
      return c.json({ trips: rows.map(toSummary) }, 200);
    });
