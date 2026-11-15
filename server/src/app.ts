import { Hono } from 'hono';
import { openDb, type Db } from './db/index.js';
import { createLiveMatcher, type LiveMatcher } from './matching/live.js';
import { createMatchingWorker, type MatchingWorker } from './matching/worker.js';
import type { TraceDeps } from './matching/valhalla.js';
import { attachRoads, resolveRoadsPath, VEHICLE_SET_SQL, type Roads } from './roads/index.js';
import { attachRegions, resolveRegionsPath, type Regions } from './regions/index.js';
import { inTx, mergeRegionAliases, resolvePending, runBatch } from './regions/judge.js';
import { canonicalVehicleId } from './matching/pipeline.js';
import { coverageRoutes } from './routes/coverage.js';
import type { ExtDeps } from './ext/util.js';
import { createExt, type ExtOptions } from './routes/ext.js';
import { mapAccess, mapRoutes } from './routes/map.js';
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
  /** 현재 시각(ms). 시군구 판정·매칭 재시도의 시계다. 생략하면 Date.now(). 테스트가 고정·전진시킨다. */
  now?: () => number;
  /** 실시간 잠정 매칭을 켠다(기본 true). 테스트 도우미는 기존 테스트의 Valhalla 호출 수가 어긋나지 않게 기본 false로 둔다. */
  liveMatching?: boolean;
  /** 실시간 잠정 매칭 디바운스 간격(ms, 기본 30초). 생략하면 `NUBI_LIVE_INTERVAL_MS`. */
  liveIntervalMs?: number;
  /** 시작 때 끝나지 않은 매칭 작업을 이어서 처리한다(서버 프로세스에서만 켠다). */
  resumeMatching?: boolean;
  /** 05 야간 계약서 T2 확장 설정(토큰 인증·공개 주소·B2B 키·TourAPI 키 등). 생략한 값은 환경변수에서 읽는다. */
  ext?: ExtOptions;
};

type Chain = {
  db: Db;
  worker: MatchingWorker;
  live: LiveMatcher;
  ext: ReturnType<typeof createExt>;
  extDeps: ExtDeps;
  options: AppOptions;
  now: () => number;
  getRoads: () => Roads | null;
  getRegions: () => Regions | null;
  tick: (vehicleId: string, onlyIfPending: boolean) => void;
};

/**
 * 라우트 체인. `createApp`에서 떼어낸 이유: `createApp`은 `Object.assign(app, { matching, live, … })`로 교차 타입을 돌려주는데, 라우트가 많으면
 * `hc<ReturnType<typeof createApp>>`가 `Hono & {…}`에서 스키마를 일부(`/health`·`/coverage`·`/map`…) 잃는다. `AppType`은 이 함수의 반환형이다.
 * RPC 타입 추론을 위해 라우트는 반드시 체이닝으로 정의한다.
 */
const buildRoutes = ({ db, worker, live, ext, extDeps, options, now, getRoads, getRegions, tick }: Chain) =>
  new Hono()
    .use('*', ext.middleware) // 체인 맨 앞: 뒤에 붙는 모든 라우트(T1 /map·/trips/:id/live 포함)에 인증·본문 한도 적용
    .get('/health', (c) => c.json({ ok: true as const }))
    .route('/', ext.routes) // T2: /trips/:id/points·/live 기록 멈춤 차단이 /trips 라우트보다 먼저 와야 한다(멈춘 차량은 onPoints(잠정 매칭 포함)에 닿지 않는다)
    .route('/trips', tripsRoutes(db, worker.enqueue, {
      onStarted: (v) => tick(v, false),
      onPoints: (v, t) => {
        tick(v, true);
        if (options.liveMatching !== false) live.schedule(t);
      },
    }))
    .route(
      '/regions',
      regionsRoutes(db, getRegions, now),
    )
    .route('/vehicles', vehiclesRoutes(options.vehicleHmacKey ?? resolveVehicleHmacKey(), db))
    .route(
      '/',
      coverageRoutes(db, getRoads, now),
    )
    .route(
      '/',
      mapRoutes(db, getRoads, getRegions, live, now, mapAccess(extDeps)),
    );

export const createApp = (db: Db = openDb(), options: AppOptions = {}) => {
  const now = options.now ?? Date.now;
  const roads: Roads | null = attachRoads(db, options.roadsPath === undefined ? resolveRoadsPath() : options.roadsPath);
  const regions: Regions | null = attachRegions(db, options.regionsPath === undefined ? resolveRegionsPath() : options.regionsPath);
  // 시작 때 옛 코드 합산·쌓인 pending 재처리 1회. 실패해도 로그만 남기고 기동은 계속한다(트립 수신이 막히면 안 된다).
  if (regions) {
    try {
      inTx(db, () => mergeRegionAliases(db, regions));
    } catch (e) {
      console.warn(`시군구 별칭 합산 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const worker: MatchingWorker = createMatchingWorker({
    db,
    roads: () => roads,
    regions: () => regions,
    trace: options.valhalla,
    retryDelayMs: options.retryDelayMs,
    now,
  });
  const liveEnv = Number(process.env.NUBI_LIVE_INTERVAL_MS);
  const live = createLiveMatcher({
    db,
    roads: () => roads,
    trace: options.valhalla,
    intervalMs: options.liveIntervalMs ?? (Number.isFinite(liveEnv) && liveEnv > 0 ? liveEnv : undefined),
    now,
  });
  try {
    live.purge();
  } catch (e) {
    console.warn(`잠정 매칭 정리 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  /** 새 트립 Start·점 업로드 때 지난 트립의 방문·숙박을 판정한다. 판정 오류가 트립 업로드를 막지 않게 삼킨다. */
  const tick = (vehicleId: string, onlyIfPending: boolean) => {
    if (!regions) return;
    try {
      // 점 업로드는 '방문은 반영했고 시작 지점(숙박)만 기다리는' 이 차량의 pending이 있을 때만 판정한다.
      if (
        onlyIfPending &&
        !db
          .prepare(`SELECT 1 AS x FROM region_pending WHERE visit_done = 1 AND vehicle_id IN ${VEHICLE_SET_SQL} LIMIT 1`)
          .get(canonicalVehicleId(db, vehicleId), canonicalVehicleId(db, vehicleId))
      )
        return;
      inTx(db, () => resolvePending(db, regions, vehicleId, now()));
    } catch (e) {
      console.warn(`시군구 판정 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** 24시간 배치: 다음 트립이 안 온 pending을 방문으로 확정한다. */
  const regionsBatch = (nowMs: number = now()) => (regions ? inTx(db, () => runBatch(db, regions, nowMs)) : 0);
  if (options.resumeMatching) {
    worker.start();
    try {
      regionsBatch();
    } catch (e) {
      console.warn(`시군구 첫 배치 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
    const hourly = setInterval(
      () => {
        try {
          live.purge();
        } catch {
          // 정리는 다음 주기에 다시 한다
        }
        try {
          regionsBatch();
        } catch (e) {
          console.warn(`시군구 배치 실패: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      60 * 60 * 1000,
    );
    (hourly as { unref?: () => void }).unref?.(); // 폰 앱 tsc(DOM lib)에서 setInterval이 number로 보여도 컴파일되게
  }
  const extDeps = { db, getRoads: () => roads, getRegions: () => regions, now, options: options.ext ?? {} };
  const ext = createExt(extDeps);
  const app = buildRoutes({ db, worker, live, ext, extDeps, options, now, getRoads: () => roads, getRegions: () => regions, tick });
  if (options.viewer ?? (process.env.NUBI_VIEWER === '1' || process.env.NODE_ENV !== 'production')) app.route('/viewer', viewerRoutes());
  return Object.assign(app, { matching: worker, live, regionsBatch });
};

export type AppType = ReturnType<typeof buildRoutes>;
