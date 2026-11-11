/**
 * 주행 중 실시간 잠정 매칭(계약서 05 3장). `POST /trips/:id/points` 뒤 트립별로 디바운스(기본 30초)해 최근 창을 Valhalla에 매칭하고,
 * 결과 way를 `trip_live_ways`에 쌓는다. **잠정**이라 `driven_ways`·완료율·도감에는 넣지 않는다(확정은 트립 종료 매칭, pipeline.ts).
 *
 * 디바운스는 '앞 가장자리 + 뒤 가장자리' 방식이다: 한동안 조용했으면 점이 오는 즉시 한 번 돌고, 그 뒤에는 [intervalMs]에 한 번만(밀린 점이 있으면) 돈다.
 * 그래서 첫 색칠 지연이 짧고 Valhalla 호출은 트립당 30초에 1회로 묶인다.
 */
import type { Db } from '../db/index.js';
import { findWays, VEHICLE_SET_SQL, type Roads } from '../roads/index.js';
import { canonicalVehicleId } from './pipeline.js';
import { traceAttributes, type TraceDeps } from './valhalla.js';

export const LIVE_INTERVAL_MS = 30_000;
/** 앞 창과 겹치는 점 수(창 경계의 way가 끊기지 않게). */
export const LIVE_OVERLAP_POINTS = 10;
/** 한 번에 보내는 점 상한. 더 밀려 있으면 이어서 돈다. */
export const LIVE_MAX_POINTS = 2_000;
/** 잠정 인정: 커버리지 ≥ 0.5 또는 매칭 길이 ≥ 60m(확정 기준 0.7·500m보다 느슨하다. 지금 달리는 길이 바로 보이게 하려는 가안). */
export const LIVE_MIN_COVERAGE = 0.5;
export const LIVE_MIN_MATCHED_M = 60;
/** 점이 이 비율보다 많이 매칭되지 않으면 그 창은 버린다(확정 매칭과 같은 값). */
export const LIVE_MAX_UNMATCHED_RATIO = 0.5;

export type LiveMatcherDeps = {
  db: Db;
  roads: () => Roads | null;
  trace?: TraceDeps;
  intervalMs?: number;
  now?: () => number;
};

type PointRow = { seq: number; lat: number; lon: number };
type TripRow = { vehicle_id: string; ended_at: string | null };

export type LiveMatcher = ReturnType<typeof createLiveMatcher>;

export const createLiveMatcher = (deps: LiveMatcherDeps) => {
  const { db } = deps;
  const intervalMs = deps.intervalMs ?? LIVE_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const states = new Map<string, { lastRunAt: number; timer: ReturnType<typeof setTimeout> | null; running: Promise<void> | null; dirty: boolean }>();
  let stopped = false;

  const stateOf = (tripId: string) => {
    let s = states.get(tripId);
    if (!s) states.set(tripId, (s = { lastRunAt: -Infinity, timer: null, running: null, dirty: false }));
    return s;
  };

  /** 점 한 묶음을 매칭한다. 상한([LIVE_MAX_POINTS])에 걸려 아직 남은 점이 있으면 true(이어서 돌아야 한다). 도로 DB가 없거나 점이 모자라면 false. */
  const runOnce = async (tripId: string): Promise<boolean> => {
    const roads = deps.roads();
    if (!roads) return false;
    const trip = db.prepare('SELECT vehicle_id, ended_at FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
    // 끝난 트립은 확정 매칭이 맡는다.
    if (!trip || trip.ended_at) return false;
    const done = db.prepare('SELECT up_to_seq FROM trip_live WHERE trip_id = ?').get(tripId) as { up_to_seq: number } | undefined;
    const from = (done?.up_to_seq ?? -1) - LIVE_OVERLAP_POINTS;
    const points = db
      .prepare('SELECT seq, lat, lon FROM trip_points WHERE trip_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(tripId, from, LIVE_MAX_POINTS) as PointRow[];
    const lastSeq = points.at(-1)?.seq;
    if (lastSeq === undefined || (done && lastSeq <= done.up_to_seq)) return false;
    if (points.length < 2) return false;

    const trace = await traceAttributes(points, deps.trace);
    const total = trace.matchedPoints + trace.unmatchedPoints;
    const unmatchedRatio = total > 0 ? trace.unmatchedPoints / total : 1;
    const nowIso = new Date(now()).toISOString();
    const recognized: number[] = [];
    if (unmatchedRatio <= LIVE_MAX_UNMATCHED_RATIO) {
      const ways = findWays(db, [...trace.wayLengthsM.keys()]);
      for (const [wayId, matchedM] of trace.wayLengthsM) {
        const w = ways.get(wayId);
        if (!w || w.road_key.startsWith('unnamed:')) continue;
        if (matchedM / w.length_m >= LIVE_MIN_COVERAGE || matchedM >= LIVE_MIN_MATCHED_M) recognized.push(wayId);
      }
    }
    const vehicle = canonicalVehicleId(db, trip.vehicle_id);
    const known = new Set<number>();
    const CHUNK = 500;
    for (let i = 0; i < recognized.length; i += CHUNK) {
      const ids = recognized.slice(i, i + CHUNK);
      const marks = ids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT DISTINCT way_id FROM driven_ways WHERE vehicle_id IN ${VEHICLE_SET_SQL} AND way_id IN (${marks})`)
        .all(vehicle, vehicle, ...ids) as { way_id: number }[];
      for (const r of rows) known.add(r.way_id);
      // 직전 트립의 확정 매칭이 아직 안 끝났어도 그 트립이 칠한 잠정 way는 '이미 달린 길'이다(종료 직후 다음 트립이 같은 길을 달릴 때 새 길로 잘못 칠하지 않는다).
      const pending = db
        .prepare(
          `SELECT DISTINCT l.way_id FROM trip_live_ways l JOIN trips t ON t.id = l.trip_id
           LEFT JOIN trip_matching m ON m.trip_id = t.id
           WHERE t.vehicle_id IN ${VEHICLE_SET_SQL} AND l.trip_id != ? AND t.ended_at IS NOT NULL AND COALESCE(m.status, 'queued') != 'done'
             AND l.way_id IN (${marks})`,
        )
        .all(vehicle, vehicle, tripId, ...ids) as { way_id: number }[];
      for (const r of pending) known.add(r.way_id);
    }
    // 같은 트립에서 이미 쌓은 way는 is_new를 처음 값 그대로 둔다(OR IGNORE).
    db.exec('BEGIN');
    try {
      const ins = db.prepare('INSERT OR IGNORE INTO trip_live_ways (trip_id, way_id, is_new) VALUES (?, ?, ?)');
      for (const id of recognized) ins.run(tripId, id, known.has(id) ? 0 : 1);
      db.prepare(
        'INSERT INTO trip_live (trip_id, up_to_seq, updated_at) VALUES (?, ?, ?) ON CONFLICT (trip_id) DO UPDATE SET up_to_seq = excluded.up_to_seq, updated_at = excluded.updated_at',
      ).run(tripId, lastSeq, nowIso);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return points.length >= LIVE_MAX_POINTS;
  };

  const run = (tripId: string) => {
    const s = stateOf(tripId);
    if (s.running || stopped) return;
    s.dirty = false;
    s.lastRunAt = now();
    s.running = runOnce(tripId)
      .catch((e) => {
        // Valhalla 중단 등은 다음 점 업로드 때 다시 시도한다(잠정 결과라 확정 매칭처럼 재시도 큐를 두지 않는다).
        console.warn(`실시간 잠정 매칭 실패 trip=${tripId}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      })
      .then((more) => {
        s.running = null;
        if (more) s.dirty = true; // 상한에 걸려 남은 점이 있으면 이어서 돈다
        if (s.dirty && !stopped) schedule(tripId);
        else if (!s.timer && !s.dirty) release(tripId);
      });
  };

  /** 끝난 트립의 메모리 상태를 치운다(상태 맵이 트립 수만큼 계속 자라지 않게). 끝나지 않은 트립은 다음 점을 위해 남긴다. */
  const release = (tripId: string) => {
    const t = db.prepare('SELECT ended_at FROM trips WHERE id = ?').get(tripId) as { ended_at: string | null } | undefined;
    if (!t || t.ended_at) states.delete(tripId);
  };

  /** 점이 들어왔다고 알린다. 조용했으면 바로, 아니면 [intervalMs]가 찰 때 한 번 돈다. */
  const schedule = (tripId: string) => {
    if (stopped) return;
    const s = stateOf(tripId);
    s.dirty = true;
    if (s.running || s.timer) return;
    const wait = Math.max(0, s.lastRunAt + intervalMs - now());
    if (wait === 0) return run(tripId);
    s.timer = setTimeout(() => {
      s.timer = null;
      run(tripId);
    }, wait);
    s.timer.unref?.();
  };

  return {
    schedule,
    /** 이 트립의 잠정 매칭이 지금 진행 중인지(뒤 가장자리 타이머만 걸려 있는 대기는 진행 중이 아니다). */
    isBusy: (tripId: string) => states.get(tripId)?.running != null,
    /** 끝난 지 [olderThanMs]가 지난 트립의 잠정 행을 지운다(확정 기록에는 영향 없음). 지운 트립 수를 돌려준다. */
    purge: (olderThanMs: number = 24 * 3_600_000) => {
      const cutoff = new Date(now() - olderThanMs).toISOString();
      const ids = db.prepare('SELECT t.id FROM trips t WHERE t.ended_at IS NOT NULL AND t.ended_at < ? AND (EXISTS (SELECT 1 FROM trip_live WHERE trip_id = t.id) OR EXISTS (SELECT 1 FROM trip_live_ways WHERE trip_id = t.id))').all(cutoff) as { id: string }[];
      for (const { id } of ids) {
        db.prepare('DELETE FROM trip_live_ways WHERE trip_id = ?').run(id);
        db.prepare('DELETE FROM trip_live WHERE trip_id = ?').run(id);
        states.delete(id);
      }
      return ids.length;
    },
    /** 테스트용: 예약을 기다리지 않고 지금 한 번 돌고 끝날 때까지 기다린다. */
    flush: async (tripId: string) => {
      const s = stateOf(tripId);
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      await s.running;
      run(tripId);
      await s.running;
    },
    /** 테스트용: 진행 중인 매칭이 끝날 때까지 기다린다(예약은 기다리지 않는다). */
    idle: async () => {
      await Promise.all([...states.values()].map((s) => s.running));
    },
    stop: () => {
      stopped = true;
      for (const s of states.values()) if (s.timer) clearTimeout(s.timer);
    },
  };
};
