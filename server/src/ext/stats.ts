/** 차주·게스트의 내 기록 집계(`/me/*`, 웹 페이지, 공유 카드가 함께 쓴다). */
import type { Db } from '../db/index.js';
import { RG, type Regions } from '../regions/index.js';
import { DRIVEN_CTE, RD, ROAD_DRIVEN_CTE, VEHICLE_SET_SQL, roundPercent, type Roads } from '../roads/index.js';
import { COMPLETE_PERCENT } from '../routes/coverage.js';
import { guestRegionLevels, refreshGuestWays } from './guest-record.js';
import type { ExtDeps } from './util.js';

export type RegionLevels = Map<string, { level: number; lastAt: string | null }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 차량(alias 합산)의 시군구 단계. */
export const ownerRegionLevels = (db: Db, vehicleId: string): RegionLevels => {
  const rows = db
    .prepare(`SELECT code, MAX(level) AS level, MAX(last_at) AS last_at FROM visited_regions WHERE vehicle_id IN ${VEHICLE_SET_SQL} GROUP BY code`)
    .all(vehicleId, vehicleId) as { code: string; level: number; last_at: string }[];
  return new Map(rows.map((r) => [r.code, { level: r.level, lastAt: r.last_at }]));
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

/** 계정이 게스트로 앉은 세션의 인정 way(`guest_trip_ways`)를 way별로 합친 부분 쿼리. 바인딩 [accountId]. */
const GUEST_ROWS = `SELECT way_id, coverage AS cov, last_at AS first, last_at AS last FROM guest_trip_ways
  WHERE session_id IN (SELECT id FROM guest_sessions WHERE account_id = ? AND deleted_at IS NULL)`;
const GUEST_CTE = `d AS (SELECT way_id, MAX(cov) AS cov, MIN(first) AS first, MAX(last) AS last FROM (${GUEST_ROWS}) GROUP BY way_id)`;
/** 차주: 내 차량 인정 way + 내가 게스트로 탄 기록(M2). 바인딩 [vehicleId, vehicleId, accountId]. */
const OWNER_PLUS_GUEST_CTE = `d AS (SELECT way_id, MAX(cov) AS cov, MIN(first) AS first, MAX(last) AS last FROM (
  SELECT way_id, coverage AS cov, first_driven_at AS first, last_driven_at AS last FROM driven_ways WHERE vehicle_id IN ${VEHICLE_SET_SQL}
  UNION ALL ${GUEST_ROWS}) GROUP BY way_id)`;

export type AccountView = { accountId: string; owner: boolean; vehicleId: string | null };

/** 계정의 도로 집계. 차주는 내 차량 + 게스트로 탄 기록, 게스트는 탄 기록만. 읽기 전에 게스트 기록을 최신으로 맞춘다. */
export const accountCoverage = (deps: ExtDeps, roads: Roads, v: AccountView): CoverageStats => {
  refreshGuestWays(deps, v.accountId);
  return v.owner ? coverageFrom(deps.db, roads, OWNER_PLUS_GUEST_CTE, [v.vehicleId!, v.vehicleId!, v.accountId]) : coverageFrom(deps.db, roads, GUEST_CTE, [v.accountId]);
};

/** 그려 넣을 인정 도로 선(경도·위도 배열)과 마지막 인정 시각. 도로 DB의 도형을 읽을 뿐 밖으로 내보내지 않는다(렌더러가 픽셀로만 바꾼다). */
export type DrawnWay = { coords: number[][]; last: string };

const MAX_DRAWN_WAYS = 60_000;

const drawn = (db: Db, cte: string, args: string[]): DrawnWay[] =>
  (
    db.prepare(`WITH ${cte} SELECT w.geom_json, d.last FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id ORDER BY w.way_id LIMIT ?`).all(...args, MAX_DRAWN_WAYS) as {
      geom_json: string;
      last: string;
    }[]
  ).map((r) => ({ coords: JSON.parse(r.geom_json) as number[][], last: r.last }));

export const ownerWays = (db: Db, vehicleId: string): DrawnWay[] => drawn(db, DRIVEN_CTE, [vehicleId, vehicleId]);

export const accountWays = (deps: ExtDeps, v: AccountView): DrawnWay[] => {
  refreshGuestWays(deps, v.accountId);
  return v.owner ? drawn(deps.db, OWNER_PLUS_GUEST_CTE, [v.vehicleId!, v.vehicleId!, v.accountId]) : drawn(deps.db, GUEST_CTE, [v.accountId]);
};

/** 두 시군구 단계 지도를 합친다(단계 최댓값, 마지막 시각 최신). */
export const mergeLevels = (a: RegionLevels, b: RegionLevels): RegionLevels => {
  const out: RegionLevels = new Map(a);
  for (const [code, v] of b) {
    const cur = out.get(code);
    out.set(code, cur ? { level: Math.max(cur.level, v.level), lastAt: cur.lastAt && v.lastAt ? (cur.lastAt > v.lastAt ? cur.lastAt : v.lastAt) : (cur.lastAt ?? v.lastAt) } : v);
  }
  return out;
};

/** 계정의 시군구 단계. 차주는 내 차량 + 게스트로 탄 기록(M2), 게스트는 탄 기록만. */
export const accountRegionLevels = (deps: ExtDeps, v: AccountView): RegionLevels => {
  const guest = guestRegionLevels(deps, v.accountId);
  return v.owner ? mergeLevels(ownerRegionLevels(deps.db, v.vehicleId!), guest) : guest;
};
