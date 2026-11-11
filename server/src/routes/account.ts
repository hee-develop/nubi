import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { VEHICLE_SET_SQL } from '../roads/index.js';
import { vehicleScoped } from '../ext/auth.js';
import { bodyOf, isPlainObject } from '../ext/body.js';
import { isRecordingBlocked, lastPauseChange, pauseSpans, pausedSpanAt, readSettings, syncPauseSpan } from '../ext/settings.js';
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
  /** recordingPaused를 바꾸는 사용자의 의도 시각(그 기기 시계, ISO). 마지막 멈춤 상태 변경보다 오래된 의도는 무시한다. */
  intentAt: z.string().datetime({ offset: true }).optional(),
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
    .use('/vehicles/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }))
    .use('/debug/*', bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }))
    // 기록 멈춤 = "이후 기록만 멈춘다"(plan 11-2 일시 중지 요구권). 판정은 요청이 **도착한 시각이 아니라 기록된 시각**(트립 startedAt·점 ts)이 멈춤 구간 안인지로 한다.
    //  - POST /trips: 동의 철회면 항상 막고, 멈춤이면 startedAt이 구간 안일 때만 막는다(200 `{ paused:true, pausedAt }`, 행 없음). 같은 (vehicleId, localId)가 정본·alias 어디에든 있으면 멱등 응답이 먼저다.
    //  - POST /trips/:id/points: 구간 안의 점만 버리고(`dropped`) 나머지는 저장한다. 전부 구간 안이면 `paused:true`. 동의 철회면 전부 버린다.
    //  - POST /trips/:id/end: 동의 철회일 때만 막는다.
    .post('/trips', async (c, next) => {
      const b = (await bodyOf(c)) as { vehicleId?: unknown; localId?: unknown; startedAt?: unknown } | undefined;
      if (typeof b?.vehicleId !== 'string' || b.vehicleId.length === 0 || b.vehicleId.length > 128) return next();
      const vid = canonicalVehicleId(db, b.vehicleId);
      if (typeof b.localId === 'string') {
        const ids = vehicleIds(db, vid);
        const existing = db.prepare(`SELECT id, vehicle_id FROM trips WHERE vehicle_id IN (${ids.map(() => '?').join(',')}) AND local_id = ?`).get(...ids, b.localId) as { id: string; vehicle_id: string } | undefined;
        if (existing) {
          // 요청 차량 ID로 만든 행이면 라우트의 멱등 처리에 맡기고, 정본·alias 다른 ID로 만든 행이면 그 tripId를 그대로 돌려준다(중복 행을 만들지 않는다)
          if (existing.vehicle_id === b.vehicleId) return next();
          return c.json({ tripId: existing.id }, 200);
        }
      }
      if (readSettings(db, vid).consentWithdrawnAt !== null) return c.json({ paused: true as const }, 200);
      const span = pausedSpanAt(pauseSpans(db, vid), typeof b.startedAt === 'string' ? Date.parse(b.startedAt) : NaN);
      if (span) return c.json({ paused: true as const, pausedAt: new Date(span.from).toISOString() }, 200);
      return next();
    })
    .post('/trips/:tripId/end', async (c, next) => {
      const t = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(c.req.param('tripId')) as { vehicle_id: string } | undefined;
      if (t && readSettings(db, canonicalVehicleId(db, t.vehicle_id)).consentWithdrawnAt !== null) return c.json({ paused: true as const }, 200);
      return next();
    })
    .post('/trips/:tripId/points', async (c, next) => {
      const t = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(c.req.param('tripId')) as { vehicle_id: string } | undefined;
      if (!t) return next();
      const vid = canonicalVehicleId(db, t.vehicle_id);
      if (readSettings(db, vid).consentWithdrawnAt !== null) return c.json({ accepted: 0, duplicated: 0, paused: true as const }, 200);
      const spans = pauseSpans(db, vid);
      if (spans.length === 0) return next();
      const body = await bodyOf(c);
      if (!isPlainObject(body) || !Array.isArray(body.points)) return next();
      const kept = body.points.filter((p) => !(isPlainObject(p) && typeof p.ts === 'string' && pausedSpanAt(spans, Date.parse(p.ts))));
      const dropped = body.points.length - kept.length;
      if (dropped === 0) return next();
      if (kept.length === 0) return c.json({ accepted: 0, duplicated: 0, paused: true as const, dropped }, 200);
      body.points = kept; // 라우트가 같은 본문 객체를 쓴다(bodyOf 캐시)
      await next();
      if (c.res.status === 200) {
        const j = (await c.res.clone().json()) as Record<string, unknown>;
        c.res = c.json({ ...j, dropped }, 200);
      }
      return;
    })
    // T1 실시간 색칠(`GET /trips/:id/live`)에도 같은 차단을 건다: 멈춘 차량은 잠정 결과를 만들지도 내보내지도 않는다. T1 라우트는 이 라우트보다 뒤에 붙는다.
    .get('/trips/:tripId/live', async (c, next) => {
      const t = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(c.req.param('tripId')) as { vehicle_id: string } | undefined;
      if (t && isRecordingBlocked(db, t.vehicle_id)) return c.json({ status: 'idle' as const, upToSeq: -1, ways: [], paused: true as const }, 200);
      return next();
    })
    // 경로에 차량 ID를 받는 라우트는 가드(기본 거부)를 함께 단다. 전역 미들웨어와 이중 방어.
    .use('/vehicles/:vehicleId/settings', vehicleScoped(deps))
    .use('/vehicles/:vehicleId/data', vehicleScoped(deps))
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
      // 켜기·끄기의 의도 시각: 마지막 멈춤 상태 변경보다 오래된 의도(다른 기기가 나중에 바꾼 것)는 무시하고 현재 값을 돌려준다
      const intentMs = b.intentAt ? Date.parse(b.intentAt) : undefined;
      let wantPaused = b.recordingPaused;
      if (wantPaused !== undefined && intentMs !== undefined && intentMs < lastPauseChange(pauseSpans(db, vehicleId))) wantPaused = undefined;
      const paused = wantPaused ?? cur.recordingPaused;
      const changeAt = intentMs ?? now();
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
        wantPaused === false ? null : cur.consentWithdrawnAt,
        iso(now()),
      );
      if (wantPaused !== undefined && wantPaused !== cur.recordingPaused) syncPauseSpan(db, vehicleId, wantPaused, changeAt);
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
        db.prepare(`DELETE FROM guest_trip_ways WHERE session_id IN (SELECT id FROM guest_sessions WHERE vehicle_id = ?)`).run(vehicleId);
        db.prepare(`DELETE FROM guest_trip_cache WHERE session_id IN (SELECT id FROM guest_sessions WHERE vehicle_id = ?)`).run(vehicleId);
        db.prepare("UPDATE guest_sessions SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, 'deleted'), deleted_at = ?, nickname = NULL WHERE vehicle_id = ?").run(iso(now()), iso(now()), vehicleId);
        db.prepare('DELETE FROM certificates WHERE vehicle_id = ?').run(vehicleId);
        db.prepare("DELETE FROM link_codes WHERE vehicle_id = ?").run(vehicleId);
        db.prepare(
          `INSERT INTO vehicle_settings (vehicle_id, recording_paused, consent_withdrawn_at, updated_at) VALUES (?, 1, ?, ?)
           ON CONFLICT (vehicle_id) DO UPDATE SET recording_paused = 1, consent_withdrawn_at = excluded.consent_withdrawn_at, updated_at = excluded.updated_at`,
        ).run(vehicleId, iso(now()), iso(now()));
        // 삭제 뒤에는 멈춤 상태이므로 구간을 새로 연다(옛 구간은 데이터와 함께 지운다)
        db.prepare(`DELETE FROM recording_pauses WHERE vehicle_id IN ${inList}`).run(...ids);
        syncPauseSpan(db, vehicleId, true, now());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return c.json({ ok: true as const, deleted: counts }, 200);
    });
  // 시연용: 마지막 인정·판정 시각을 days만큼 당겨 '바램'을 즉시 보인다(plan 8장). `NUBI_DEBUG=1`이고 production이 아닐 때만 라우트가 있다(옵션 `ext.debug`가 덮는다).
  if (options.debug ?? (process.env.NUBI_DEBUG === '1' && process.env.NODE_ENV !== 'production')) {
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
