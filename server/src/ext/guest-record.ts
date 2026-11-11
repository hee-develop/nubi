/**
 * 게스트 기록 계산(plan 9장, M1). 인정 기준은 하나다: **그 트립의 점 중 시각이 세션 창에 드는 부분**.
 *  - 도로: 겹친 점이 만드는 경로 근처(30m)의 차량 인정 way를 트립 단위로 계산해 `guest_trip_ways`에 둔다. 커버리지는 겹친 점이 덮은 비율이다(차량 MAX 복사 아님).
 *    차량이 인정한(`driven_ways`) way만 후보이고 인정 기준은 매칭과 같다(커버리지 70% 이상 또는 덮은 길이 500m 이상).
 *  - 시군구: 같은 겹친 점으로 통과를 판정하고, 방문·숙박은 트립의 마지막 점이 창 안일 때(내리기 전에 도착했을 때)만 `region_events`에서 인정한다.
 * 확정 매칭(`trip_matching.status = 'done'`, outcome `counted`)이 끝난 트립만 도로로 인정한다. 의심(suspect) 트립은 어느 쪽도 인정하지 않는다.
 */
import type { Db } from '../db/index.js';
import { MIN_COVERAGE, MIN_MATCHED_M } from '../matching/pipeline.js';
import { RD } from '../roads/index.js';
import { thinSamples } from '../regions/judge.js';
import { expireIdle } from './sessions.js';
import type { RegionLevels } from './stats.js';
import type { ExtDeps } from './util.js';

const M_PER_DEG = 111_195;
/** 점 사이가 이보다 멀면(데이터 끊김) 이어 그리지 않는다. */
const MAX_GAP_M = 200;
/** way 위 점이 겹친 경로에서 이만큼 안이면 덮인 것으로 본다. */
const NEAR_M = 30;
const SAMPLE_STEP_M = 15;

type Pt = { lat: number; lon: number; ts: string };
type Session = { id: string; vehicle_id: string; started_at: string; ended_at: string | null };

const sessionsOf = (db: Db, accountId: string) =>
  db.prepare('SELECT id, vehicle_id, started_at, ended_at FROM guest_sessions WHERE account_id = ? AND deleted_at IS NULL').all(accountId) as Session[];

/** 세션 창과 시각이 겹치는 그 차량(alias 포함)의 트립. */
const overlappingTrips = (db: Db, s: Session) =>
  db
    .prepare(
      `SELECT t.id, m.result_json FROM trips t LEFT JOIN trip_matching m ON m.trip_id = t.id
       WHERE (t.vehicle_id = ? OR t.vehicle_id IN (SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?))
         AND (? IS NULL OR t.started_at <= ?) AND (t.ended_at IS NULL OR t.ended_at >= ?)
       ORDER BY t.started_at`,
    )
    .all(s.vehicle_id, s.vehicle_id, s.ended_at, s.ended_at, s.started_at) as { id: string; result_json: string | null; status?: string }[];

type MatchInfo = { outcome?: string };
const outcomeOf = (resultJson: string | null): string | undefined => {
  if (!resultJson) return undefined;
  try {
    return (JSON.parse(resultJson) as MatchInfo).outcome;
  } catch {
    return undefined;
  }
};

/** 세션 창 안의 점. */
export const windowPoints = (db: Db, tripId: string, s: Session): Pt[] =>
  db
    .prepare('SELECT lat, lon, ts FROM trip_points WHERE trip_id = ? AND ts >= ? AND (? IS NULL OR ts <= ?) ORDER BY seq')
    .all(tripId, s.started_at, s.ended_at, s.ended_at) as Pt[];

/** 겹친 점이 만드는 선분(끊김 제외)의 격자 색인과 거리 질의. */
const segmentIndex = (pts: Pt[]) => {
  const cosLat = Math.cos((pts[0]!.lat * Math.PI) / 180);
  const toXY = (lat: number, lon: number): [number, number] => [lon * M_PER_DEG * cosLat, lat * M_PER_DEG];
  const CELL = 120;
  const grid = new Map<string, [number, number, number, number][]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const pad = NEAR_M;
    for (let cx = Math.floor((Math.min(x0, x1) - pad) / CELL); cx <= Math.floor((Math.max(x0, x1) + pad) / CELL); cx++)
      for (let cy = Math.floor((Math.min(y0, y1) - pad) / CELL); cy <= Math.floor((Math.max(y0, y1) + pad) / CELL); cy++) {
        const k = `${cx},${cy}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push([x0, y0, x1, y1]);
      }
  };
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = toXY(pts[i]!.lat, pts[i]!.lon);
    if (i === 0) {
      add(x1, y1, x1, y1);
      continue;
    }
    const [x0, y0] = toXY(pts[i - 1]!.lat, pts[i - 1]!.lon);
    if (Math.hypot(x1 - x0, y1 - y0) <= MAX_GAP_M) add(x0, y0, x1, y1);
    else add(x1, y1, x1, y1);
  }
  const near = (lat: number, lon: number): boolean => {
    const [x, y] = toXY(lat, lon);
    const segs = grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
    if (!segs) return false;
    for (const [x0, y0, x1, y1] of segs) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
      if (Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= NEAR_M) return true;
    }
    return false;
  };
  return near;
};

/** 겹친 점 근처에서 차량이 인정한 way와 그 커버리지(덮인 비율). 인정 기준은 매칭(`runMatching`)과 같다. */
export const guestWaysForPoints = (db: Db, vehicleId: string, pts: Pt[]): { wayId: number; coverage: number }[] => {
  if (pts.length === 0) return [];
  const near = segmentIndex(pts);
  const cosLat = Math.cos((pts[0]!.lat * Math.PI) / 180);
  const found = new Map<number, { length_m: number; geom_json: string }>();
  const q = db.prepare(
    `SELECT w.way_id, w.length_m, w.geom_json FROM ${RD}.ways w
     WHERE w.way_id IN (SELECT way_id FROM ${RD}.ways_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
       AND w.way_id IN (SELECT way_id FROM driven_ways WHERE vehicle_id IN (SELECT ? UNION SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?))`,
  );
  const PAD = 0.0007;
  for (let i = 0; i < pts.length; i += 60) {
    const chunk = pts.slice(i, i + 61);
    const lons = chunk.map((p) => p.lon);
    const lats = chunk.map((p) => p.lat);
    for (const r of q.all(Math.max(...lons) + PAD / cosLat, Math.min(...lons) - PAD / cosLat, Math.max(...lats) + PAD, Math.min(...lats) - PAD, vehicleId, vehicleId) as {
      way_id: number;
      length_m: number;
      geom_json: string;
    }[])
      found.set(r.way_id, r);
  }
  const out: { wayId: number; coverage: number }[] = [];
  for (const [wayId, w] of found) {
    const geom = JSON.parse(w.geom_json) as number[][];
    let total = 0;
    let hit = 0;
    for (let i = 0; i < geom.length; i++) {
      const [lon1, lat1] = geom[i] as [number, number];
      const samples: [number, number][] = [[lat1, lon1]];
      if (i > 0) {
        const [lon0, lat0] = geom[i - 1] as [number, number];
        const d = Math.hypot((lon1 - lon0) * M_PER_DEG * cosLat, (lat1 - lat0) * M_PER_DEG);
        const n = Math.floor(d / SAMPLE_STEP_M);
        for (let k = 1; k <= n; k++) samples.push([lat0 + ((lat1 - lat0) * k) / (n + 1), lon0 + ((lon1 - lon0) * k) / (n + 1)]);
      }
      for (const [la, lo] of samples) {
        total++;
        if (near(la, lo)) hit++;
      }
    }
    if (total === 0) continue;
    const coverage = hit / total;
    if (coverage >= MIN_COVERAGE || coverage * w.length_m >= MIN_MATCHED_M) out.push({ wayId, coverage: Math.round(coverage * 1000) / 1000 });
  }
  return out;
};

/** 그 차량(alias 포함)의 인정 way 갱신 버전: 행 수와 가장 늦은 마지막 시각·커버리지 합. */
const drivenVersion = (db: Db, vehicleId: string): string => {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(last_driven_at), '') AS last, COALESCE(SUM(coverage), 0) AS cov FROM driven_ways
       WHERE vehicle_id IN (SELECT ? UNION SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?)`,
    )
    .get(vehicleId, vehicleId) as { n: number; last: string; cov: number };
  return `${r.n}|${r.last}|${r.cov.toFixed(3)}`;
};

/**
 * 게스트 계정의 세션별 도로 기록을 최신으로 맞춘다(읽기 전에 부른다). 세션 창·점 수가 바뀐 (세션, 트립)만 다시 계산한다.
 * 열린 세션은 먼저 12시간 규칙을 적용한다. 도로 DB가 없으면 건너뛴다.
 */
export const refreshGuestWays = (deps: ExtDeps, accountId: string): void => {
  const { db, now } = deps;
  if (!deps.getRoads()) return;
  for (const s of sessionsOf(db, accountId)) {
    if (!s.ended_at) expireIdle(db, now(), s.vehicle_id);
  }
  for (const s of sessionsOf(db, accountId)) {
    for (const t of overlappingTrips(db, s)) {
      const outcome = outcomeOf(t.result_json);
      if (outcome !== 'counted') continue; // 확정 매칭이 끝나 인정된 트립만(미완료·불인정·의심은 인정하지 않는다)
      const pts = windowPoints(db, t.id, s);
      const cache = db.prepare('SELECT win_from, win_to, points, dw_ver FROM guest_trip_cache WHERE session_id = ? AND trip_id = ?').get(s.id, t.id) as
        | { win_from: string; win_to: string | null; points: number; dw_ver: string | null }
        | undefined;
      // 계산 기준: 세션 창·겹친 점 수·차량 인정 way의 갱신 버전(driven_ways가 바뀌면 다시 계산)
      const ver = drivenVersion(db, s.vehicle_id);
      if (cache && cache.win_from === s.started_at && cache.win_to === s.ended_at && cache.points === pts.length && cache.dw_ver === ver) continue;
      const lastAt = pts.at(-1)?.ts ?? s.started_at;
      const ways = guestWaysForPoints(db, s.vehicle_id, pts);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM guest_trip_ways WHERE session_id = ? AND trip_id = ?').run(s.id, t.id);
        const ins = db.prepare('INSERT INTO guest_trip_ways (session_id, trip_id, way_id, coverage, last_at) VALUES (?, ?, ?, ?, ?)');
        for (const w of ways) ins.run(s.id, t.id, w.wayId, w.coverage, lastAt);
        db.prepare('INSERT OR REPLACE INTO guest_trip_cache (session_id, trip_id, win_from, win_to, points, dw_ver) VALUES (?, ?, ?, ?, ?, ?)').run(s.id, t.id, s.started_at, s.ended_at, pts.length, ver);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
};

/** 게스트 계정의 시군구 단계(겹친 점 기준). 지역 DB가 없으면 빈 지도. */
const levelsCache = new Map<string, { sig: string; levels: RegionLevels }>();

/** 시군구 계산 입력의 서명(세션 목록·겹치는 트립의 점 수·방문·숙박 이벤트 수). 같으면 계산을 건너뛴다. */
const levelsSignature = (db: Db, accountId: string): string => {
  const parts: string[] = [];
  for (const s of sessionsOf(db, accountId)) {
    const ids = overlappingTrips(db, s).map((t) => t.id);
    const pts = ids.length
      ? (db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(ts), '') AS last FROM trip_points WHERE trip_id IN (${ids.map(() => '?').join(',')}) AND ts >= ? AND (? IS NULL OR ts <= ?)`).get(...ids, s.started_at, s.ended_at, s.ended_at) as { n: number; last: string })
      : { n: 0, last: '' };
    const ev = ids.length ? (db.prepare(`SELECT COUNT(*) AS n FROM region_events WHERE trip_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n : 0;
    parts.push(`${s.id}:${s.ended_at ?? ''}:${ids.length}:${pts.n}:${pts.last}:${ev}`);
  }
  return parts.join('|');
};

export const guestRegionLevels = (deps: ExtDeps, accountId: string): RegionLevels => {
  const { db } = deps;
  const regions = deps.getRegions();
  const out: RegionLevels = new Map();
  if (!regions) return out;
  const sig = levelsSignature(db, accountId);
  const hit = levelsCache.get(accountId);
  if (hit && hit.sig === sig) return hit.levels;
  const bump = (code: string, level: number, at: string) => {
    const c = regions.canonical(code);
    const cur = out.get(c);
    if (!cur) out.set(c, { level, lastAt: at });
    else out.set(c, { level: Math.max(cur.level, level), lastAt: cur.lastAt && cur.lastAt > at ? cur.lastAt : at });
  };
  for (const s of sessionsOf(db, accountId)) {
    for (const t of overlappingTrips(db, s)) {
      if (outcomeOf(t.result_json) === 'suspect') continue;
      const pts = windowPoints(db, t.id, s);
      if (pts.length === 0) continue;
      for (const p of thinSamples(pts)) {
        const code = regions.locate(p.lon, p.lat);
        if (code) bump(code, 1, p.ts);
      }
      // 방문·숙박: 이벤트는 '종료 지점이 그 시군구였던 트립'에 묶여 있다. 내리기 전에 도착했을 때(마지막 점이 창 안)만 인정한다.
      const last = db.prepare('SELECT MAX(ts) AS ts FROM trip_points WHERE trip_id = ?').get(t.id) as { ts: string | null };
      if (last.ts && last.ts === pts.at(-1)!.ts) {
        for (const e of db.prepare("SELECT code, kind, at FROM region_events WHERE trip_id = ? AND kind IN ('visit', 'stay')").all(t.id) as { code: string; kind: string; at: string }[])
          bump(e.code, e.kind === 'stay' ? 3 : 2, e.at);
      }
    }
  }
  levelsCache.delete(accountId);
  levelsCache.set(accountId, { sig, levels: out });
  while (levelsCache.size > 200) levelsCache.delete(levelsCache.keys().next().value!);
  return out;
};
