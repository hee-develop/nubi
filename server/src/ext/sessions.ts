import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { iso } from './util.js';

/** 마지막 트립 종료 후 이 시간 동안 주행이 없으면 세션을 끝낸다(plan 9-2, 가안). */
export const IDLE_END_MS = 12 * 3_600_000;
/** 차량당 동시 게스트 수(plan 9-3, 가안). */
export const MAX_GUESTS = 4;

type SessionRow = { id: string; vehicle_id: string; account_id: string; started_at: string };

/**
 * 세션의 마지막 활동 시각. 세션 시작 뒤 그 차량 트립을 시작 순으로 보며 활동(종료, 진행 중이면 마지막 점·시작)을 늘려 가되,
 * 직전 활동보다 12시간 넘게 뒤에 시작한 트립부터는 이 세션에 속하지 않는다(그 사이에 세션이 끝났어야 한다).
 */
const lastActivityMs = (db: Db, s: SessionRow): number => {
  const trips = db
    .prepare(
      `SELECT t.started_at, COALESCE(t.ended_at, (SELECT MAX(p.ts) FROM trip_points p WHERE p.trip_id = t.id), t.started_at) AS last
       FROM trips t WHERE t.started_at >= ? AND (t.vehicle_id = ? OR t.vehicle_id IN (SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?))
       ORDER BY t.started_at`,
    )
    .all(s.started_at, s.vehicle_id, s.vehicle_id) as { started_at: string; last: string }[];
  let last = Date.parse(s.started_at);
  for (const t of trips) {
    if (Date.parse(t.started_at) - last > IDLE_END_MS) break;
    last = Math.max(last, Date.parse(t.last));
  }
  return last;
};

export const endSession = (db: Db, id: string, atMs: number, reason: string): void => {
  db.prepare('UPDATE guest_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(iso(atMs), reason, id);
};

/**
 * 12시간 규칙: [vehicleId] 차량의 열린 세션 중 마지막 활동 뒤 12시간이 [untilMs]까지 지난 것을 (마지막 활동 + 12시간)에 끝낸다.
 * 읽기·claim·새 트립 시작 때마다 부르므로 별도 스케줄러가 없다. [vehicleId]를 생략하면 모든 차량.
 */
export const expireIdle = (db: Db, untilMs: number, vehicleId?: string): number => {
  const rows = (
    vehicleId
      ? db.prepare('SELECT id, vehicle_id, account_id, started_at FROM guest_sessions WHERE ended_at IS NULL AND vehicle_id = ?').all(canonicalVehicleId(db, vehicleId))
      : db.prepare('SELECT id, vehicle_id, account_id, started_at FROM guest_sessions WHERE ended_at IS NULL').all()
  ) as SessionRow[];
  let n = 0;
  for (const s of rows) {
    const idleAt = lastActivityMs(db, s) + IDLE_END_MS;
    if (idleAt <= untilMs) {
      endSession(db, s.id, idleAt, 'idle');
      n++;
    }
  }
  return n;
};

/** 차량의 열린 세션 수(12시간 규칙을 먼저 적용한다). */
export const activeCount = (db: Db, vehicleId: string, nowMs: number): number => {
  const v = canonicalVehicleId(db, vehicleId);
  expireIdle(db, nowMs, v);
  return (db.prepare('SELECT COUNT(*) AS n FROM guest_sessions WHERE vehicle_id = ? AND ended_at IS NULL').get(v) as { n: number }).n;
};

/**
 * 새 트립이 [vehicleId] 차량에서 [startedAtMs]에 시작됐을 때: (1) 그 차량의 12시간 지난 세션을 마무리하고,
 * (2) 그 차량의 차주 계정이 **게스트로 앉아 있던** 다른 차량 세션을 끝낸다(게스트가 자기 차에서 트립을 시작함, plan 9-2).
 */
export const onTripStarted = (db: Db, vehicleId: string, startedAtMs: number): void => {
  const v = canonicalVehicleId(db, vehicleId);
  expireIdle(db, startedAtMs, v);
  const rows = db
    .prepare(
      `SELECT s.id FROM guest_sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.ended_at IS NULL AND a.kind = 'owner' AND a.vehicle_id = ? AND s.vehicle_id != ? AND s.started_at <= ?`,
    )
    .all(v, v, iso(startedAtMs)) as { id: string }[];
  for (const r of rows) endSession(db, r.id, startedAtMs, 'own_trip');
};
