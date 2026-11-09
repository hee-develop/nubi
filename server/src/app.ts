import { Hono } from 'hono';
import { openDb, type Db } from './db/index.js';
import { createMatchingWorker, type MatchingWorker } from './matching/worker.js';
import type { TraceDeps } from './matching/valhalla.js';
import { attachRoads, resolveRoadsPath, type Roads } from './roads/index.js';
import { attachRegions, resolveRegionsPath, type Regions } from './regions/index.js';
import { inTx, mergeRegionAliases, resolvePending, runBatch } from './regions/judge.js';
import { coverageRoutes } from './routes/coverage.js';
import { regionsRoutes } from './routes/regions.js';
import { tripsRoutes } from './routes/trips.js';
import { resolveVehicleHmacKey, vehiclesRoutes } from './routes/vehicles.js';
import { viewerRoutes } from './viewer/index.js';

export type AppOptions = {
  vehicleHmacKey?: string;
  /** 도로 DB 경로. 생략하면 `NUBI_ROADS_DB` → 최신 `server/data/roads-*.sqlite`(둘 다 없으면 도로 DB 없음), `null`이면 도로 DB 없이 뜬다. 테스트 픽스처로는 조용히 대체하지 않는다. */
  roadsPath?: string | null;
  /** 지역(시군구 경계) DB 경로. 생략하면 `NUBI_REGIONS_DB` → `server/data/regions/regions.sqlite`(없으면 지역 DB 없음), `null`이면 지역 DB 없이 뜬다(지역 API 503·판정 재시도 대기). 픽스처로 조용히 대체하지 않는다. */
  regionsPath?: string | null;
  /** `/viewer` 등록 여부. 생략하면 `NUBI_VIEWER=1` 이거나 `NODE_ENV`가 production이 아닐 때만 등록한다(시연·debug용). */
  viewer?: boolean;
  /** Valhalla 호출 설정(테스트가 fetch를 가짜로 끼운다). */
  valhalla?: TraceDeps;
  /** 매칭 재시도 간격(ms, 기본 5분). */
  retryDelayMs?: number;
  /** 시작 때 끝나지 않은 매칭 작업을 이어서 처리한다(서버 프로세스에서만 켠다). */
  resumeMatching?: boolean;
};

// RPC 타입 추론을 위해 라우트는 반드시 체이닝으로 정의한다.
export const createApp = (db: Db = openDb(), options: AppOptions = {}) => {
  const roads: Roads | null = attachRoads(db, options.roadsPath === undefined ? resolveRoadsPath() : options.roadsPath);
  const regions: Regions | null = attachRegions(db, options.regionsPath === undefined ? resolveRegionsPath() : options.regionsPath);
  if (regions) inTx(db, () => mergeRegionAliases(db, regions));
  const worker: MatchingWorker = createMatchingWorker({
    db,
    roads: () => roads,
    regions: () => regions,
    trace: options.valhalla,
    retryDelayMs: options.retryDelayMs,
  });
  /** 새 트립 Start·점 업로드 때 지난 트립의 방문·숙박을 판정한다. 판정 오류가 트립 업로드를 막지 않게 삼킨다. */
  const tick = (vehicleId: string, onlyIfPending: boolean) => {
    if (!regions) return;
    try {
      if (onlyIfPending && !db.prepare('SELECT 1 AS x FROM region_pending WHERE visit_done = 1 LIMIT 1').get()) return;
      inTx(db, () => resolvePending(db, regions, vehicleId, Date.now()));
    } catch (e) {
      console.warn(`시군구 판정 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** 24시간 배치: 다음 트립이 안 온 pending을 방문으로 확정한다. */
  const regionsBatch = (nowMs: number = Date.now()) => (regions ? inTx(db, () => runBatch(db, regions, nowMs)) : 0);
  if (options.resumeMatching) {
    worker.start();
    regionsBatch();
    setInterval(
      () => {
        try {
          regionsBatch();
        } catch (e) {
          console.warn(`시군구 배치 실패: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      60 * 60 * 1000,
    ).unref();
  }
  const app = new Hono()
    .get('/health', (c) => c.json({ ok: true as const }))
    .route('/trips', tripsRoutes(db, worker.enqueue, { onStarted: (v) => tick(v, false), onPoints: (v) => tick(v, true) }))
    .route(
      '/regions',
      regionsRoutes(db, () => regions),
    )
    .route('/vehicles', vehiclesRoutes(options.vehicleHmacKey ?? resolveVehicleHmacKey(), db))
    .route(
      '/',
      coverageRoutes(db, () => roads),
    );
  if (options.viewer ?? (process.env.NUBI_VIEWER === '1' || process.env.NODE_ENV !== 'production')) app.route('/viewer', viewerRoutes());
  return Object.assign(app, { matching: worker, regionsBatch });
};

export type AppType = ReturnType<typeof createApp>;
