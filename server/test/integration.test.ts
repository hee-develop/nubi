import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mapAccess, mapRoutes } from '../src/routes/map.js';
import { bearer, call, extApp, eastPoints, post, T0 } from './ext-helpers.js';
import { fakeValhalla, FIXTURE_NORTH, makePoints } from './helpers.js';

// T1(지도·잠정 매칭) × T2(인증·기록 멈춤·삭제) 연결 지점
const fixture = JSON.parse(readFileSync(FIXTURE_NORTH, 'utf8'));
const BOX = '126.99,37.49,127.03,37.52';
const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const liveApp = (auth?: 'optional' | 'required') =>
  extApp({ liveMatching: true, valhalla: { fetchFn: fakeValhalla(() => fixture) }, ext: auth ? { auth } : {} });
type LiveApp = ReturnType<typeof liveApp>;

const register = async (e: LiveApp, vin: string) => (await call(e, '/vehicles/register', post('', { vin }))).body as { vehicleId: string; vehicleToken?: string };
const startTrip = async (e: LiveApp, vehicleId: string, token?: string) => {
  const r = await call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: '2026-11-09T00:00:00Z' }, token ? bearer(token) : {}));
  return r.body.tripId as string;
};

describe('T1 지도 접근 확인(checkMapAccess) × T2 토큰 인증', () => {
  it('required: 자기 차량의 /map/base·/map/regions·/trips/:id/live는 200, 남의 차량은 403, 토큰이 없으면 401', async () => {
    const e = liveApp('required');
    const a = await register(e, 'KMHABCDEF12345678');
    const b = await register(e, 'KMHZZZZZZ12345678');
    const ta = await startTrip(e, a.vehicleId, a.vehicleToken);
    const tb = await startTrip(e, b.vehicleId, b.vehicleToken);
    const as = (t: string) => ({ headers: bearer(t) });
    expect((await call(e, `/map/base?bbox=${BOX}&z=14&vehicleId=${a.vehicleId}`, as(a.vehicleToken!))).status).toBe(200);
    expect((await call(e, `/map/base?bbox=${BOX}&z=14&vehicleId=${b.vehicleId}`, as(a.vehicleToken!))).status).toBe(403);
    expect((await call(e, `/map/regions?bbox=124,33,132,39&z=6&vehicleId=${a.vehicleId}`, as(a.vehicleToken!))).status).toBe(200);
    expect((await call(e, `/map/regions?bbox=124,33,132,39&z=6&vehicleId=${b.vehicleId}`, as(a.vehicleToken!))).status).toBe(403);
    expect((await call(e, `/trips/${ta}/live`, as(a.vehicleToken!))).status).toBe(200);
    expect((await call(e, `/trips/${tb}/live`, as(a.vehicleToken!))).status).toBe(403);
    // 반복 쿼리로 남의 차량을 섞어도 403
    expect((await call(e, `/map/base?bbox=${BOX}&z=14&vehicleId=${a.vehicleId}&vehicleId=${b.vehicleId}`, as(a.vehicleToken!))).status).toBe(403);
    expect((await call(e, `/map/base?bbox=${BOX}&z=14&vehicleId=${a.vehicleId}`)).status).toBe(401);
    expect((await call(e, `/trips/${ta}/live`)).status).toBe(401);
  });

  it('미들웨어 없이 mapRoutes만 마운트해도 같은 규칙으로 막는다(이중 방어, mapAccess 단독)', async () => {
    const e = liveApp('required');
    const a = await register(e, 'KMHABCDEF12345678');
    const b = await register(e, 'KMHZZZZZZ12345678');
    const tb = await startTrip(e, b.vehicleId, b.vehicleToken);
    const deps = { db: e.db, now: () => T0, options: { auth: 'required' as const } };
    const bare = new Hono().route('/', mapRoutes(e.db, () => null, () => null, undefined, () => T0, mapAccess(deps)));
    const h = { headers: bearer(a.vehicleToken!) };
    // roads DB가 없으면 /map/base는 503이므로, 접근 확인은 /map/regions(지역 DB 없음 503 전)·/live로 본다
    expect((await bare.request(`/trips/${tb}/live`, h)).status).toBe(403);
    expect((await bare.request(`/trips/${tb}/live`)).status).toBe(403);
    expect((await bare.request(`/trips/${tb}/live`, { headers: bearer(b.vehicleToken!) })).status).toBe(200);
    // optional은 토큰이 없으면 기존처럼 허용, 있는데 남의 차량이면 거부, off는 항상 허용
    const opt = new Hono().route('/', mapRoutes(e.db, () => null, () => null, undefined, () => T0, mapAccess({ ...deps, options: { auth: 'optional' } })));
    expect((await opt.request(`/trips/${tb}/live`)).status).toBe(200);
    expect((await opt.request(`/trips/${tb}/live`, h)).status).toBe(403);
    const off = new Hono().route('/', mapRoutes(e.db, () => null, () => null, undefined, () => T0, mapAccess({ ...deps, options: { auth: 'off' } })));
    expect((await off.request(`/trips/${tb}/live`, h)).status).toBe(200);
  });

  it('off(기본): 인증 없이 열려 기존 동작 그대로(차량 에뮬레이터·E2E)', async () => {
    const e = liveApp();
    const t = await startTrip(e, 'v-open');
    expect((await call(e, `/map/base?bbox=${BOX}&z=14&vehicleId=other`)).status).toBe(200);
    expect((await call(e, `/trips/${t}/live`)).status).toBe(200);
  });
});

describe('T1 trip_live* × T2 데이터 삭제·기록 멈춤', () => {
  const rows = (e: LiveApp, trips: string[]) => {
    const q = (t: string) => (e.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE trip_id IN (${trips.map(() => '?').join(',')})`).get(...trips) as { n: number }).n;
    return { live: q('trip_live'), ways: q('trip_live_ways') };
  };

  it('잠정 매칭 행이 있는 차량의 DELETE /vehicles/:id/data가 trip_live·trip_live_ways까지 CASCADE로 지운다(다른 차량은 그대로)', async () => {
    const e = liveApp();
    const mine = await startTrip(e, 'v-del');
    const other = await startTrip(e, 'v-keep');
    for (const t of [mine, other]) await call(e, `/trips/${t}/points`, post('', { points: makePoints(30) }));
    await e.app.live.idle();
    expect(rows(e, [mine]).live).toBe(1);
    expect(rows(e, [mine]).ways).toBeGreaterThan(0);
    const keep = rows(e, [other]);
    const del = await call(e, '/vehicles/v-del/data', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(del.body.deleted.trips).toBe(1);
    expect(rows(e, [mine])).toEqual({ live: 0, ways: 0 });
    expect(rows(e, [other])).toEqual(keep);
    expect((await call(e, `/trips/${mine}/live`)).status).toBe(404);
  });

  it('기록 멈춤이면 /trips/:id/live는 잠정 결과를 내지 않고(paused), 점 업로드도 잠정 매칭을 돌리지 않는다. 풀면 다시 돈다', async () => {
    const fetchFn = fakeValhalla(() => fixture);
    const e = extApp({ liveMatching: true, valhalla: { fetchFn } });
    const t = await startTrip(e, 'v-pause');
    await call(e, '/vehicles/v-pause/settings', put({ recordingPaused: true }));
    const up = await call(e, `/trips/${t}/points`, post('', { points: makePoints(30) }));
    expect(up.body).toEqual({ accepted: 0, duplicated: 0, paused: true });
    await e.app.live.idle();
    expect(fetchFn.calls.length).toBe(0);
    expect((await call(e, `/trips/${t}/live`)).body).toEqual({ status: 'idle', upToSeq: -1, ways: [], paused: true });
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM trip_live_ways').get()).toEqual({ n: 0 });
    // 동의 철회(데이터 삭제)도 같은 차단
    await call(e, '/vehicles/v-pause/settings', put({ recordingPaused: false }));
    await call(e, `/trips/${t}/points`, post('', { points: makePoints(30) }));
    await e.app.live.idle();
    expect(fetchFn.calls.length).toBeGreaterThan(0);
    const live = await call(e, `/trips/${t}/live`);
    expect(live.body.paused).toBeUndefined();
    expect(live.body.ways.length).toBeGreaterThan(0);
  });

  it('바램 판정은 T2 isFaded 하나다: map.ts는 자체 구현 없이 shared/fade를 쓴다', () => {
    const src = readFileSync(new URL('../src/routes/map.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/from '\.\.\/shared\/fade\.js'/);
    expect(src).not.toMatch(/export const isFaded/);
    void eastPoints;
  });
});
