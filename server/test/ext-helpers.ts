import { createApp, type AppOptions } from '../src/app.js';
import { openDb, type Db } from '../src/db/index.js';
import { REGIONS_TEST_DB, ROADS_TEST_DB } from './helpers.js';

export const T0 = Date.parse('2026-11-12T00:00:00Z');
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** 확장 API 테스트용 앱: DB 핸들과 시계를 함께 돌려준다. */
export const extApp = (options: AppOptions = {}) => {
  const db: Db = openDb(':memory:');
  const clock = { t: T0 };
  const app = createApp(db, {
    vehicleHmacKey: 'test-key',
    retryDelayMs: 5,
    now: () => clock.t,
    ...options,
    // 프로세스 안 호출(app.request)은 소켓 주소가 없다: 테스트에서만 로컬로 본다(실제 서버는 영향 없음)
    ext: { inProcessLocal: true, ...options.ext },
    roadsPath: options.roadsPath === undefined ? ROADS_TEST_DB : options.roadsPath,
    regionsPath: options.regionsPath === undefined ? REGIONS_TEST_DB : options.regionsPath,
  });
  return { app, db, clock };
};
export type ExtApp = ReturnType<typeof extApp>;

export const post = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** 요청을 보내고 상태와 JSON 본문을 돌려준다. */
export const call = async (e: ExtApp, path: string, init?: RequestInit, env?: unknown) => {
  const res = await e.app.request(path, init, env as never);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // HTML 등
  }
  return { status: res.status, body, res, text };
};

/** 원격 주소를 흉내 내는 Env(`getConnInfo`가 읽는 형태). */
export const peer = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

const LAT0 = 37.5665;
const LON0 = 126.978;
const mPerLon = (lat: number) => 111_195 * Math.cos((lat * Math.PI) / 180);

/** 서울 중구(126.978, 37.5665)에서 동쪽으로 달리는 점 [n]개(기본 25m 간격, 2초 간격). 합성 도로 [eastRoads]와 같은 선 위에 있다. */
export const eastPoints = (n: number, startMs: number, stepM = 25, lat = LAT0, lon0 = LON0) =>
  Array.from({ length: n }, (_, i) => ({ seq: i, ts: new Date(startMs + i * 2000).toISOString(), lat, lon: lon0 + (i * stepM) / mPerLon(lat) }));

/** 같은 선 위에 이어진 동쪽 도로 [count]개(각 [lengthM]m). id 1부터, road key `nm:r1`…. */
export const eastRoads = (count = 3, lengthM = 1000, lat = LAT0, lon0 = LON0) =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    roadKey: `nm:r${i + 1}`,
    lengthM,
    highway: 'residential' as const,
    at: [lon0 + (i * lengthM) / mPerLon(lat), lat] as [number, number],
    name: `r${i + 1}`,
  }));

/** 트립 하나를 올리고 끝낸 뒤 매칭까지 기다린다. 점은 [pts](기본: [startMs]부터 동쪽 [n]개). */
export const driveEast = async (e: ExtApp, vehicleId: string, startMs: number, n = 120, pts = eastPoints(n, startMs)) => {
  const start = await call(e, '/trips', post('/trips', { localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: pts[0]!.ts }));
  const tripId = start.body.tripId as string;
  await call(e, `/trips/${tripId}/points`, post('', { points: pts }));
  await call(e, `/trips/${tripId}/end`, post('', { endedAt: pts.at(-1)!.ts }));
  await e.app.matching.idle();
  return tripId;
};
