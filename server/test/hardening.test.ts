import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import { CODE_MAX_ATTEMPTS, CodeGuard, ipKey } from '../src/ext/auth.js';
import { createExt } from '../src/routes/ext.js';
// @ts-expect-error 타입 선언이 없는 .mjs
import { recompute } from '../../scripts/recompute-coverage.mjs';
import { fakeValhalla, makeRoadsDb, matchedResponse } from './helpers.js';
import { bearer, call, DAY, eastRoads, extApp, MIN, peer, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const put = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const reg = async (e: ExtApp, vin: string) => (await call(e, '/vehicles/register', post('', { vin }))).body as { vehicleId: string; vehicleToken: string };
const startTrip = (e: ExtApp, vehicleId: string, headers: Record<string, string> = {}) =>
  call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: '2026-11-09T00:00:00Z' }, headers));

afterEach(() => vi.unstubAllEnvs());

describe('C1 토큰 범위: 쿼리·경로·트립·본문을 모두 모아 하나라도 밖이면 403', () => {
  const setup = async (auth: 'required' | 'optional' = 'required') => {
    const e = extApp({ ext: { auth } });
    const a = await reg(e, 'KMHAAAAAAA1234567');
    const b = await reg(e, 'KMHBBBBBBB1234567');
    const tripB = (await startTrip(e, b.vehicleId, bearer(b.vehicleToken))).body.tripId as string;
    return { e, a, b, tripB, ha: bearer(a.vehicleToken) };
  };

  for (const auth of ['required', 'optional'] as const) {
    it(`[${auth}] 쿼리·경로·본문 불일치와 중복 쿼리는 403(삭제·설정·트립 조회·쓰기)`, async () => {
      const { e, a, b, tripB, ha } = await setup(auth);
      // 경로는 B, 쿼리는 A: 삭제·설정 모두 거부
      expect((await call(e, `/vehicles/${b.vehicleId}/data?vehicleId=${a.vehicleId}`, { method: 'DELETE', headers: ha })).status).toBe(403);
      expect((await call(e, `/vehicles/${b.vehicleId}/settings?vehicleId=${a.vehicleId}`, put({ recordingPaused: true }, ha))).status).toBe(403);
      expect((await call(e, `/vehicles/${a.vehicleId}/settings?vehicleId=${b.vehicleId}`, put({ recordingPaused: true }, ha))).status).toBe(403);
      // 트립 소유 차량(B)이 쿼리(A)와 다름
      expect((await call(e, `/trips/${tripB}?vehicleId=${a.vehicleId}`, { headers: ha })).status).toBe(403);
      expect((await call(e, `/trips/${tripB}/live?vehicleId=${a.vehicleId}`, { headers: ha })).status).toBe(403);
      // 본문 vehicleId(A)와 트립 경로(B)
      expect((await call(e, `/trips/${tripB}/end`, post('', { endedAt: '2026-11-09T00:10:00Z', vehicleId: a.vehicleId }, ha))).status).toBe(403);
      // 쿼리 A + 본문 B
      expect((await call(e, `/pair/code?vehicleId=${a.vehicleId}`, post('', { vehicleId: b.vehicleId, gear: 'P' }, ha))).status).toBe(403);
      // 같은 키를 여러 번(A, B) 보내는 우회
      expect((await call(e, `/coverage/summary?vehicleId=${a.vehicleId}&vehicleId=${b.vehicleId}`, { headers: ha })).status).toBe(403);
      // 정상: 모두 A
      expect((await call(e, `/vehicles/${a.vehicleId}/settings?vehicleId=${a.vehicleId}`, { headers: ha })).status).toBe(200);
      // B 데이터는 지워지지 않았다
      expect((e.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE vehicle_id = ?').get(b.vehicleId) as { n: number }).n).toBe(1);
    });
  }

  it('alias: to가 토큰 밖이면 403, from이 이미 토큰·차주·alias 대상인 정본이면 409, 그 밖의 새 UUID는 이어 붙는다', async () => {
    const { e, a, b, ha } = await setup();
    expect((await call(e, '/vehicles/alias', post('', { fromVehicleId: 'uuid-new', toVehicleId: b.vehicleId }, ha))).status).toBe(403);
    // from = B(자기 토큰이 있는 정본)를 A에 이으려는 시도(B의 기록을 A로 끌어오는 우회)
    const steal = await call(e, '/vehicles/alias', post('', { fromVehicleId: b.vehicleId, toVehicleId: a.vehicleId }, ha));
    expect(steal.status).toBe(409);
    expect(steal.body).toEqual({ error: 'alias_source_is_vehicle' });
    expect((await call(e, '/vehicles/alias', post('', { fromVehicleId: 'uuid-new', toVehicleId: a.vehicleId }, ha))).status).toBe(201);
    // 이미 다른 alias의 대상(정본)인 ID도 출발점이 될 수 없다
    const other = await call(e, '/vehicles/alias', post('', { fromVehicleId: a.vehicleId, toVehicleId: 'x-target' }, ha));
    expect(other.status).toBe(409);
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM vehicle_alias WHERE alias_id = ?").get(b.vehicleId)).toEqual({ n: 0 });
  });

  it('alias 출발점 검사는 인증 off에서도 적용된다(토큰이 있는 정본을 끌어오지 못한다)', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const a = await reg(e, 'KMHAAAAAAA1234567');
    const e2 = extApp({});
    e2.db.prepare("INSERT INTO accounts (id, kind, vehicle_id, created_at) VALUES ('o1', 'owner', 'owned-car', 'x')").run();
    expect((await call(e2, '/vehicles/alias', post('', { fromVehicleId: 'owned-car', toVehicleId: 'v-new' }))).status).toBe(409);
    expect((await call(e2, '/vehicles/alias', post('', { fromVehicleId: 'fresh-uuid', toVehicleId: 'v-new' }))).status).toBe(201);
    void a;
  });

  it('큰 본문으로 파싱을 피할 수 없다(범위 검사는 항상 전체 본문), 라우트 한도 초과는 413, 전역 1MB 초과는 413, 트립 점 업로드는 경로 소유만 본다', async () => {
    const { e, a, b, tripB, ha } = await setup();
    const pad = 'x'.repeat(20_000);
    const big = await call(e, '/share/cards', post('', { vehicleId: a.vehicleId, kind: 'national', pad }, ha));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'payload_too_large' });
    // 본문이 B를 가리키는데 크게 부풀려 파싱을 피하려는 시도
    expect((await call(e, '/vehicles/alias', post('', { fromVehicleId: 'u', toVehicleId: b.vehicleId, pad }, ha))).status).toBe(403); // 부풀려도 to=B는 그대로 잡힌다
    const huge = await call(e, '/trips', { method: 'POST', headers: { 'content-type': 'application/json', ...ha }, body: JSON.stringify({ vehicleId: a.vehicleId, pad: 'y'.repeat(1_100_000) }) });
    expect(huge.status).toBe(413);
    // 남의 트립에 점 업로드는 토큰 범위(경로의 트립 소유)로 막힌다
    expect((await call(e, `/trips/${tripB}/points`, post('', { points: [] }, ha))).status).toBe(403);
    expect((await call(e, `/trips/${tripB}/points`, post('', { points: [{ seq: 0, ts: '2026-11-09T00:00:00Z', lat: 37.5, lon: 127 }] }, bearer(b.vehicleToken)))).status).toBe(200);
  });

  it('settings·courses·debug에도 작은 본문 한도가 있다', async () => {
    const e = extApp({ ext: { b2bKey: 'k1', debug: true } });
    const pad = 'z'.repeat(5000);
    expect((await call(e, '/vehicles/v1/settings', put({ homeRegion: null, pad }))).status).toBe(413);
    expect((await call(e, '/debug/age', post('', { vehicleId: 'v', days: 1, pad }))).status).toBe(413);
    expect((await call(e, '/b2b/courses', post('', { name: 'n', regionCode: '11140', roadKeys: ['a'], pad: 'q'.repeat(9000) }, bearer('k1')))).status).toBe(413);
  });
});

describe('T1 합류 준비: 체인 어디에 붙여도 인증이 적용된다', () => {
  const build = (auth: 'required' | 'optional') => {
    const db = openDb(':memory:');
    const deps = { db, getRoads: () => null, getRegions: () => null, now: () => T0, options: { auth } };
    const ext = createExt(deps);
    // T1이 ext.routes 뒤에 붙이는 라우트를 흉내 낸다
    const app = new Hono()
      .use('*', ext.middleware)
      .route('/', ext.routes)
      .get('/map/base', (c) => c.json({ ok: true, vehicleId: c.req.query('vehicleId') ?? null }))
      .get('/trips/:id/live', (c) => c.json({ status: 'running', upToSeq: 1, ways: [] }));
    return { app, db };
  };

  it('/map/base·/trips/:id/live는 required에서 토큰·범위 검사를 받고(401·403), 기록 멈춤이면 live는 잠정 결과를 내지 않는다', async () => {
    const { app, db } = build('required');
    const rq = (p: string, h: Record<string, string> = {}) => app.request(p, { headers: h });
    expect((await rq('/map/base?vehicleId=a')).status).toBe(401);
    const { issueToken } = await import('../src/ext/auth.js');
    const tokenA = issueToken(db, 'vehicle', 'veh-a', T0);
    expect((await rq('/map/base?vehicleId=veh-b', bearer(tokenA))).status).toBe(403);
    expect((await rq('/map/base?vehicleId=veh-a', bearer(tokenA))).status).toBe(200);
    db.prepare("INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('t-b', 'l', 'veh-b', 'd', 'x', 'x'), ('t-a', 'l2', 'veh-a', 'd', 'x', 'x')").run();
    expect((await rq('/trips/t-b/live', bearer(tokenA))).status).toBe(403); // 경로의 트립 소유로 일반 규칙 적용
    expect(await (await rq('/trips/t-a/live', bearer(tokenA))).json()).toMatchObject({ status: 'running' });
    // 기록 멈춤: 같은 경로를 ext가 먼저 받아 잠정 결과를 내지 않는다(훅)
    await app.request('/vehicles/veh-a/settings', put({ recordingPaused: true }, bearer(tokenA)));
    expect(await (await rq('/trips/t-a/live', bearer(tokenA))).json()).toEqual({ status: 'idle', upToSeq: -1, ways: [], paused: true });
  });
});

describe('M7 off 모드의 파괴적 API는 로컬 접속만(또는 차량 토큰)', () => {
  const remote = peer('203.0.113.9');
  it('원격에서 DELETE data·PUT settings·POST pair/code·guest/code·guest/end-all은 403 local_only, 로컬(127.0.0.1·::1)과 명시한 프로세스 안 호출은 허용, 10.0.2.x·주소 모름은 로컬이 아니다', async () => {
    const e = extApp();
    for (const [path, init] of [
      ['/vehicles/v1/data', { method: 'DELETE' }],
      ['/vehicles/v1/settings', put({ recordingPaused: true })],
      ['/pair/code', post('', { vehicleId: 'v1', gear: 'P' })],
      ['/guest/code', post('', { vehicleId: 'v1', gear: 'P' })],
      ['/guest/end-all', post('', { vehicleId: 'v1' })],
    ] as const) {
      const r = await call(e, path, init, remote);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'local_only' });
      for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect((await call(e, path, init, peer(addr))).status).toBe(200);
      expect((await call(e, path, init, peer('10.0.2.2'))).status).toBe(403); // 에뮬레이터 트래픽은 호스트에서 127.0.0.1로 보인다
      // 주소를 모르면 로컬이 아니다(명시 옵션 없이는 fail-closed)
      expect((await call(extApp({ ext: { inProcessLocal: false } }), path, init)).status).toBe(403);
      expect((await call(e, path, init)).status).toBe(200);
    }
    // 프록시 헤더가 있으면(프록시 뒤) 소켓이 로컬이어도 로컬이 아니다
    const viaProxy = await call(e, '/vehicles/v1/data', { method: 'DELETE', headers: { 'x-forwarded-for': '198.51.100.7' } }, peer('127.0.0.1'));
    expect(viaProxy.status).toBe(403);
    // 조회·트립 쓰기(차량 앱 E2E 경로)는 원격에서도 기존대로
    expect((await call(e, '/vehicles/v1/settings', undefined, remote)).status).toBe(200);
    expect((await call(e, '/trips', post('', { localId: 'l1', vehicleId: 'v-untouched', driverId: 'v-untouched', startedAt: '2026-11-09T00:00:00Z' }), remote)).status).toBe(201); // v1은 위에서 데이터 삭제(동의 철회)를 했으므로 건드리지 않은 차량으로 본다
    expect((await call(e, '/coverage/summary?vehicleId=v1', undefined, remote)).status).toBe(200);
  });

  it('optional에서 토큰 없는 원격은 같은 호출이 403, 맞는 차량 토큰이면 원격에서도 허용', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const a = await reg(e, 'KMHAAAAAAA1234567');
    const remote2 = peer('198.51.100.20');
    expect((await call(e, `/vehicles/${a.vehicleId}/data`, { method: 'DELETE' }, remote2)).body).toEqual({ error: 'local_only' });
    expect((await call(e, `/vehicles/${a.vehicleId}/data`, { method: 'DELETE', headers: bearer(a.vehicleToken) }, remote2)).status).toBe(200);
  });
});

describe('M5 토큰 만료·폐기', () => {
  it('API 계정 토큰은 180일 뒤 만료되고 연결 해제하면 폐기(revoked_at)된다', async () => {
    const e = extApp();
    const code = (await call(e, '/pair/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code;
    const owner = (await call(e, '/pair/claim', post('', { consent: true, code }))).body;
    const row = e.db.prepare("SELECT scope, expires_at, revoked_at FROM auth_tokens WHERE kind = 'account'").get() as any;
    expect(row.scope).toBe('api');
    expect(Date.parse(row.expires_at)).toBe(T0 + 180 * DAY);
    expect((await call(e, '/me/summary', { headers: bearer(owner.token) })).status).toBe(200);
    e.clock.t = T0 + 179 * DAY;
    expect((await call(e, '/me/summary', { headers: bearer(owner.token) })).status).toBe(200);
    e.clock.t = T0 + 181 * DAY;
    expect((await call(e, '/me/summary', { headers: bearer(owner.token) })).status).toBe(401);
    // 해제 = 폐기(행은 남고 revoked_at이 찬다)
    e.clock.t = T0 + DAY;
    const code2 = (await call(e, '/pair/code', post('', { vehicleId: 'v2', gear: 'P' }))).body.code;
    const o2 = (await call(e, '/pair/claim', post('', { consent: true, code: code2 }))).body;
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(o2.token) })).status).toBe(200);
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE revoked_at IS NOT NULL").get()).toEqual({ n: 1 });
    expect((await call(e, '/me/summary', { headers: bearer(o2.token) })).status).toBe(401);
  });

  it('차량 토큰은 만료 없이 폐기만 된다', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const a = await reg(e, 'KMHAAAAAAA1234567');
    expect(e.db.prepare("SELECT expires_at FROM auth_tokens WHERE kind = 'vehicle'").get()).toEqual({ expires_at: null });
    e.clock.t += 400 * DAY;
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(a.vehicleToken) })).status).toBe(404); // 인증은 통과(연결 없음)
  });
});

describe('M4 코드 시도 제한', () => {
  it('ipKey: IPv4는 그대로, IPv6는 /64 단위로 묶고 IPv4-매핑 주소는 IPv4로', () => {
    expect(ipKey('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64');
    expect(ipKey('2001:DB8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    expect(ipKey('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('같은 /64의 다른 주소로 바꿔 가며 시도해도 한 출처로 센다', async () => {
    const e = extApp({ ext: { rateLimit: { max: 3, windowMs: 5 * MIN } } });
    const code = (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code as string;
    const wrong = code === '000000' ? '111111' : '000000';
    for (const addr of ['2001:db8:1:2::1', '2001:db8:1:2:aaaa::2', '2001:db8:1:2:bbbb:cccc::3'])
      expect((await call(e, '/guest/claim', post('', { code: wrong, consent: true }), peer(addr))).status).toBe(404);
    // 같은 /64의 새 주소: 맞는 코드도 막힌다
    expect((await call(e, '/guest/claim', post('', { code, consent: true }), peer('2001:db8:1:2:dead:beef::9'))).status).toBe(429);
    // 다른 /64는 영향 없다
    expect((await call(e, '/guest/claim', post('', { code, consent: true }), peer('2001:db8:9:9::1'))).status).toBe(200);
  });

  it('한 코드를 건드린 횟수가 상한을 넘으면 그 코드는 무효가 된다(맞는 코드를 알아내려는 반복 시도 방어)', async () => {
    const e = extApp();
    const code = (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code as string;
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) expect((await call(e, `/g/${code}`)).status).toBe(200); // 페이지 열람도 센다
    const r = await call(e, '/guest/claim', post('', { code, consent: true }));
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ error: 'code_used' });
    expect((e.db.prepare('SELECT used_at FROM link_codes WHERE code = ?').get(code) as { used_at: string | null }).used_at).not.toBeNull();
  });

  it('전역 잠금이 없다: 다른 출처의 실패가 아무리 쌓여도 새 출처의 맞는 claim은 통과하고, 지연(penalty)만 늘어난다', async () => {
    const e = extApp({ ext: { rateLimit: { max: 1, windowMs: 5 * MIN } } });
    const code = (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code as string;
    const wrong = code === '000000' ? '111111' : '000000';
    // max=1 → 전역 소프트 한도 20. 서로 다른 출처 25곳이 실패(각 출처 1회라 개별 잠금은 아님)
    for (let i = 0; i < 25; i++) await call(e, '/guest/claim', post('', { code: wrong, consent: true }), peer(`198.51.100.${i + 1}`));
    const r = await call(e, '/guest/claim', post('', { code, consent: true }), peer('192.0.2.77'));
    expect(r.status).toBe(200);
    const g = new CodeGuard(() => T0, { max: 1, windowMs: MIN });
    expect(g.penalty()).toBe(0);
    for (let i = 0; i < 25; i++) g.fail(`ip${i}`);
    expect(g.penalty()).toBeGreaterThan(0);
    expect(g.penalty()).toBeLessThanOrEqual(2000);
    expect(g.blocked('fresh-ip')).toBe(false);
  });
});

describe('M3 데이터 삭제와 진행 중 매칭의 경합', () => {
  const setup = async () => {
    const gate: { release: () => void; p: Promise<void> } = { release: () => {}, p: Promise.resolve() };
    gate.p = new Promise<void>((r) => (gate.release = r));
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), eastRoads(3));
    const e = extApp({
      roadsPath,
      valhalla: { fetchFn: fakeValhalla(async () => { await gate.p; return matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }], 40); }) },
    });
    return { e, gate };
  };
  const startAndEnd = async (e: ExtApp, v: string) => {
    const pts = Array.from({ length: 80 }, (_, i) => ({ seq: i, ts: new Date(T0 + i * 2000).toISOString(), lat: 37.5665, lon: 126.978 + (i * 25) / (111_195 * Math.cos((37.5665 * Math.PI) / 180)) }));
    const s = await call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId: v, driverId: v, startedAt: pts[0]!.ts }));
    await call(e, `/trips/${s.body.tripId}/points`, post('', { points: pts }));
    await call(e, `/trips/${s.body.tripId}/end`, post('', { endedAt: pts.at(-1)!.ts }));
    return s.body.tripId as string;
  };
  const count = (e: ExtApp, sql: string, ...a: string[]) => (e.db.prepare(sql).get(...a) as { n: number }).n;

  it('매칭(Valhalla 대기) 중 데이터를 지우면 결과를 되살려 쓰지 않는다: driven_ways·시군구·지역 작업·매칭 행이 모두 비어 있다', async () => {
    const { e, gate } = await setup();
    await startAndEnd(e, 'v1');
    const del = await call(e, '/vehicles/v1/data', { method: 'DELETE' });
    expect(del.body.deleted.trips).toBe(1);
    gate.release();
    await e.app.matching.idle();
    expect(count(e, 'SELECT COUNT(*) AS n FROM driven_ways')).toBe(0);
    expect(count(e, 'SELECT COUNT(*) AS n FROM visited_regions')).toBe(0);
    expect(count(e, 'SELECT COUNT(*) AS n FROM region_jobs')).toBe(0);
    expect(count(e, 'SELECT COUNT(*) AS n FROM region_events')).toBe(0);
    expect(count(e, 'SELECT COUNT(*) AS n FROM trip_matching')).toBe(0);
    expect(count(e, 'SELECT COUNT(*) AS n FROM way_revived')).toBe(0);
    expect((await call(e, '/coverage/summary?vehicleId=v1')).body.drivenKm).toBe(0);
    // 다른 차량의 매칭은 정상
    const e2 = await setup();
    await startAndEnd(e2.e, 'v1');
    e2.gate.release();
    await e2.e.app.matching.idle();
    expect(count(e2.e, 'SELECT COUNT(*) AS n FROM driven_ways')).toBeGreaterThan(0);
  });

  it('동의 철회 상태에서 끝난 매칭은 쓰지 않고 skipped(consent_withdrawn)로 끝낸다', async () => {
    const { e, gate } = await setup();
    const tripId = await startAndEnd(e, 'v2');
    // 철회 표시만 심는다(트립은 남겨 둔 채) — 삭제 뒤에 새로 만들어진 트립이 매칭되는 경우
    e.db.prepare("INSERT INTO vehicle_settings (vehicle_id, recording_paused, consent_withdrawn_at, updated_at) VALUES ('v2', 1, 'x', 'x')").run();
    gate.release();
    await e.app.matching.idle();
    expect(count(e, 'SELECT COUNT(*) AS n FROM driven_ways')).toBe(0);
    const m = (await call(e, `/trips/${tripId}/matching`)).body;
    expect(m.status).toBe('done');
    expect(m.result).toMatchObject({ outcome: 'skipped', reason: 'consent_withdrawn' });
  });
});

describe('minor', () => {
  it('debug 라우트: NUBI_DEBUG=1일 때만(옵션 ext.debug가 덮는다), production에서는 NUBI_DEBUG=1이어도 없다', async () => {
    const body = post('', { vehicleId: 'v1', days: 5 });
    const off = extApp();
    expect((await call(off, '/debug/age', body)).status).toBe(404); // NODE_ENV=test여도 기본 꺼짐
    vi.stubEnv('NUBI_DEBUG', '1');
    expect((await call(extApp(), '/debug/age', body)).status).toBe(200);
    expect((await call(extApp({ ext: { debug: false } }), '/debug/age', body)).status).toBe(404);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await call(extApp(), '/debug/age', body)).status).toBe(404);
    expect((await call(extApp({ ext: { debug: true } }), '/debug/age', body)).status).toBe(200); // 명시 옵션이 우선(코드로만 가능)
  });

  it('스키마는 openDb만으로도 확장 테이블·열을 갖는다(way_revived 조회가 라우트 생성과 무관하게 동작)', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['way_revived', 'accounts', 'auth_tokens', 'link_codes', 'guest_sessions', 'guest_trip_ways', 'vehicle_settings', 'share_cards', 'intro_cache', 'courses', 'certificates']) expect(tables).toContain(t);
    expect(() => db.prepare('SELECT SUM(cov) FROM way_revived').get()).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(auth_tokens)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['scope', 'expires_at', 'revoked_at']));
  });

  it('recompute --apply는 한 트랜잭션: 중간에 실패하면 스냅샷도 snapshot_month도 바뀌지 않는다', async () => {
    const dbPath = join(tmp(), 'u.sqlite');
    const user = new DatabaseSync(dbPath);
    user.exec('CREATE TABLE driven_ways (vehicle_id TEXT NOT NULL, way_id INTEGER NOT NULL, coverage REAL NOT NULL, first_driven_at TEXT NOT NULL, last_driven_at TEXT NOT NULL, trip_id_first TEXT NOT NULL, snapshot_month TEXT NOT NULL, PRIMARY KEY (vehicle_id, way_id))');
    user.exec('CREATE TABLE vehicle_alias (alias_id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL)');
    user.exec("INSERT INTO driven_ways VALUES ('v1', 1, 1, 'a', 'b', 't', '209901'), ('v2', 1, 1, 'a', 'b', 't', '209901')");
    // 두 번째 차량 행을 쓰다 실패하도록 망가진 스냅샷 테이블을 미리 둔다(NOT NULL 열이 하나 더 있다)
    user.exec('CREATE TABLE coverage_snapshots (vehicle_id TEXT NOT NULL, month TEXT NOT NULL, driven_m REAL NOT NULL, total_m REAL NOT NULL, percent REAL NOT NULL, roads_started INTEGER NOT NULL, roads_completed INTEGER NOT NULL, missing_ways INTEGER NOT NULL, computed_at TEXT NOT NULL, extra TEXT NOT NULL, PRIMARY KEY (vehicle_id, month))');
    const newRoads = await makeRoadsDb(join(tmp(), 'new.sqlite'), eastRoads(1), '210001');
    user.exec(`ATTACH DATABASE '${pathToFileURL(newRoads).href}?mode=ro' AS rd`);
    expect(() => recompute(user, { month: '210001', totalNamedLengthM: 1000, apply: true })).toThrow();
    expect(user.prepare("SELECT COUNT(*) AS n FROM driven_ways WHERE snapshot_month = '210001'").get()).toEqual({ n: 0 });
    expect(user.prepare('SELECT COUNT(*) AS n FROM coverage_snapshots').get()).toEqual({ n: 0 });
    user.close();
  });
});

