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
export const call = async (e: ExtApp, path: string, init?: RequestInit) => {
  const res = await e.app.request(path, init);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // HTML 등
  }
  return { status: res.status, body, res, text };
};
