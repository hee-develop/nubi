import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { VEHICLE_SET_SQL } from '../roads/index.js';
import { parseBody, SQL_SHIFT_DAYS, type ExtDeps } from '../ext/util.js';

const id = z.string().min(1).max(128);
const ageBody = z.object({ vehicleId: id, days: z.number().int().min(1).max(5_000) });

/** 설정·데이터 삭제·시연용 `POST /debug/age`. */
export const accountRoutes = ({ db, options }: ExtDeps) => {
  const app = new Hono();
  // 시연용: 마지막 인정·판정 시각을 days만큼 당겨 '바램'을 즉시 보인다(plan 8장). production에서는 라우트 자체가 없다.
  if (options.debug ?? process.env.NODE_ENV !== 'production') {
    return app.post('/debug/age', async (c) => {
      const p = await parseBody(c, ageBody);
      if (!p.ok) return p.res;
      const vehicleId = canonicalVehicleId(db, p.data.vehicleId);
      const days = p.data.days;
      db.exec('BEGIN');
      try {
        const ways = db
          .prepare(
            `UPDATE driven_ways SET first_driven_at = ${SQL_SHIFT_DAYS('first_driven_at')}, last_driven_at = ${SQL_SHIFT_DAYS('last_driven_at')}
             WHERE vehicle_id IN ${VEHICLE_SET_SQL}`,
          )
          .run(days, days, vehicleId, vehicleId);
        const regions = db
          .prepare(
            `UPDATE visited_regions SET first_at = ${SQL_SHIFT_DAYS('first_at')}, last_at = ${SQL_SHIFT_DAYS('last_at')}
             WHERE vehicle_id IN ${VEHICLE_SET_SQL}`,
          )
          .run(days, days, vehicleId, vehicleId);
        db.exec('COMMIT');
        return c.json({ ok: true as const, ways: Number(ways.changes), regions: Number(regions.changes) }, 200);
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    });
  }
  return app;
};
