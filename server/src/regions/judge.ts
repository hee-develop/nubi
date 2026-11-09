/**
 * 시군구 판정(사양 03 4장): 트립 → 통과(level 1) → 종료 지점 pending → 다음 트립 Start·점·배치에서 방문(2)·숙박(3).
 * 방문·숙박 규칙은 [resolvePending] 하나에 있다(업로드 시점·경로(Start 즉시/배치)와 무관하게 같은 결과).
 * 이 모듈의 함수는 트랜잭션을 열지 않는다. 호출하는 쪽이 BEGIN/COMMIT 안에서 부른다([inTx]).
 */
import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { VEHICLE_SET_SQL } from '../roads/index.js';
import type { Regions } from './index.js';

/** 방문: 다음 트립 시작까지 간격(가안 8장). */
export const VISIT_GAP_MS = 10 * 60_000;
/** 숙박: 간격 + 자정(KST) 통과. */
export const STAY_GAP_MS = 6 * 3_600_000;
/** 숙박 간격 상한: 넘으면 장기 주차로 보고 방문만 센다. */
export const STAY_MAX_GAP_MS = 7 * 24 * 3_600_000;
/** 다음 트립이 안 오면 이만큼 뒤 배치가 방문을 잠정 확정한다. */
export const CONFIRM_MS = 24 * 3_600_000;
/** pending 보존: 종료 + 이 기간이 지나면 지운다(그 전에는 늦게 온 Start·점으로 숙박 승격·방문 취소가 가능). */
export const PENDING_KEEP_MS = 7 * 24 * 3_600_000;
export const SAMPLE_STEP_M = 200;
export const MAX_SAMPLES = 2_000;
const KST_MS = 9 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type RegionsResult = {
  /** 이번 트립이 지난 시군구(코드). */
  passed: string[];
  /** 그 중 이 차량이 처음 칠한 것. */
  newPassed: string[];
  /** newPassed의 이름(차량 화면용, 사양에 없는 추가 필드). */
  newPassedNames: string[];
  /** 종료 지점 시군구(다음 트립 Start 때 방문·숙박 판정). 시군구 밖이면 null. */
  visitPending: string | null;
  /** 판정 소요(ms, 실측용 추가 필드). */
  ms: number;
};

type Pt = { lat: number; lon: number; ts: string };

const distM = (a: Pt, b: Pt) => {
  const dy = (b.lat - a.lat) * 111_195;
  const dx = (b.lon - a.lon) * 111_195 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
};

/** 채택 샘플을 [stepM] 간격으로 솎는다(처음·끝 점은 항상 남김). 결과가 [max]를 넘으면 균등하게 더 솎는다. */
export const thinSamples = <T extends Pt>(points: T[], stepM = SAMPLE_STEP_M, max = MAX_SAMPLES): T[] => {
  if (points.length === 0) return [];
  const kept: T[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) if (distM(kept.at(-1)!, points[i]!) >= stepM) kept.push(points[i]!);
  if (points.length > 1) kept.push(points.at(-1)!);
  if (kept.length <= max) return kept;
  const stride = kept.length / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(kept[Math.floor(i * stride)]!);
  out.push(kept.at(-1)!);
  return out;
};

const kstDay = (ms: number) => Math.floor((ms + KST_MS) / DAY_MS);
/** 사이에 자정(00:00 KST)이 있는가. */
export const crossesMidnightKst = (fromMs: number, toMs: number) => kstDay(toMs) > kstDay(fromMs);
export const isStayGap = (fromMs: number, toMs: number) =>
  toMs - fromMs >= STAY_GAP_MS && toMs - fromMs <= STAY_MAX_GAP_MS && crossesMidnightKst(fromMs, toMs);

const levelOf = (db: Db, vehicleId: string, code: string): number =>
  (
    db
      .prepare(`SELECT COALESCE(MAX(level), 0) AS l FROM visited_regions WHERE code = ? AND vehicle_id IN ${VEHICLE_SET_SQL}`)
      .get(code, vehicleId, vehicleId) as { l: number }
  ).l;

const addEvent = (db: Db, vehicleId: string, code: string, kind: 'pass' | 'visit' | 'stay', at: string, tripId: string): boolean =>
  Number(
    db
      .prepare('INSERT OR IGNORE INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES (?, ?, ?, ?, ?)')
      .run(vehicleId, code, kind, at, tripId).changes,
  ) > 0;

/**
 * 방문(2)·숙박(3)을 반영한다. 단계는 내려가지 않고, 같은 (트립, 종류) 이벤트가 이미 있으면 횟수를 다시 세지 않으며(시각만 맞춘다) 바뀐 게 있으면 true.
 */
const applyStage = (db: Db, vehicleId: string, code: string, kind: 'visit' | 'stay', at: string, tripId: string): boolean => {
  const old = db
    .prepare('SELECT id, at FROM region_events WHERE vehicle_id = ? AND code = ? AND kind = ? AND trip_id = ?')
    .get(vehicleId, code, kind, tripId) as { id: number; at: string } | undefined;
  if (old) {
    if (old.at !== at) db.prepare('UPDATE region_events SET at = ? WHERE id = ?').run(at, old.id);
    return false;
  }
  addEvent(db, vehicleId, code, kind, at, tripId);
  const level = kind === 'stay' ? 3 : 2;
  db.prepare(
    `INSERT INTO visited_regions (vehicle_id, code, level, first_at, last_at, passes, visits, stays) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (vehicle_id, code) DO UPDATE SET level = MAX(level, excluded.level), first_at = MIN(first_at, excluded.first_at),
       last_at = MAX(last_at, excluded.last_at), visits = visits + excluded.visits, stays = stays + excluded.stays`,
  ).run(vehicleId, code, level, at, at, kind === 'visit' ? 1 : 0, kind === 'stay' ? 1 : 0);
  return true;
};

/** 잠정 방문 취소: 늦게 도착한 Start가 간격 10분 미만임을 알려 줬을 때. 이벤트를 지우고 횟수를 되돌리고 단계를 횟수에서 다시 구한다. */
const retractStage = (db: Db, vehicleId: string, code: string, kind: 'visit' | 'stay', tripId: string) => {
  const r = db
    .prepare('DELETE FROM region_events WHERE vehicle_id = ? AND code = ? AND kind = ? AND trip_id = ?')
    .run(vehicleId, code, kind, tripId);
  if (Number(r.changes) === 0) return;
  const col = kind === 'visit' ? 'visits' : 'stays';
  db.prepare(`UPDATE visited_regions SET ${col} = MAX(0, ${col} - 1) WHERE vehicle_id = ? AND code = ?`).run(vehicleId, code);
  db.prepare(
    `UPDATE visited_regions SET level = MAX(1, CASE WHEN stays > 0 THEN 3 WHEN visits > 0 THEN 2 ELSE 1 END) WHERE vehicle_id = ? AND code = ?`,
  ).run(vehicleId, code);
};

/**
 * 트립 하나를 판정한다(통과 반영 + 종료 지점 pending 기록). [points]는 seq 순. 시군구 밖 점만 있으면 passed는 비고 pending도 없다.
 */
export const judgeTrip = (
  db: Db,
  regions: Regions,
  trip: { id: string; vehicleId: string; endedAt: string | null },
  points: Pt[],
): RegionsResult => {
  const t0 = performance.now();
  const thinned = thinSamples(points);
  const seen = new Map<string, { first: string; last: string }>();
  for (const p of thinned) {
    const code = regions.locate(p.lon, p.lat);
    if (!code) continue;
    const s = seen.get(code);
    if (s) s.last = p.ts;
    else seen.set(code, { first: p.ts, last: p.ts });
  }
  const names = regions.names();
  const newPassed: string[] = [];
  const up = db.prepare(
    `INSERT INTO visited_regions (vehicle_id, code, level, first_at, last_at, passes) VALUES (?, ?, 1, ?, ?, 1)
     ON CONFLICT (vehicle_id, code) DO UPDATE SET level = MAX(level, 1), first_at = MIN(first_at, excluded.first_at),
       last_at = MAX(last_at, excluded.last_at), passes = passes + 1`,
  );
  const canonVehicle = canonicalVehicleId(db, trip.vehicleId);
  for (const [code, s] of seen) {
    if (levelOf(db, canonVehicle, code) === 0) newPassed.push(code);
    up.run(trip.vehicleId, code, s.first, s.last);
    if (newPassed.includes(code)) addEvent(db, trip.vehicleId, code, 'pass', s.first, trip.id);
  }
  // 종료 지점 = 마지막 채택 샘플. 솎을 때 항상 남기므로 thinned의 끝이다.
  const endCode = thinned.length > 0 ? regions.locate(thinned.at(-1)!.lon, thinned.at(-1)!.lat) : null;
  if (endCode) {
    const endedAt = trip.endedAt ?? thinned.at(-1)!.ts;
    db.prepare('INSERT OR REPLACE INTO region_pending (trip_id, vehicle_id, code, ended_at, visit_done) VALUES (?, ?, ?, ?, 0)').run(
      trip.id,
      trip.vehicleId,
      endCode,
      endedAt,
    );
  }
  return {
    passed: [...seen.keys()],
    newPassed,
    newPassedNames: newPassed.map((c) => names.get(c)?.displayName ?? c),
    visitPending: endCode,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };
};

type Pending = { trip_id: string; vehicle_id: string; code: string; ended_at: string; visit_done: number };

/**
 * [vehicleId] 차량의 pending을 판정한다. Start·점 업로드·배치·매칭 직후 어디서 불러도 **같은 규칙**이고 몇 번을 불러도 결과가 같다(멱등).
 * 다음 트립 = 종료 이후 `started_at`이 가장 이른 트립(도착 순서와 무관).
 *  - 다음 트립 있음, 간격 < 10분: 방문 아님. 이미 반영한 잠정 방문·숙박은 취소하고 pending 삭제.
 *  - 간격 ≥ 10분: 방문(2)(시각 = 다음 트립 시작). 숙박 조건(6시간 ≤ 간격 ≤ 7일 + 자정 KST)이 아니면 pending 삭제.
 *  - 숙박 조건이면 다음 트립의 첫 점이 같은 시군구일 때 숙박(3), 다른 시군구면 방문만. 첫 점이 아직 없으면 pending을 남기고(visit_done=1) 기다린다.
 *  - 다음 트립 없음: 종료 + 24시간이 지나면 방문을 잠정 확정(시각 = 종료 + 24시간)하되 pending은 남긴다(visit_done=1). 종료 + 7일에 삭제.
 * 시각 기준은 서버 now가 아니라 종료 시각 대비 경과다([nowMs]는 그 경과를 재는 현재 시각일 뿐).
 * @returns 상태가 바뀐 pending 수(방문 반영·삭제)
 */
export const resolvePending = (db: Db, regions: Regions, vehicleId: string, nowMs: number): number => {
  const canonical = canonicalVehicleId(db, vehicleId);
  const rows = db
    .prepare(`SELECT * FROM region_pending WHERE vehicle_id IN ${VEHICLE_SET_SQL} ORDER BY ended_at`)
    .all(canonical, canonical) as Pending[];
  let changed = 0;
  const del = db.prepare('DELETE FROM region_pending WHERE trip_id = ?');
  const markDone = db.prepare('UPDATE region_pending SET visit_done = 1 WHERE trip_id = ? AND visit_done = 0');
  const finish = (p: Pending) => {
    del.run(p.trip_id);
    changed++;
  };
  for (const p of rows) {
    const code = regions.canonical(p.code);
    const endMs = Date.parse(p.ended_at);
    const next = db
      .prepare(
        `SELECT id, started_at FROM trips WHERE vehicle_id IN ${VEHICLE_SET_SQL} AND started_at > ? AND id != ? ORDER BY started_at LIMIT 1`,
      )
      .get(canonical, canonical, p.ended_at, p.trip_id) as { id: string; started_at: string } | undefined;
    if (!next) {
      if (endMs + CONFIRM_MS <= nowMs) {
        if (applyStage(db, p.vehicle_id, code, 'visit', new Date(endMs + CONFIRM_MS).toISOString(), p.trip_id)) changed++;
        markDone.run(p.trip_id);
      }
      if (endMs + PENDING_KEEP_MS <= nowMs) finish(p);
      continue;
    }
    const startMs = Date.parse(next.started_at);
    if (startMs - endMs < VISIT_GAP_MS) {
      retractStage(db, p.vehicle_id, code, 'visit', p.trip_id);
      retractStage(db, p.vehicle_id, code, 'stay', p.trip_id);
      finish(p);
      continue;
    }
    if (applyStage(db, p.vehicle_id, code, 'visit', next.started_at, p.trip_id)) changed++;
    if (!isStayGap(endMs, startMs)) {
      finish(p);
      continue;
    }
    const first = db.prepare('SELECT lat, lon FROM trip_points WHERE trip_id = ? ORDER BY seq LIMIT 1').get(next.id) as
      { lat: number; lon: number } | undefined;
    if (!first) {
      // 시작 지점을 아직 모른다. 점이 올라올 때까지(종료 + 7일까지) 기다린다.
      if (endMs + PENDING_KEEP_MS <= nowMs) finish(p);
      else markDone.run(p.trip_id);
      continue;
    }
    const startCode = regions.locate(first.lon, first.lat);
    if (startCode && regions.canonical(startCode) === code) applyStage(db, p.vehicle_id, code, 'stay', next.started_at, p.trip_id);
    finish(p);
  }
  return changed;
};

/** 배치: pending이 있는 차량(별칭 묶음은 한 번)을 전부 판정한다. 시작 때 쌓인 pending 재처리에도 쓴다. */
export const runBatch = (db: Db, regions: Regions, nowMs: number): number => {
  const seen = new Set<string>();
  let n = 0;
  for (const r of db.prepare('SELECT DISTINCT vehicle_id FROM region_pending').all() as { vehicle_id: string }[]) {
    const c = canonicalVehicleId(db, r.vehicle_id);
    if (seen.has(c)) continue;
    seen.add(c);
    n += resolvePending(db, regions, r.vehicle_id, nowMs);
  }
  return n;
};

/** 판정 결과가 필요한 호출자를 위한 트랜잭션 래퍼. */
export const inTx = <T>(db: Db, fn: () => T): T => {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

/** region_alias 적용: 옛 코드로 쌓인 기록을 새 코드로 합산한다(단계 최댓값, 횟수 합, 시각 min/max). */
export const mergeRegionAliases = (db: Db, regions: Regions): number => {
  let merged = 0;
  for (const [oldCode, newCode] of regions.alias) {
    if (oldCode === newCode) continue;
    const olds = db.prepare('SELECT * FROM visited_regions WHERE code = ?').all(oldCode) as {
      vehicle_id: string;
      level: number;
      first_at: string;
      last_at: string;
      passes: number;
      visits: number;
      stays: number;
    }[];
    for (const o of olds) {
      db.prepare(
        `INSERT INTO visited_regions (vehicle_id, code, level, first_at, last_at, passes, visits, stays) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vehicle_id, code) DO UPDATE SET level = MAX(level, excluded.level), first_at = MIN(first_at, excluded.first_at),
           last_at = MAX(last_at, excluded.last_at), passes = passes + excluded.passes, visits = visits + excluded.visits, stays = stays + excluded.stays`,
      ).run(o.vehicle_id, newCode, o.level, o.first_at, o.last_at, o.passes, o.visits, o.stays);
      db.prepare('DELETE FROM visited_regions WHERE vehicle_id = ? AND code = ?').run(o.vehicle_id, oldCode);
      merged++;
    }
    db.prepare('UPDATE region_pending SET code = ? WHERE code = ?').run(newCode, oldCode);
    db.prepare('UPDATE OR IGNORE region_events SET code = ? WHERE code = ?').run(newCode, oldCode);
    db.prepare('DELETE FROM region_events WHERE code = ?').run(oldCode);
  }
  return merged;
};
