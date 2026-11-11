import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { VEHICLE_SET_SQL } from '../roads/index.js';
import { readSettings } from '../ext/settings.js';
import { iso, parseBody, SQL_SHIFT_DAYS, type ExtDeps } from '../ext/util.js';

const id = z.string().min(1).max(128);
const ageBody = z.object({ vehicleId: id, days: z.number().int().min(1).max(5_000) });
/** 부분 갱신을 받는다(보내지 않은 항목은 그대로). homeRegion은 시군구 코드 5자리 또는 null(지정 안 함). */
const settingsBody = z.object({
  recordingPaused: z.boolean().optional(),
  homeRegion: z.string().regex(/^\d{5}$/).nullable().optional(),
  statsOptIn: z.boolean().optional(),
  drivingMap: z.boolean().optional(),
  hideHomeInCards: z.boolean().optional(),
});

/** 차량 ID와 그 alias(UUID)로 올린 트립 소속 ID 전부. */
const vehicleIds = (db: ExtDeps['db'], vehicleId: string): string[] => [
  vehicleId,
  ...(db.prepare('SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?').all(vehicleId) as { alias_id: string }[]).map((r) => r.alias_id),
];

/** 설정·데이터 삭제·시연용 `POST /debug/age`. */
export const accountRoutes = (deps: ExtDeps) => {
  const { db, options, now } = deps;
  const app = new Hono()
    // 기록 멈춤(일시 중지 요구권, plan 11-2): 멈춘 차량(또는 동의 철회 뒤)의 점 업로드는 저장하지 않고 받은 것으로만 응답한다(차량 큐가 쌓이지 않게 200).
    .post('/trips/:tripId/points', async (c, next) => {
      const t = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(c.req.param('tripId')) as { vehicle_id: string } | undefined;
      if (t && readSettings(db, canonicalVehicleId(db, t.vehicle_id)).recordingPaused) return c.json({ accepted: 0, duplicated: 0, paused: true as const }, 200);
      return next();
    })
    .get('/vehicles/:id/settings', (c) => c.json(readSettings(db, canonicalVehicleId(db, c.req.param('id'))), 200))
    .put('/vehicles/:id/settings', async (c) => {
      const p = await parseBody(c, settingsBody);
      if (!p.ok) return p.res;
      const vehicleId = canonicalVehicleId(db, c.req.param('id'));
      if (vehicleId.length === 0 || vehicleId.length > 128) return c.json({ error: 'invalid_body' }, 400);
      const b = p.data;
      let home = b.homeRegion;
      if (typeof home === 'string') {
        const regions = deps.getRegions();
        if (regions) {
          home = regions.canonical(home);
          if (!regions.names().has(home)) return c.json({ error: 'invalid_region' }, 400);
        }
      }
      const cur = readSettings(db, vehicleId);
      const paused = b.recordingPaused ?? cur.recordingPaused;
      db.prepare(
        `INSERT INTO vehicle_settings (vehicle_id, recording_paused, home_region, stats_opt_in, drive_map, hide_home_in_cards, consent_withdrawn_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vehicle_id) DO UPDATE SET recording_paused = excluded.recording_paused, home_region = excluded.home_region, stats_opt_in = excluded.stats_opt_in,
           drive_map = excluded.drive_map, hide_home_in_cards = excluded.hide_home_in_cards, consent_withdrawn_at = excluded.consent_withdrawn_at, updated_at = excluded.updated_at`,
      ).run(
        vehicleId,
        paused ? 1 : 0,
        home === undefined ? cur.homeRegion : home,
        (b.statsOptIn ?? cur.statsOptIn) ? 1 : 0,
        (b.drivingMap ?? cur.drivingMap) ? 1 : 0,
        (b.hideHomeInCards ?? cur.hideHomeInCards) ? 1 : 0,
        // 기록을 다시 켜면 동의 철회 표시를 비운다(다시 동의한 것으로 본다).
        b.recordingPaused === false ? null : cur.consentWithdrawnAt,
        iso(now()),
      );
      return c.json(readSettings(db, vehicleId), 200);
    })
    // 위치정보 동의 철회·데이터 지우기(plan 11-2, 12-2): 트립·점·매칭·인정 도로·시군구 기록·공유 카드·게스트 기록을 즉시 지우고 기록을 멈춘다.
    .delete('/vehicles/:id/data', (c) => {
      const vehicleId = canonicalVehicleId(db, c.req.param('id'));
      const ids = vehicleIds(db, vehicleId);
      const inList = `(${ids.map(() => '?').join(',')})`;
      const tripIds = `(SELECT id FROM trips WHERE vehicle_id IN ${inList})`;
      const counts = { trips: 0, points: 0, ways: 0, regions: 0 };
      db.exec('BEGIN');
      try {
        counts.points = Number(db.prepare(`DELETE FROM trip_points WHERE trip_id IN ${tripIds}`).run(...ids).changes);
        db.prepare(`DELETE FROM trip_matching WHERE trip_id IN ${tripIds}`).run(...ids);
        db.prepare(`DELETE FROM region_jobs WHERE trip_id IN ${tripIds}`).run(...ids);
        db.prepare(`DELETE FROM region_pending WHERE vehicle_id IN ${inList}`).run(...ids);
        db.prepare(`DELETE FROM region_events WHERE vehicle_id IN ${inList}`).run(...ids);
        counts.regions = Number(db.prepare(`DELETE FROM visited_regions WHERE vehicle_id IN ${inList}`).run(...ids).changes);
        counts.ways = Number(db.prepare(`DELETE FROM driven_ways WHERE vehicle_id IN ${inList}`).run(...ids).changes);
        db.prepare(`DELETE FROM way_revived WHERE vehicle_id IN ${inList}`).run(...ids);
        db.prepare(`DELETE FROM coverage_snapshots WHERE vehicle_id IN ${inList}`).run(...ids);
        db.prepare('DELETE FROM share_cards WHERE vehicle_id = ?').run(vehicleId);
        counts.trips = Number(db.prepare(`DELETE FROM trips WHERE vehicle_id IN ${inList}`).run(...ids).changes);
        // 이 차에서 앉은 게스트 기록도 이 차의 위치정보에서 나온 것이라 함께 지운다.
        db.prepare(`DELETE FROM guest_ways WHERE session_id IN (SELECT id FROM guest_sessions WHERE vehicle_id = ?)`).run(vehicleId);
        db.prepare("UPDATE guest_sessions SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, 'deleted'), deleted_at = ? WHERE vehicle_id = ?").run(iso(now()), iso(now()), vehicleId);
        db.prepare("DELETE FROM link_codes WHERE vehicle_id = ?").run(vehicleId);
        db.prepare(
          `INSERT INTO vehicle_settings (vehicle_id, recording_paused, consent_withdrawn_at, updated_at) VALUES (?, 1, ?, ?)
           ON CONFLICT (vehicle_id) DO UPDATE SET recording_paused = 1, consent_withdrawn_at = excluded.consent_withdrawn_at, updated_at = excluded.updated_at`,
        ).run(vehicleId, iso(now()), iso(now()));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return c.json({ ok: true as const, deleted: counts }, 200);
    });
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
