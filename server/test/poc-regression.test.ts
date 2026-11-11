/** 재현 스크립트(scratchpad/poc: bom·bom2·path·web·legacy)를 회귀 테스트로 옮긴 것과, 같은 리뷰의 나머지 보강 항목. */
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import { ensureExtSchema } from '../src/db/schema-ext.js';
import { vehicleScoped, clientKey } from '../src/ext/auth.js';
import { parseJsonBytes } from '../src/ext/body.js';
import { fakeValhalla, makeRoadsDb, matchedResponse } from './helpers.js';
import { bearer, call, driveEast, eastRoads, extApp, HOUR, peer, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (v: unknown) => Buffer.concat([BOM, Buffer.from(JSON.stringify(v))]);
const remote = peer('203.0.113.9');
const JSON_H = { 'content-type': 'application/json' };
const form = (fields: Record<string, string>, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

afterEach(() => vi.unstubAllEnvs());

const twoVehicles = async (auth: 'required' | 'optional' = 'required') => {
  const e = extApp({ ext: { auth, inProcessLocal: false } });
  const reg = async (vin: string) => (await call(e, '/vehicles/register', post('', { vin }), remote)).body as { vehicleId: string; vehicleToken: string };
  const atk = await reg('ATTACKER0000000001');
  const vic = await reg('VICTIM00000000001');
  const H = { ...JSON_H, ...bearer(atk.vehicleToken) };
  const raw = (path: string, init: RequestInit) => call(e, path, init, remote);
  return { e, atk, vic, H, raw };
};

describe('C1 본문을 한 번만 파싱한다: BOM·UTF-16·빈 본문·배열·객체 아닌 JSON (bom.mts·bom2.mts)', () => {
  it('parseJsonBytes는 Fetch 표준과 같다: BOM 제거, UTF-16은 실패, 빈 본문은 empty', () => {
    expect(parseJsonBytes(withBom({ a: 1 }))).toEqual({ state: 'ok', value: { a: 1 } });
    expect(parseJsonBytes(Buffer.from('{"a":1}'))).toEqual({ state: 'ok', value: { a: 1 } });
    expect(parseJsonBytes(Buffer.from('﻿{"a":1}', 'utf16le')).state).toBe('invalid');
    expect(parseJsonBytes(Buffer.alloc(0))).toEqual({ state: 'empty' });
    expect(parseJsonBytes(Buffer.from('  ')).state).toBe('invalid');
    expect(parseJsonBytes(Buffer.from('{깨짐')).state).toBe('invalid');
  });

  it('BOM 본문으로 /pair/code·/vehicles/alias·POST /trips의 범위·alias 검사를 우회할 수 없다(403·409)', async () => {
    const { e, atk, vic, H, raw } = await twoVehicles();
    const plain = await raw('/pair/code', { method: 'POST', headers: H, body: JSON.stringify({ vehicleId: vic.vehicleId, gear: 'P' }) });
    expect(plain.status).toBe(403);
    const bom = await raw('/pair/code', { method: 'POST', headers: H, body: withBom({ vehicleId: vic.vehicleId, gear: 'P' }) });
    expect(bom.status).toBe(403); // 예전: 200 + 피해 차량의 코드
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM link_codes").get()).toEqual({ n: 0 });
    const tripBom = await raw('/trips', { method: 'POST', headers: H, body: withBom({ localId: 'x1', vehicleId: vic.vehicleId, driverId: 'd', startedAt: '2026-11-12T00:00:00Z' }) });
    expect(tripBom.status).toBe(403);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM trips').get()).toEqual({ n: 0 });
    // alias: from = 피해 차량(토큰이 있는 정본) → 평문·BOM 모두 409, 피해 트립은 읽히지 않는다
    const vh = { ...JSON_H, ...bearer(vic.vehicleToken) };
    const t = (await raw('/trips', { method: 'POST', headers: vh, body: JSON.stringify({ localId: 'v1', vehicleId: vic.vehicleId, driverId: 'd', startedAt: '2026-11-12T00:00:00Z' }) })).body;
    const alias = { fromVehicleId: vic.vehicleId, toVehicleId: atk.vehicleId };
    expect((await raw('/vehicles/alias', { method: 'POST', headers: H, body: JSON.stringify(alias) })).status).toBe(409);
    expect((await raw('/vehicles/alias', { method: 'POST', headers: H, body: withBom(alias) })).status).toBe(409);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM vehicle_alias').get()).toEqual({ n: 0 });
    expect((await raw(`/trips/${t.tripId}`, { headers: H })).status).toBe(403);
    expect(JSON.stringify((await raw(`/trips?vehicleId=${atk.vehicleId}`, { headers: H })).body)).not.toContain(t.tripId);
  });

  it('자기 차량 BOM 본문은 라우트와 미들웨어가 같게 읽어 정상 처리된다(한 번만 파싱)', async () => {
    const { atk, H, raw } = await twoVehicles();
    const ok = await raw('/pair/code', { method: 'POST', headers: H, body: withBom({ vehicleId: atk.vehicleId, gear: 'P' }) });
    expect(ok.status).toBe(200);
    // 인증 off에서도 같은 해석(BOM 허용)
    const off = extApp();
    const r = await off.app.request('/vehicles/register', { method: 'POST', headers: JSON_H, body: withBom({ vin: 'KMHABCDEF12345678' }) });
    expect(r.status).toBe(200);
  });

  it('인증 모드에서 비어 있지 않은 본문의 파싱 실패·UTF-16·배열·객체 아닌 JSON은 400(fail-closed), 빈 본문·폼은 라우트가 400', async () => {
    const { atk, vic, H, raw } = await twoVehicles();
    const body = { vehicleId: vic.vehicleId, gear: 'P' };
    for (const [name, b] of [
      ['UTF-16LE+BOM', Buffer.from('﻿' + JSON.stringify(body), 'utf16le')],
      ['UTF-16BE', Buffer.from(JSON.stringify(body), 'utf16le').swap16()],
      ['깨진 JSON', Buffer.from('{"vehicleId":')],
      ['배열', Buffer.from(JSON.stringify([body]))],
      ['문자열', Buffer.from('"vehicleId"')],
      ['숫자', Buffer.from('123')],
      ['null', Buffer.from('null')],
      ['공백만', Buffer.from('   ')],
    ] as const) {
      const r = await raw('/pair/code', { method: 'POST', headers: H, body: b });
      expect(r.status, name).toBe(400);
      expect(r.body, name).toEqual({ error: 'invalid_body' });
    }
    expect((await raw('/pair/code', { method: 'POST', headers: H })).status).toBe(400); // 빈 본문
    expect((await raw('/pair/code', { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: `vehicleId=${vic.vehicleId}&gear=P` })).status).toBe(400);
  });


  it('트립 점 업로드·종료도 같은 파싱을 쓴다(BOM 점 묶음은 정상, 남의 트립은 403)', async () => {
    const { atk, vic, H, raw } = await twoVehicles();
    const vh = { ...JSON_H, ...bearer(vic.vehicleToken) };
    const t = (await raw('/trips', { method: 'POST', headers: vh, body: JSON.stringify({ localId: 'v1', vehicleId: vic.vehicleId, driverId: 'd', startedAt: '2026-11-12T00:00:00Z' }) })).body;
    const pts = { points: [{ seq: 0, ts: '2026-11-12T00:00:00Z', lat: 37.5, lon: 127 }] };
    expect((await raw(`/trips/${t.tripId}/points`, { method: 'POST', headers: H, body: withBom(pts) })).status).toBe(403);
    expect((await raw(`/trips/${t.tripId}/points`, { method: 'POST', headers: vh, body: withBom(pts) })).body).toEqual({ accepted: 1, duplicated: 0 });
    expect((await raw(`/trips/${t.tripId}/end`, { method: 'POST', headers: H, body: JSON.stringify({ endedAt: '2026-11-12T01:00:00Z' }) })).status).toBe(403);
    void atk;
  });
});

describe('경로 우회 (path.mts): 점 구간·연속 슬래시·끝 슬래시·대소문자·인코딩', () => {
  it('어떤 모양의 경로·쿼리로도 피해 차량의 조회·삭제·설정에 닿지 않는다', async () => {
    const { e, atk, vic, H, raw } = await twoVehicles();
    const vh = { ...JSON_H, ...bearer(vic.vehicleToken) };
    const t = (await raw('/trips', { method: 'POST', headers: vh, body: JSON.stringify({ localId: 'v1', vehicleId: vic.vehicleId, driverId: 'd', startedAt: '2026-11-12T00:00:00Z' }) })).body;
    const V = vic.vehicleId;
    const gets = [
      `/vehicles/${V}/settings`, `/vehicles/${V}/settings/`, `/vehicles/${V}/./settings`, `/vehicles/x/../${V}/settings`, `//vehicles/${V}/settings`, `/VEHICLES/${V}/settings`,
      `/vehicles/%${V.charCodeAt(0).toString(16)}${V.slice(1)}/settings`,
      `/trips/${t.tripId}`, `/trips/${t.tripId}/matching`, `/trips/%${t.tripId.charCodeAt(0).toString(16)}${t.tripId.slice(1)}`, `/trips/${t.tripId}/./live`,
      `/trips?vehicleId=${atk.vehicleId}&vehicleId=${V}`, `/trips?vehicleId=${V}&vehicleId=${atk.vehicleId}`, `/trips?vehicle%49d=${V}`,
      `/regions/summary?vehicleId=${V}`, `/coverage/summary?vehicleId=${V}`, `/pair?vehicleId=${V}`, `/guest/sessions?vehicleId=${V}`, `/reports/daily?vehicleId=${V}&date=2026-11-12`,
    ];
    for (const p of gets) {
      const r = await raw(p, { headers: H });
      expect([200, 403, 404], p).toContain(r.status);
      if (r.status === 200) expect(JSON.stringify(r.body), p).not.toContain(t.tripId); // 200이어도 피해 데이터가 없다(내 것만)
    }
    for (const p of [`/vehicles/${V}/data`, `/vehicles/${V}/data/`, `//vehicles/${V}/data`, `/vehicles/${V}/./data`, `/vehicles/x/../${V}/data`, `/vehicles/${V}%2Fx/data`]) {
      const r = await raw(p, { method: 'DELETE', headers: H });
      expect([403, 404], p).toContain(r.status);
    }
    expect((await raw(`/vehicles/${V}/./settings`, { method: 'PUT', headers: { ...H }, body: JSON.stringify({ recordingPaused: true }) })).status).toBe(403);
    expect((await raw(`/trips/${t.tripId}/end`, { method: 'POST', headers: H, body: JSON.stringify({ endedAt: '2026-11-12T01:00:00Z' }) })).status).toBe(403);
    // 피해 데이터는 그대로
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE vehicle_id = ?').get(V)).toEqual({ n: 1 });
    expect(e.db.prepare('SELECT recording_paused FROM vehicle_settings WHERE vehicle_id = ?').get(V)).toBeUndefined();
    // 디코드할 수 없는 경로 구간은 400
    expect((await raw('/vehicles/%E0%A4%A/settings', { headers: H })).status).toBe(400);
  });

  it('vehicleScoped 가드: 경로 파라미터 차량 ID를 기본 거부로 검사한다(off는 통과)', async () => {
    const e = extApp({ ext: { auth: 'required' } });
    const a = (await call(e, '/vehicles/register', post('', { vin: 'KMHAAAAAAA1234567' }))).body;
    const deps = { db: e.db, getRoads: () => null, getRegions: () => null, now: () => T0, options: { auth: 'required' as const } };
    const app = new Hono().use('/x/:vehicleId/*', vehicleScoped(deps)).get('/x/:vehicleId/y', (c) => c.json({ ok: true }));
    expect((await app.request(`/x/${a.vehicleId}/y`)).status).toBe(401);
    expect((await app.request(`/x/${a.vehicleId}/y`, { headers: bearer(a.vehicleToken) })).status).toBe(200);
    expect((await app.request('/x/other/y', { headers: bearer(a.vehicleToken) })).status).toBe(403);
    const off = new Hono().use('/x/:vehicleId/*', vehicleScoped({ ...deps, options: { auth: 'off' as const } })).get('/x/:vehicleId/y', (c) => c.json({ ok: true }));
    expect((await off.request('/x/any/y')).status).toBe(200);
  });

  it('app.ts의 연결 순서 규칙: 전역 미들웨어는 체인 맨 앞, ext.routes는 T1 라우트(/trips·/map) 앞에 붙는다', () => {
    const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const iMw = src.indexOf(".use('*', ext.middleware)");
    const iHealth = src.indexOf(".get('/health'");
    const iExt = src.indexOf(".route('/', ext.routes)");
    const iTrips = src.indexOf(".route('/trips'");
    const iCoverage = src.indexOf('coverageRoutes(');
    expect(iMw).toBeGreaterThan(-1);
    expect(iMw).toBeLessThan(iHealth); // 미들웨어가 체인 맨 앞
    expect(iExt).toBeGreaterThan(iMw);
    expect(iExt).toBeLessThan(iTrips); // 기록 멈춤 훅(`/trips/:id/live`)이 T1 라우트보다 먼저
    expect(iExt).toBeLessThan(iCoverage);
  });
});

describe('legacy.mts: 인증 모드에서는 데이터가 있는 ID를 alias 출발점으로 쓸 수 없다', () => {
  it('required: off 시절에 쌓인 트립·인정 도로·시군구 기록이 있는 ID는 409, 새 UUID는 201. off에서는 기존 흐름(데이터 있는 UUID를 잇기) 유지', async () => {
    const e = extApp({ ext: { auth: 'required', inProcessLocal: false } });
    e.db.prepare("INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('legacy-trip', 'l', 'legacyVehicleId', 'd', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')").run();
    e.db.prepare("INSERT INTO driven_ways VALUES ('legacyWays', 1, 1, 'a', 'b', 't', '209901')").run();
    e.db.prepare("INSERT INTO visited_regions (vehicle_id, code, level, first_at, last_at) VALUES ('legacyRegion', '11140', 1, 'a', 'b')").run();
    e.db.prepare("INSERT INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES ('legacyEvent', '11140', 'pass', 'a', 't')").run();
    const atk = (await call(e, '/vehicles/register', post('', { vin: 'ATTACKER0000000001' }), remote)).body;
    const H = { ...JSON_H, ...bearer(atk.vehicleToken) };
    expect((await call(e, '/trips/legacy-trip', { headers: H }, remote)).status).toBe(403);
    for (const from of ['legacyVehicleId', 'legacyWays', 'legacyRegion', 'legacyEvent']) {
      const r = await call(e, '/vehicles/alias', { method: 'POST', headers: H, body: JSON.stringify({ fromVehicleId: from, toVehicleId: atk.vehicleId }) }, remote);
      expect(r.status, from).toBe(409);
      expect(r.body).toEqual({ error: 'alias_source_is_vehicle' });
    }
    expect((await call(e, '/trips/legacy-trip', { headers: H }, remote)).status).toBe(403);
    expect((await call(e, '/vehicles/alias', { method: 'POST', headers: H, body: JSON.stringify({ fromVehicleId: 'brand-new-uuid', toVehicleId: atk.vehicleId }) }, remote)).status).toBe(201);
    // off: 차량 앱이 UUID로 올린 트립을 나중에 서버 ID에 잇는 기존 흐름은 그대로
    const off = extApp();
    off.db.prepare("INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('t1', 'l', 'uuid-with-data', 'd', 'x', 'x')").run();
    expect((await call(off, '/vehicles/alias', post('', { fromVehicleId: 'uuid-with-data', toVehicleId: 'server-id' }))).status).toBe(201);
  });
});

describe('web.mts: 웹 차주(쿠키)가 /g/:code/join 하면 같은 계정으로 앉고 쿠키는 그대로다', () => {
  it('차주 쿠키로 다른 차에 게스트 참여: 새 익명 계정 없음, 세션은 차주 계정, 쿠키 재발급 없음', async () => {
    const e = extApp();
    const pc = (await call(e, '/pair/code', post('', { vehicleId: 'carA', gear: 'P' }))).body.code;
    const r1 = await e.app.request(`/p/${pc}/join`, form({ consent: 'yes' }));
    const cookie = cookieOf(r1);
    const gc = (await call(e, '/guest/code', post('', { vehicleId: 'carB', gear: 'P' }))).body.code;
    const r2 = await e.app.request(`/g/${gc}/join`, form({ consent: 'yes' }, { cookie }));
    expect(r2.status).toBe(303);
    expect(r2.headers.get('set-cookie')).toBeNull();
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'guest'").get()).toEqual({ n: 0 });
    expect(e.db.prepare('SELECT a.kind, s.vehicle_id FROM guest_sessions s JOIN accounts a ON a.id = s.account_id').all()).toEqual([{ kind: 'owner', vehicle_id: 'carB' }]);
    const me = await e.app.request('/me', { headers: { cookie } });
    expect(await me.text()).toContain('내 차의 누비 지도'); // 여전히 차주 화면
  });
});

describe('minor: 출처 검사·쿠키·프록시·로컬 판정', () => {
  it('POST 페이지는 다른 출처(Origin·Referer)면 403, 같은 출처·헤더 없음은 통과', async () => {
    const e = extApp({ ext: { publicUrl: 'https://nubi.example' } });
    const code = async () => (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code as string;
    expect((await e.app.request(`/g/${await code()}/join`, form({ consent: 'yes' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await e.app.request(`/g/${await code()}/join`, form({ consent: 'yes' }, { referer: 'https://evil.example/x' }))).status).toBe(403);
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get() as any).n).toBe(0);
    const ok = await e.app.request(`/g/${await code()}/join`, form({ consent: 'yes' }, { origin: 'https://nubi.example' }));
    expect(ok.status).toBe(303);
    const cookie = cookieOf(ok);
    for (const p of ['/me/leave', '/me/delete-session', '/me/withdraw']) expect((await e.app.request(p, form({}, { cookie, origin: 'https://evil.example' }))).status, p).toBe(403);
    expect((await e.app.request('/me/leave', form({}, { cookie, origin: 'https://nubi.example' }))).status).toBe(303);
  });

  it('?v= 읽기 전용 링크는 기존 web 쿠키를 덮어쓰지 않는다', async () => {
    const e = extApp();
    const owner = (await call(e, '/pair/claim', post('', { consent: true, code: (await call(e, '/pair/code', post('', { vehicleId: 'carA', gear: 'P' }))).body.code }))).body;
    const link = (await call(e, '/me/link', { method: 'POST', headers: bearer(owner.token) })).body.url as string;
    const g = await e.app.request(`/g/${(await call(e, '/guest/code', post('', { vehicleId: 'carB', gear: 'P' }))).body.code}/join`, form({ consent: 'yes' }));
    const webCookie = cookieOf(g);
    const ex = await e.app.request(link.replace('http://localhost', ''), { headers: { cookie: webCookie } });
    expect(ex.status).toBe(303);
    expect(ex.headers.get('set-cookie')).toBeNull();
    expect((await e.app.request('/me/leave', form({}, { cookie: webCookie }))).status).toBe(303); // 여전히 web 권한
  });

  it('https면 __Host- 접두사·Secure(공개 주소·x-forwarded-proto(신뢰 프록시)), http 개발에서는 접두사 없음, 두 이름 모두 읽는다', async () => {
    const mk = async (opts: Parameters<typeof extApp>[0] = {}, headers: Record<string, string> = {}) => {
      const e = extApp(opts);
      const code = (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code;
      return { e, res: await e.app.request(`/g/${code}/join`, form({ consent: 'yes' }, headers)) };
    };
    const a = await mk({ ext: { publicUrl: 'https://nubi.example' } });
    expect(a.res.headers.get('set-cookie')).toMatch(/^__Host-nubi_me=/);
    expect(a.res.headers.get('set-cookie')).toContain('Secure');
    expect(a.res.headers.get('set-cookie')).toContain('Path=/');
    expect((await a.e.app.request('/me', { headers: { cookie: cookieOf(a.res) } })).status).toBe(200);
    const b = await mk();
    expect(b.res.headers.get('set-cookie')).toMatch(/^nubi_me=/);
    expect(b.res.headers.get('set-cookie')).not.toContain('Secure');
    vi.stubEnv('NUBI_TRUST_PROXY', '1');
    const c = await mk({}, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.5' });
    expect(c.res.headers.get('set-cookie')).toMatch(/^__Host-nubi_me=/);
    vi.unstubAllEnvs();
    const d = await mk({}, { 'x-forwarded-proto': 'https' }); // 신뢰 설정이 없으면 헤더를 믿지 않는다
    expect(d.res.headers.get('set-cookie')).toMatch(/^nubi_me=/);
  });

  it('NUBI_TRUST_PROXY=<홉 수>: XFF의 오른쪽에서 n번째만 쓴다(맨 왼쪽 위조 무시). 미설정이면 소켓 주소, 프록시 헤더가 있으면 로컬이 아니다', async () => {
    const e = extApp({ ext: { inProcessLocal: false } });
    const del = (headers: Record<string, string>, env = peer('127.0.0.1')) => call(e, '/vehicles/v1/data', { method: 'DELETE', headers }, env);
    // 미설정: XFF가 있으면 프록시 뒤 → 로컬 아님
    expect((await del({ 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
    expect((await del({})).status).toBe(200);
    vi.stubEnv('NUBI_TRUST_PROXY', '1');
    // 1홉: 오른쪽 끝 값이 클라이언트. 맨 왼쪽을 127.0.0.1로 위조해도 소용없다
    expect((await del({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' })).status).toBe(403);
    expect((await del({ 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect((await del({ 'x-forwarded-for': '203.0.113.9, 127.0.0.1' })).status).toBe(200); // 프록시가 본 클라이언트가 로컬
    vi.stubEnv('NUBI_TRUST_PROXY', '2');
    expect((await del({ 'x-forwarded-for': '203.0.113.9, 127.0.0.1, 10.1.1.1' })).status).toBe(200); // 오른쪽에서 2번째
    expect((await del({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9, 10.1.1.1' })).status).toBe(403);
    // 시도 제한 출처 키도 같은 규칙
    const key = async (xff: string) => {
      let k = '';
      const app = new Hono().get('/k', (c) => c.text((k = clientKey(c))));
      await app.request('/k', { headers: { 'x-forwarded-for': xff } });
      return k;
    };
    vi.stubEnv('NUBI_TRUST_PROXY', '1');
    expect(await key('1.1.1.1, 2.2.2.2')).toBe('2.2.2.2');
    vi.stubEnv('NUBI_TRUST_PROXY', '2');
    expect(await key('1.1.1.1, 2.2.2.2')).toBe('1.1.1.1');
    vi.stubEnv('NUBI_TRUST_PROXY', '0');
    expect(await key('1.1.1.1, 2.2.2.2')).toBe('local');
  });

  it('이전 버전 계정 토큰(expires_at NULL)은 스키마 마이그레이션으로 생성 후 180일 만료가 채워진다', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO accounts (id, kind, created_at) VALUES ('a1', 'guest', 'x')").run();
    db.prepare("INSERT INTO auth_tokens (token_hash, kind, subject, created_at, scope, expires_at) VALUES ('h1', 'account', 'a1', '2026-01-01T00:00:00.000Z', 'api', NULL)").run();
    db.prepare("INSERT INTO auth_tokens (token_hash, kind, subject, created_at, scope, expires_at) VALUES ('h2', 'vehicle', 'v1', '2026-01-01T00:00:00.000Z', 'api', NULL)").run();
    ensureExtSchema(db);
    expect(db.prepare("SELECT expires_at FROM auth_tokens WHERE token_hash = 'h1'").get()).toEqual({ expires_at: '2026-06-30T00:00:00.000Z' });
    expect(db.prepare("SELECT expires_at FROM auth_tokens WHERE token_hash = 'h2'").get()).toEqual({ expires_at: null }); // 차량 토큰은 만료 없음
  });
});

describe('minor: 게스트 계산 캐시·공유 카드 제한 키', () => {
  const setup = async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), eastRoads(3));
    return extApp({ roadsPath, valhalla: { fetchFn: fakeValhalla(async () => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }, { way_id: 3, length: 1 }], 40)) } });
  };

  it('게스트 도로 캐시는 차량 인정 way(driven_ways)가 바뀌면 다시 계산한다', async () => {
    const e: ExtApp = await setup();
    const g = (await call(e, '/guest/claim', post('', { code: (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code, consent: true }))).body;
    await driveEast(e, 'v1', T0 + 1000, 80);
    const km = async () => (await call(e, '/me/summary', { headers: bearer(g.token) })).body.coverage.drivenKm as number;
    expect(await km()).toBe(2);
    expect(await km()).toBe(2); // 캐시 적중(같은 값)
    e.db.prepare('DELETE FROM driven_ways WHERE way_id = 2').run(); // 차량의 인정 기록이 바뀜
    expect(await km()).toBe(1);
  });

  it('시군구 계산 캐시: 같은 입력은 재사용하고, 이벤트가 늘면 갱신한다', async () => {
    const e: ExtApp = await setup();
    const g = (await call(e, '/guest/claim', post('', { code: (await call(e, '/guest/code', post('', { vehicleId: 'v1', gear: 'P' }))).body.code, consent: true }))).body;
    const tripId = await driveEast(e, 'v1', T0 + 1000, 80);
    const level = async () => ((await call(e, '/me/regions', { headers: bearer(g.token) })).body.items as any[]).find((r) => r.code === '11140').level as number;
    expect(await level()).toBe(1);
    expect(await level()).toBe(1);
    e.db.prepare("INSERT INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES ('v1', '11140', 'visit', ?, ?)").run(new Date(T0 + HOUR).toISOString(), tripId);
    expect(await level()).toBe(2);
  });

  it('공유 카드 생성 제한은 차량 ID가 아니라 토큰·출처 기준이다(차량 ID를 바꿔 우회 불가)', async () => {
    const e = extApp({ ext: { rateLimit: { max: 1, windowMs: 60_000 } } });
    expect((await call(e, '/share/cards', post('', { vehicleId: 'v-a', kind: 'national' }))).status).toBe(200);
    expect((await call(e, '/share/cards', post('', { vehicleId: 'v-b', kind: 'national' }))).status).toBe(429);
    expect((await call(e, '/share/cards', post('', { vehicleId: 'v-c', kind: 'national' }), peer('198.51.100.8'))).status).toBe(200); // 다른 출처는 따로
  });
});
