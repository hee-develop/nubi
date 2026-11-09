import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Db } from '../db/index.js';
import { makeLocator, pointInMulti, pointInRing } from '../../../scripts/geo-utils.mjs';

// 판정·point-in-polygon은 scripts/geo-utils.mjs 하나를 빌드 스크립트·verify와 공유한다(복사 금지).
export { pointInMulti, pointInRing };

/** 행정동 경계 출처 표기(사양 03 3장). 지역 API 응답 `attribution`과 뷰어에 넣는다. */
export const REGIONS_ATTRIBUTION = '통계청 통계지리정보서비스(SGIS) 행정동 경계를 vuski/admdongkor가 가공(CC BY 4.0)';

/** 사용자 DB 연결에 ATTACH 하는 지역 DB의 스키마 이름. 쿼리에서 `rg.regions` 처럼 쓴다. */
export const RG = 'rg';

type Polygon = number[][][];

export type Regions = {
  path: string;
  /** 경계 스냅샷 월 `YYYYMM`. */
  month: string;
  /** 도감 분모(시군구 개수). */
  total: number;
  /** 통합특별시 등 옛 코드 → 새 코드. */
  alias: Map<string, string>;
  /** 점이 속한 시군구 코드. 폴리곤 밖이면 50m 이내 가장 가까운 시군구(경계 틈 보정), 그래도 없으면 null. */
  locate: (lon: number, lat: number) => string | null;
  /** 시군구 폴리곤(파싱 캐시). */
  polygons: (code: string) => Polygon[] | null;
  /** 옛 코드를 새 코드로. */
  canonical: (code: string) => string;
  names: () => Map<string, { name: string; displayName: string; sidoName: string }>;
};

const dataDir = fileURLToPath(new URL('../../data/regions/', import.meta.url));

/**
 * 지역 DB 경로. `NUBI_REGIONS_DB` → `server/data/regions/regions.sqlite`(있을 때) 순이고, 없으면 null(지역 API 503·판정 재시도 대기).
 * 테스트 픽스처로 조용히 대체하지 않는다(도로 DB와 같은 정책).
 */
export const resolveRegionsPath = (env: string | undefined = process.env.NUBI_REGIONS_DB, dir: string = dataDir): string | null => {
  if (env && env.length > 0) return env;
  const p = join(dir, 'regions.sqlite');
  return existsSync(p) ? p : null;
};

/**
 * 지역 DB를 사용자 DB 연결에 **읽기 전용**으로 ATTACH 하고 판정 함수를 만든다. 파일이 없거나 스키마가 다르면 null.
 */
export const attachRegions = (db: Db, path: string | null | undefined): Regions | null => {
  if (!path || !existsSync(path)) return null;
  try {
    db.exec(`ATTACH DATABASE '${pathToFileURL(path).href.replaceAll("'", "''")}?mode=ro' AS ${RG}`);
    const s = db.prepare(`SELECT month FROM ${RG}.snapshot ORDER BY month DESC LIMIT 1`).get() as { month: string } | undefined;
    if (!s) throw new Error('snapshot 행이 없습니다');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${RG}.regions`).get() as { n: number }).n;
    const alias = new Map(
      (db.prepare(`SELECT old_code, new_code FROM ${RG}.region_alias`).all() as { old_code: string; new_code: string }[]).map((r) => [
        r.old_code,
        r.new_code,
      ]),
    );
    const loc = makeLocator(db, { schema: RG });
    let namesCache: Map<string, { name: string; displayName: string; sidoName: string }> | null = null;
    return {
      path,
      month: s.month,
      total,
      alias,
      canonical: (code) => alias.get(code) ?? code,
      polygons: (code) => loc.polygons(code),
      locate: (lon, lat) => loc.locate(lon, lat)?.code ?? null,
      names: () =>
        (namesCache ??= new Map(
          (
            db.prepare(`SELECT code, name, display_name, sido_name FROM ${RG}.regions`).all() as {
              code: string;
              name: string;
              display_name: string;
              sido_name: string;
            }[]
          ).map((r) => [r.code, { name: r.name, displayName: r.display_name, sidoName: r.sido_name }]),
        )),
    };
  } catch (e) {
    try {
      db.exec(`DETACH DATABASE ${RG}`);
    } catch {
      // ATTACH 자체가 실패했으면 풀 것이 없다
    }
    console.warn(`지역 DB를 열 수 없습니다(${path}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};
