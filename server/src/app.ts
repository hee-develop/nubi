import { Hono } from 'hono';
import { openDb, type Db } from './db/index.js';
import { createMatchingWorker, type MatchingWorker } from './matching/worker.js';
import type { TraceDeps } from './matching/valhalla.js';
import { attachRoads, resolveRoadsPath, type Roads } from './roads/index.js';
import { coverageRoutes } from './routes/coverage.js';
import { tripsRoutes } from './routes/trips.js';
import { resolveVehicleHmacKey, vehiclesRoutes } from './routes/vehicles.js';
import { viewerRoutes } from './viewer/index.js';

export type AppOptions = {
  vehicleHmacKey?: string;
  /** 도로 DB 경로. 생략하면 `NUBI_ROADS_DB` → 최신 `server/data/roads-*.sqlite` → 테스트 DB, `null`이면 도로 DB 없이 뜬다. */
  roadsPath?: string | null;
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
  const worker: MatchingWorker = createMatchingWorker({
    db,
    roads: () => roads,
    trace: options.valhalla,
    retryDelayMs: options.retryDelayMs,
  });
  if (options.resumeMatching) worker.start();
  const app = new Hono()
    .get('/health', (c) => c.json({ ok: true as const }))
    .route('/trips', tripsRoutes(db, worker.enqueue))
    .route('/vehicles', vehiclesRoutes(options.vehicleHmacKey ?? resolveVehicleHmacKey(), db))
    .route('/viewer', viewerRoutes())
    .route(
      '/',
      coverageRoutes(db, () => roads),
    );
  return Object.assign(app, { matching: worker });
};

export type AppType = ReturnType<typeof createApp>;
