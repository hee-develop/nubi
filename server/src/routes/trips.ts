import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.js';

const MAX_POINTS_PER_BATCH = 500;

const iso = z.string().datetime({ offset: true });
const nullableNumber = z.number().finite().nullish();

const startBody = z.object({
  vehicleId: z.string().min(1),
  driverId: z.string().min(1),
  startedAt: iso,
  odometerStartKm: nullableNumber,
});

const pointSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: iso,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  headingDeg: nullableNumber,
  confidence: nullableNumber,
  speedKph: nullableNumber,
  gear: z.enum(['P', 'R', 'N', 'D']).nullish(),
});

const pointsBody = z.object({ points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_BATCH) });

const endBody = z.object({ endedAt: iso, odometerEndKm: nullableNumber });

type TripRow = {
  id: string;
  vehicle_id: string;
  driver_id: string;
  started_at: string;
  ended_at: string | null;
  odometer_start_km: number | null;
  odometer_end_km: number | null;
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

const summarize = (db: Db, trip: TripRow) => {
  const rows = db.prepare('SELECT lat, lon FROM trip_points WHERE trip_id = ? ORDER BY seq').all(trip.id) as { lat: number; lon: number }[];
  let distanceM = 0;
  for (let i = 1; i < rows.length; i++) distanceM += haversineM(rows[i - 1].lat, rows[i - 1].lon, rows[i].lat, rows[i].lon);
  const durationS = trip.ended_at ? Math.max(0, Math.round((Date.parse(trip.ended_at) - Date.parse(trip.started_at)) / 1000)) : null;
  return {
    tripId: trip.id,
    vehicleId: trip.vehicle_id,
    driverId: trip.driver_id,
    startedAt: trip.started_at,
    endedAt: trip.ended_at,
    odometerStartKm: trip.odometer_start_km,
    odometerEndKm: trip.odometer_end_km,
    pointCount: rows.length,
    distanceM: Math.round(distanceM * 10) / 10,
    durationS,
  };
};

const getTrip = (db: Db, id: string) => db.prepare('SELECT * FROM trips WHERE id = ?').get(id) as TripRow | undefined;

const readJson = async (req: Request): Promise<unknown> => {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
};

export const tripsRoutes = (db: Db) =>
  new Hono()
    .post('/', async (c) => {
      const parsed = startBody.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      const b = parsed.data;
      const tripId = randomUUID();
      db.prepare('INSERT INTO trips (id, vehicle_id, driver_id, started_at, odometer_start_km, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        tripId,
        b.vehicleId,
        b.driverId,
        b.startedAt,
        b.odometerStartKm ?? null,
        new Date().toISOString(),
      );
      return c.json({ tripId }, 201);
    })
    .post('/:tripId/points', async (c) => {
      const tripId = c.req.param('tripId');
      const parsed = pointsBody.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      if (!getTrip(db, tripId)) return c.json({ error: 'not_found' }, 404);
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
            p.ts,
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
      return c.json({ accepted, duplicated: parsed.data.points.length - accepted }, 200);
    })
    .post('/:tripId/end', async (c) => {
      const parsed = endBody.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
      const trip = getTrip(db, c.req.param('tripId'));
      if (!trip) return c.json({ error: 'not_found' }, 404);
      if (!trip.ended_at) {
        db.prepare('UPDATE trips SET ended_at = ?, odometer_end_km = ? WHERE id = ?').run(
          parsed.data.endedAt,
          parsed.data.odometerEndKm ?? null,
          trip.id,
        );
      }
      const s = summarize(db, getTrip(db, trip.id)!);
      return c.json({ tripId: s.tripId, pointCount: s.pointCount, distanceM: s.distanceM, durationS: s.durationS ?? 0 }, 200);
    })
    .get('/:tripId', (c) => {
      const trip = getTrip(db, c.req.param('tripId'));
      if (!trip) return c.json({ error: 'not_found' }, 404);
      const points = (db.prepare('SELECT * FROM trip_points WHERE trip_id = ? ORDER BY seq').all(trip.id) as PointRow[]).map(toPoint);
      return c.json({ ...summarize(db, trip), points }, 200);
    })
    .get('/', (c) => {
      const vehicleId = c.req.query('vehicleId');
      const limitRaw = Number(c.req.query('limit') ?? 50);
      const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const rows = (
        vehicleId
          ? db.prepare('SELECT * FROM trips WHERE vehicle_id = ? ORDER BY started_at DESC, created_at DESC LIMIT ?').all(vehicleId, limit)
          : db.prepare('SELECT * FROM trips ORDER BY started_at DESC, created_at DESC LIMIT ?').all(limit)
      ) as TripRow[];
      return c.json({ trips: rows.map((t) => summarize(db, t)) }, 200);
    });
