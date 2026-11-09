import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Db } from '../db/index.js';

/** ODbL 출처 표기. API 응답 `attribution`과 뷰어에 넣는다. */
export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** 사용자 DB 연결에 ATTACH 하는 도로 DB의 스키마 이름. 쿼리에서 `rd.ways` 처럼 쓴다. */
export const RD = 'rd';

export type Roads = {
  path: string;
  /** 도로 DB 스냅샷 월 `YYYYMM`. */
  month: string;
  /** 이름·번호 있는 자동차 도로 총길이(m). 전국 완료율의 분모. */
  totalNamedLengthM: number;
};

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));

/**
 * 도로 DB 경로. `NUBI_ROADS_DB` → `server/data/roads-*.sqlite` 중 최신(파일명 사전순) 순이고, 둘 다 없으면 null(조회 API 503·매칭 재시도 대기).
 * 테스트 픽스처로 조용히 대체하지 않는다. 픽스처는 테스트·E2E가 `NUBI_ROADS_DB`나 `roadsPath`로 명시할 때만 쓴다(사양 3-2).
 * 사용자 기록 DB(`nubi.sqlite`)와 파일이 다르다(ODbL 파생 DB 분리).
 */
export const resolveRoadsPath = (env: string | undefined = process.env.NUBI_ROADS_DB, dir: string = dataDir): string | null => {
  if (env && env.length > 0) return env;
  try {
    const latest = readdirSync(dir)
      .filter((f) => /^roads-.*\.sqlite$/.test(f))
      .sort()
      .at(-1);
    if (latest) return join(dir, latest);
  } catch {
    // data 폴더가 없으면 도로 DB 없음
  }
  return null;
};

/**
 * 도로 DB를 사용자 DB 연결에 **읽기 전용**(`mode=ro`)으로 ATTACH 한다. 같은 연결이라 `driven_ways ⨝ ways ⨝ roads`를 SQL 한 번으로 집계할 수 있다.
 * 파일이 없거나 스키마가 다르면 null(도로 API는 503, 매칭 작업은 재시도 대기).
 */
export const attachRoads = (db: Db, path: string | null | undefined): Roads | null => {
  if (!path || !existsSync(path)) return null;
  try {
    db.exec(`ATTACH DATABASE '${pathToFileURL(path).href.replaceAll("'", "''")}?mode=ro' AS ${RD}`);
    const s = db.prepare(`SELECT month, total_named_length_m FROM ${RD}.snapshot ORDER BY month DESC LIMIT 1`).get() as
      { month: string; total_named_length_m: number } | undefined;
    if (!s) throw new Error('snapshot 행이 없습니다');
    // 묶음별 상한(사양 2장)에 쓰는 열이 없는 옛 스키마는 쓰지 않는다(재빌드 필요).
    db.prepare(`SELECT split_length_m FROM ${RD}.roads LIMIT 1`).get();
    return { path, month: s.month, totalNamedLengthM: s.total_named_length_m };
  } catch (e) {
    // 검사에 실패하면 ATTACH를 풀어 둔다(붙은 채로 남으면 이후 쿼리가 옛 스키마를 읽는다).
    try {
      db.exec(`DETACH DATABASE ${RD}`);
    } catch {
      // ATTACH 자체가 실패했으면 풀 것이 없다
    }
    console.warn(`도로 DB를 열 수 없습니다(${path}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

export type WayRow = { way_id: number; road_key: string; length_m: number };

/** way_id 목록의 길이·도로 키를 찾는다. 도로 DB에 없는 id는 결과에 없다. */
export const findWays = (db: Db, wayIds: number[]): Map<number, WayRow> => {
  const found = new Map<number, WayRow>();
  const CHUNK = 500;
  for (let i = 0; i < wayIds.length; i += CHUNK) {
    const ids = wayIds.slice(i, i + CHUNK);
    const rows = db
      .prepare(`SELECT way_id, road_key, length_m FROM ${RD}.ways WHERE way_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as WayRow[];
    for (const r of rows) found.set(r.way_id, r);
  }
  return found;
};

/** 차량 ID와 그 alias(UUID로 올린 트립)를 한 단계만 따라 잇는 SQL 조각. 바인딩 값은 [vehicleId] 두 번. */
export const VEHICLE_SET_SQL = '(SELECT ? UNION SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?)';

/** vehicle(차량)의 driven_ways를 way별로 합친 CTE `d(way_id, cov, first, last)`. 바인딩 값은 [vehicleId] 두 번. */
export const DRIVEN_CTE = `d AS (
  SELECT way_id, MAX(coverage) AS cov, MIN(first_driven_at) AS first, MAX(last_driven_at) AS last
  FROM driven_ways WHERE vehicle_id IN ${VEHICLE_SET_SQL} GROUP BY way_id
)`;

/**
 * 도로별 달린 길이 CTE `r(road_key, total, driven, last)`(DRIVEN_CTE 뒤에 잇는다). 사양 2장의 묶음 정의:
 * 도로마다 분리 구간 묶음(`eff_length_m < length_m`인 way: 주요 4등급 oneway, 상한 = Σ length / 2 = `roads.split_length_m`)과
 * 양방향 묶음(상한 = Σ length = `total_length_m − split_length_m`)으로 나눠 `min(상한, Σ 커버리지 × length_m)`을 각각 구해 더한다.
 * 그래서 분리 구간의 상·하행을 모두 달려도 양방향 구간의 몫을 채우지 못하고, 총길이(`total`)를 넘지도 않는다.
 */
export const ROAD_DRIVEN_CTE = `r AS (
  SELECT w.road_key, ro.total_length_m AS total,
         MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN d.cov * w.length_m ELSE 0 END), ro.split_length_m)
         + MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN 0 ELSE d.cov * w.length_m END), ro.total_length_m - ro.split_length_m) AS driven,
         MAX(d.last) AS last
  FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id JOIN ${RD}.roads ro ON ro.road_key = w.road_key
  GROUP BY w.road_key
)`;

/** 전국 완료율(%, 0~100)과 거리(m). 분모는 도로 DB 스냅샷의 이름 있는 도로 유효 총길이. */
export const nationalCoverage = (db: Db, roads: Roads, vehicleId: string) => {
  const row = db
    .prepare(`WITH ${DRIVEN_CTE}, ${ROAD_DRIVEN_CTE} SELECT COALESCE(SUM(driven), 0) AS driven FROM r`)
    .get(vehicleId, vehicleId) as { driven: number };
  const percent = roads.totalNamedLengthM > 0 ? (row.driven / roads.totalNamedLengthM) * 100 : 0;
  return { drivenM: row.driven, percent };
};

/** 완료율은 0.0001% 단위로 반올림한다(가안: 전국 분모가 12만 km대라 1.5km 주행이 소수 2자리에서는 0이 된다). */
export const roundPercent = (p: number) => Math.round(p * 10_000) / 10_000;
