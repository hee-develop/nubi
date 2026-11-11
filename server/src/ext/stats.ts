/** 차주·게스트의 내 기록 집계(`/me/*`, 웹 페이지, 공유 카드가 함께 쓴다). */
import type { Db } from '../db/index.js';
import { RG, type Regions } from '../regions/index.js';
import { DRIVEN_CTE, RD, ROAD_DRIVEN_CTE, VEHICLE_SET_SQL, roundPercent, type Roads } from '../roads/index.js';
import { COMPLETE_PERCENT } from '../routes/coverage.js';

export type RegionLevels = Map<string, { level: number; lastAt: string | null }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 차량(alias 합산)의 시군구 단계. */
export const ownerRegionLevels = (db: Db, vehicleId: string): RegionLevels => {
  const rows = db
    .prepare(`SELECT code, MAX(level) AS level, MAX(last_at) AS last_at FROM visited_regions WHERE vehicle_id IN ${VEHICLE_SET_SQL} GROUP BY code`)
    .all(vehicleId, vehicleId) as { code: string; level: number; last_at: string }[];
  return new Map(rows.map((r) => [r.code, { level: r.level, lastAt: r.last_at }]));
};

/** 게스트 계정의 세션 목록(삭제하지 않은 것). */
const sessionsOf = (db: Db, accountId: string) =>
  db.prepare('SELECT id, vehicle_id, started_at, ended_at FROM guest_sessions WHERE account_id = ? AND deleted_at IS NULL').all(accountId) as {
    id: string;
    vehicle_id: string;
    started_at: string;
    ended_at: string | null;
  }[];

/**
 * 게스트의 시군구 단계: 세션 시간 창 안에 **시작된** 그 차량 트립에서 통과(매칭 결과의 `regions.passed`)·방문·숙박(`region_events`)을 모은다.
 * 방문·숙박은 다음 트립이 판정하지만 이벤트가 그 트립(종료 지점이 이 시군구였던 트립) id에 매여 있어 세션이 먼저 끝나도 인정된다.
 */
export const guestRegionLevels = (db: Db, regions: Regions | null, accountId: string): RegionLevels => {
  const out: RegionLevels = new Map();
  const bump = (code: string, level: number, at: string) => {
    const c = regions ? regions.canonical(code) : code;
    const cur = out.get(c);
    if (!cur) out.set(c, { level, lastAt: at });
    else out.set(c, { level: Math.max(cur.level, level), lastAt: cur.lastAt && cur.lastAt > at ? cur.lastAt : at });
  };
  for (const s of sessionsOf(db, accountId)) {
    const trips = db
      .prepare(
        `SELECT t.id, t.started_at, m.result_json FROM trips t LEFT JOIN trip_matching m ON m.trip_id = t.id
         WHERE (t.vehicle_id = ? OR t.vehicle_id IN (SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?))
           AND t.started_at >= ? AND (? IS NULL OR t.started_at <= ?)`,
      )
      .all(s.vehicle_id, s.vehicle_id, s.started_at, s.ended_at, s.ended_at) as { id: string; started_at: string; result_json: string | null }[];
    for (const t of trips) {
      if (t.result_json) {
        try {
          const r = (JSON.parse(t.result_json) as { regions?: { passed?: string[] } | string }).regions;
          if (r && typeof r === 'object' && Array.isArray(r.passed)) for (const code of r.passed) bump(code, 1, t.started_at);
        } catch {
          // 깨진 결과는 건너뛴다
        }
      }
      for (const e of db.prepare("SELECT code, kind, at FROM region_events WHERE trip_id = ? AND kind IN ('visit', 'stay', 'pass')").all(t.id) as {
        code: string;
        kind: string;
        at: string;
      }[])
        bump(e.code, e.kind === 'stay' ? 3 : e.kind === 'visit' ? 2 : 1, e.at);
    }
  }
  return out;
};

export type RegionItem = {
  code: string;
  name: string;
  displayName: string;
  sidoName: string;
  level: number;
  depop92: boolean;
  lastAt: string | null;
};

/** 시군구 전체 목록에 단계를 붙인다(지역 DB가 있을 때). */
export const regionItems = (db: Db, regions: Regions, levels: RegionLevels): RegionItem[] => {
  const rows = db.prepare(`SELECT code, name, display_name, sido_name, depop_92 FROM ${RG}.regions ORDER BY sido_code, name, code`).all() as {
    code: string;
    name: string;
    display_name: string;
    sido_name: string;
    depop_92: number;
  }[];
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    displayName: r.display_name,
    sidoName: r.sido_name,
    level: levels.get(r.code)?.level ?? 0,
    depop92: r.depop_92 === 1,
    lastAt: levels.get(r.code)?.lastAt ?? null,
  }));
};

export const regionSummary = (items: RegionItem[]) => {
  const colored = items.filter((i) => i.level >= 1);
  const depop = items.filter((i) => i.depop92);
  return {
    total: items.length,
    colored: colored.length,
    byLevel: { '1': items.filter((i) => i.level === 1).length, '2': items.filter((i) => i.level === 2).length, '3': items.filter((i) => i.level === 3).length },
    depop: { total: depop.length, colored: depop.filter((i) => i.level >= 1).length },
  };
};

/** 게스트 계정의 인정 way를 `d(way_id, cov, first, last)` CTE로(이름이 `d`라 ROAD_DRIVEN_CTE를 그대로 쓴다). 바인딩 값은 [accountId] 한 번. */
const GUEST_DRIVEN_CTE = `d AS (
  SELECT way_id, MAX(coverage) AS cov, MIN(first_at) AS first, MAX(last_at) AS last
  FROM guest_ways WHERE session_id IN (SELECT id FROM guest_sessions WHERE account_id = ? AND deleted_at IS NULL) GROUP BY way_id
)`;

export type CoverageStats = { nationalPercent: number; drivenKm: number; totalKm: number; roadsStarted: number; roadsCompleted: number };

const coverageFrom = (db: Db, roads: Roads, cte: string, args: string[]): CoverageStats => {
  const row = db
    .prepare(
      `WITH ${cte}, ${ROAD_DRIVEN_CTE}
       SELECT COALESCE(SUM(driven), 0) AS driven, COUNT(*) AS started, COALESCE(SUM(CASE WHEN driven >= total * ? THEN 1 ELSE 0 END), 0) AS completed FROM r`,
    )
    .get(...args, COMPLETE_PERCENT / 100) as { driven: number; started: number; completed: number };
  return {
    nationalPercent: roundPercent(roads.totalNamedLengthM > 0 ? (row.driven / roads.totalNamedLengthM) * 100 : 0),
    drivenKm: round2(row.driven / 1000),
    totalKm: round2(roads.totalNamedLengthM / 1000),
    roadsStarted: row.started,
    roadsCompleted: row.completed,
  };
};

export const ownerCoverage = (db: Db, roads: Roads, vehicleId: string) => coverageFrom(db, roads, DRIVEN_CTE, [vehicleId, vehicleId]);
export const guestCoverage = (db: Db, roads: Roads, accountId: string) => coverageFrom(db, roads, GUEST_DRIVEN_CTE, [accountId]);

/** 그려 넣을 인정 도로 선(경도·위도 배열)과 바램 여부. 도로 DB의 도형을 읽을 뿐 밖으로 내보내지 않는다(렌더러가 픽셀로만 바꾼다). */
export type DrawnWay = { coords: number[][]; last: string };

const MAX_DRAWN_WAYS = 60_000;

export const ownerWays = (db: Db, vehicleId: string): DrawnWay[] =>
  (
    db
      .prepare(`WITH ${DRIVEN_CTE} SELECT w.geom_json, d.last FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id ORDER BY w.way_id LIMIT ?`)
      .all(vehicleId, vehicleId, MAX_DRAWN_WAYS) as { geom_json: string; last: string }[]
  ).map((r) => ({ coords: JSON.parse(r.geom_json) as number[][], last: r.last }));

export const guestWays = (db: Db, accountId: string): DrawnWay[] =>
  (
    db
      .prepare(`WITH ${GUEST_DRIVEN_CTE} SELECT w.geom_json, d.last FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id ORDER BY w.way_id LIMIT ?`)
      .all(accountId, MAX_DRAWN_WAYS) as { geom_json: string; last: string }[]
  ).map((r) => ({ coords: JSON.parse(r.geom_json) as number[][], last: r.last }));
