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

  /** 점 한 묶음을 매칭해 새로 인정한 way 수를 돌려준다. 도로 DB가 없거나 점이 모자라면 0. */
  const runOnce = async (tripId: string): Promise<number> => {
    const roads = deps.roads();
    if (!roads) return 0;
    const trip = db.prepare('SELECT vehicle_id, ended_at FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
    // 끝난 트립은 확정 매칭이 맡는다.
    if (!trip || trip.ended_at) return 0;
    const done = db.prepare('SELECT up_to_seq FROM trip_live WHERE trip_id = ?').get(tripId) as { up_to_seq: number } | undefined;
    const from = (done?.up_to_seq ?? -1) - LIVE_OVERLAP_POINTS;
    const points = db
      .prepare('SELECT seq, lat, lon FROM trip_points WHERE trip_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(tripId, from, LIVE_MAX_POINTS) as PointRow[];
    const lastSeq = points.at(-1)?.seq;
    if (lastSeq === undefined || (done && lastSeq <= done.up_to_seq)) return 0;
    if (points.length < 2) return 0;

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
      const rows = db
        .prepare(`SELECT DISTINCT way_id FROM driven_ways WHERE vehicle_id IN ${VEHICLE_SET_SQL} AND way_id IN (${ids.map(() => '?').join(',')})`)
        .all(vehicle, vehicle, ...ids) as { way_id: number }[];
      for (const r of rows) known.add(r.way_id);
    }
    // 같은 트립에서 이미 쌓은 way는 is_new를 처음 값 그대로 둔다(OR IGNORE).
    let added = 0;
    db.exec('BEGIN');
    try {
      const ins = db.prepare('INSERT OR IGNORE INTO trip_live_ways (trip_id, way_id, is_new) VALUES (?, ?, ?)');
      for (const id of recognized) added += Number(ins.run(tripId, id, known.has(id) ? 0 : 1).changes);
      db.prepare(
        'INSERT INTO trip_live (trip_id, up_to_seq, updated_at) VALUES (?, ?, ?) ON CONFLICT (trip_id) DO UPDATE SET up_to_seq = excluded.up_to_seq, updated_at = excluded.updated_at',
      ).run(tripId, lastSeq, nowIso);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return added;
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
        return 0;
      })
      .then(() => {
        s.running = null;
        if (s.dirty && !stopped) schedule(tripId);
      });
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
    /** 이 트립의 잠정 매칭이 지금 진행 중이거나 예약돼 있는지. */
    isBusy: (tripId: string) => {
      const s = states.get(tripId);
      return !!s && (s.running !== null || s.timer !== null);
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
