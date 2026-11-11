import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeValhalla, makeRoadsDb, matchedResponse } from './helpers.js';
import { bearer, call, driveEast, eastRoads, extApp, HOUR, MIN, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const V = 'veh-page-0001';

const setup = async (extra: Parameters<typeof extApp>[0] = {}) => {
  const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), eastRoads(2));
  return extApp({ roadsPath, valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }], 40)) }, ...extra });
};
const form = (fields: Record<string, string>, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const guestCode = async (e: ExtApp) => (await call(e, '/guest/code', post('', { vehicleId: V, gear: 'P' }))).body.code as string;
const pairCode = async (e: ExtApp) => (await call(e, '/pair/code', post('', { vehicleId: V, gear: 'P' }))).body.code as string;
/** 응답의 Set-Cookie에서 `이름=값`만. */
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

describe('웹 페이지 공통', () => {
  it('보안 헤더(no-store·no-referrer·CSP)와 모바일 viewport, 스크립트 없음', async () => {
    const e = await setup();
    const r = await call(e, `/g/${await guestCode(e)}`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toContain('text/html');
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.text).toContain('width=device-width');
    expect(r.text).not.toMatch(/<script|<iframe|https?:\/\/(?!www\.w3\.org)/);
    expect(r.text).toContain('#0f141b');
    expect(r.text).toContain('#f59e0b');
  });
});

describe('/g/:code 게스트', () => {
  it('유효한 코드면 동의 체크박스·참여 폼(차량 정보 없음), 없는 코드 404·만료 410·사용됨 410 페이지', async () => {
    const e = await setup();
    const code = await guestCode(e);
    const r = await call(e, `/g/${code}`);
    expect(r.text).toContain('type="checkbox"');
    expect(r.text).toContain(`action="/g/${code}/join"`);
    expect(r.text).toContain('required');
    expect(r.text).not.toContain(V);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await call(e, `/g/${wrong}`)).status).toBe(404);
    expect((await call(e, '/g/abc')).status).toBe(404);
    expect((await call(e, '/g/1234567')).status).toBe(404);
    const j = await e.app.request(`/g/${code}/join`, form({ consent: 'yes' }));
    expect(j.status).toBe(303);
    const used = await call(e, `/g/${code}`);
    expect(used.status).toBe(410);
    expect(used.text).toContain('이미 쓴 코드');
    const c2 = await guestCode(e);
    e.clock.t += 5 * MIN + 1;
    const exp = await call(e, `/g/${c2}`);
    expect(exp.status).toBe(410);
    expect(exp.text).toContain('만료');
  });

  it('동의 없이 참여하면 400(세션 안 열림), 동의하면 303 /me + HttpOnly 쿠키(토큰은 URL에 없음), 기록은 같이 탄 동안만', async () => {
    const e = await setup();
    const code = await guestCode(e);
    const no = await call(e, `/g/${code}/join`, form({ nickname: '지수' }));
    expect(no.status).toBe(400);
    expect(no.text).toContain('동의가 필요');
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get() as any).n).toBe(0);
    const ok = await e.app.request(`/g/${code}/join`, form({ consent: 'yes', nickname: '지수' }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/me'); // 토큰이 주소에 없다
    const setCookie = ok.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^nubi_me=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // http 주소라 Secure는 붙이지 않는다
    const cookie = cookieOf(ok);
    expect((await call(e, '/guest/sessions?vehicleId=' + V)).body).toEqual({ active: 1 });
    await driveEast(e, V, T0 + 1000, 80);
    const me = await call(e, '/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.text).toContain('같이 탄 길의 누비 지도');
    expect(me.text).toContain('지금 같이 타고 있어요');
    expect(me.text).toContain('<svg');
    expect(me.text).toMatch(/<b>2<\/b><span>달린 도로 km/);
    expect(me.text).toContain('서울 중구');
    expect(me.text).not.toMatch(/\d{2,3}\.\d{4,}/);
    for (const s of [V, 'way_id', 'wayId', cookie.split('=')[1]!]) expect(me.text).not.toContain(s);
    expect(me.res.headers.get('referrer-policy')).toBe('no-referrer');
    // 쿠키 없이는 열리지 않는다
    expect((await call(e, '/me')).status).toBe(401);
    // 내리기
    expect((await e.app.request('/me/leave', form({}, cookie))).status).toBe(303);
    expect((await call(e, '/guest/sessions?vehicleId=' + V)).body).toEqual({ active: 0 });
    expect((await call(e, '/me', { headers: { cookie } })).text).toContain('내린 상태');
    // 기록 지우기
    expect((await e.app.request('/me/delete-session', form({}, cookie))).status).toBe(303);
    expect((await call(e, '/me', { headers: { cookie } })).text).toMatch(/<b>0<\/b><span>달린 도로 km/);
  });

  it('같은 브라우저(쿠키)로 다시 참여하면 같은 게스트 계정을 쓴다, 열린 세션이 있으면 409', async () => {
    const e = await setup();
    const first = await e.app.request(`/g/${await guestCode(e)}/join`, form({ consent: 'yes' }));
    const cookie = cookieOf(first);
    await e.app.request('/me/leave', form({}, cookie));
    const second = await e.app.request(`/g/${await guestCode(e)}/join`, form({ consent: 'yes' }, cookie));
    expect(second.status).toBe(303);
    expect(second.headers.get('set-cookie')).toBeNull(); // 새 쿠키 없이 기존 계정 재사용
    expect((e.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'guest'").get() as any).n).toBe(1);
    expect((e.db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM guest_sessions').get() as any).n).toBe(1);
    // 아직 앉아 있는데 또 → 409
    const dup = await call(e, `/g/${await guestCode(e)}/join`, form({ consent: 'yes' }, cookie));
    expect(dup.status).toBe(409);
    expect(dup.text).toContain('이미 다른 차');
  });

  it('4명이 차면 409 페이지, 같은 출처의 실패가 쌓이면 429 페이지', async () => {
    const e = await setup({ ext: { rateLimit: { max: 3, windowMs: 5 * MIN } } });
    for (let i = 0; i < 4; i++) await e.app.request(`/g/${await guestCode(e)}/join`, form({ consent: 'yes' }));
    e.db.prepare("INSERT INTO link_codes (code, kind, vehicle_id, created_at, expires_at) VALUES ('555555', 'guest', ?, 'x', ?)").run(V, new Date(e.clock.t + MIN).toISOString());
    const full = await call(e, '/g/555555/join', form({ consent: 'yes' }));
    expect(full.status).toBe(409);
    for (let i = 0; i < 3; i++) await call(e, '/g/999999');
    expect((await call(e, '/g/999999')).status).toBe(429);
    expect((await call(e, '/g/555555')).status).toBe(429); // 맞는 코드도 막는다
  });

  it('탈퇴(/me/withdraw): 세션·닉네임·계정이 지워지고 쿠키는 더 쓸 수 없다', async () => {
    const e = await setup();
    const ok = await e.app.request(`/g/${await guestCode(e)}/join`, form({ consent: 'yes', nickname: '지수' }));
    const cookie = cookieOf(ok);
    const w = await call(e, '/me/withdraw', form({}, cookie));
    expect(w.status).toBe(200);
    expect(w.text).toContain('탈퇴했어요');
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get() as any).n).toBe(0);
    expect((await call(e, '/me', { headers: { cookie } })).status).toBe(401);
  });
});

describe('/p/:code 차주 연결', () => {
  it('동의 폼 → 연결 → /me(내 차 지도), 이미 연결된 차는 409, 동의 없으면 400', async () => {
    const e = await setup();
    const code = await pairCode(e);
    const p = await call(e, `/p/${code}`);
    expect(p.status).toBe(200);
    expect(p.text).toContain('내 차를 누비에 연결');
    expect(p.text).toContain('type="checkbox"');
    expect((await call(e, `/p/${code}/join`, form({}))).status).toBe(400);
    const ok = await e.app.request(`/p/${code}/join`, form({ consent: 'yes' }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/me');
    const cookie = cookieOf(ok);
    // 웹 연결은 API 토큰을 만들지 않는다(쿠키 토큰만)
    expect((e.db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE scope = 'api'").get() as any).n).toBe(0);
    await driveEast(e, V, T0 + 1000, 80);
    const me = await call(e, '/me', { headers: { cookie } });
    expect(me.text).toContain('내 차의 누비 지도');
    expect(me.text).toMatch(/<b>2<\/b><span>달린 도로 km/);
    expect(me.text).not.toContain('내리기');
    expect((await call(e, `/p/${code}`)).status).toBe(410);
    e.db.prepare("INSERT INTO link_codes (code, kind, vehicle_id, created_at, expires_at) VALUES ('444444', 'pair', ?, 'x', ?)").run(V, new Date(e.clock.t + MIN).toISOString());
    expect((await call(e, '/p/444444/join', form({ consent: 'yes' }))).status).toBe(409);
    expect((await call(e, `/p/${await guestCode(e)}`)).status).toBe(404);
  });
});

describe('/me 인증: 쿠키(7일)·24시간 읽기 전용 링크', () => {
  it('쿠키·링크가 없거나 틀리면 401(입력 미반사), 옛 ?t= 토큰 방식은 없다, 차량 토큰은 쓸 수 없다', async () => {
    const e = await setup({ ext: { auth: 'optional' } });
    for (const v of ['', 'abc', 'x'.repeat(43), '<script>alert(1)</script>']) {
      const r = await call(e, `/me?v=${encodeURIComponent(v)}`);
      expect(r.status).toBe(401);
      expect(r.text).not.toContain('alert(1)');
    }
    expect((await call(e, '/me')).status).toBe(401);
    expect((await call(e, '/me?t=whatever')).status).toBe(401);
    const reg = (await call(e, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    expect((await call(e, '/me', { headers: { cookie: `nubi_me=${reg.vehicleToken}` } })).status).toBe(401);
    expect((await call(e, '/me?v=' + reg.vehicleToken)).status).toBe(401);
    expect((await e.app.request('/me/leave', form({}, 'nubi_me=nope'))).status).toBe(401);
    expect((await e.app.request('/me/delete-session', form({}))).status).toBe(401);
  });

  it('POST /me/link: 24시간 읽기 전용 링크(?v=)는 쿠키로 바꿔 심고 주소에서 지우며, 내리기·삭제는 못 한다. 24시간 뒤 만료', async () => {
    const e = await setup();
    const owner = (await call(e, '/pair/claim', post('', { consent: true, code: await pairCode(e) }))).body;
    expect((await call(e, '/me/link', { method: 'POST' })).status).toBe(401);
    const link = (await call(e, '/me/link', { method: 'POST', headers: bearer(owner.token) })).body;
    expect(link.url).toMatch(/^http:\/\/localhost\/me\?v=[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(link.expiresAt)).toBe(e.clock.t + 24 * HOUR);
    const ex = await e.app.request(link.url.replace('http://localhost', ''));
    expect(ex.status).toBe(303);
    expect(ex.headers.get('location')).toBe('/me');
    const cookie = cookieOf(ex);
    expect((await call(e, '/me', { headers: { cookie } })).status).toBe(200);
    expect((await e.app.request('/me/leave', form({}, cookie))).status).toBe(401); // 읽기 전용
    expect((await e.app.request('/me/delete-session', form({}, cookie))).status).toBe(401);
    // view 토큰은 API로도 못 쓴다
    expect((await call(e, '/me/summary', { headers: bearer(cookie.split('=')[1]!) })).status).toBe(401);
    e.clock.t += 24 * HOUR + 1;
    expect((await call(e, '/me', { headers: { cookie } })).status).toBe(401);
    expect((await e.app.request(link.url.replace('http://localhost', ''))).status).toBe(401);
  });

  it('웹 쿠키는 7일 뒤 만료된다. https 공개 주소면 Secure 속성이 붙는다', async () => {
    const e = await setup({ ext: { publicUrl: 'https://nubi.example' } });
    const ok = await e.app.request(`/g/${await guestCode(e)}/join`, form({ consent: 'yes' }));
    expect(ok.headers.get('set-cookie')).toContain('Secure');
    const cookie = cookieOf(ok);
    e.clock.t += 6 * 24 * HOUR;
    expect((await call(e, '/me', { headers: { cookie } })).status).toBe(200);
    e.clock.t += 2 * 24 * HOUR;
    expect((await call(e, '/me', { headers: { cookie } })).status).toBe(401);
  });

  it('지도 데이터가 없어도(도로·지역 DB 없음) 페이지는 열린다', async () => {
    const e = extApp({ roadsPath: null, regionsPath: null });
    const ok = await e.app.request(`/g/${await guestCode(e)}/join`, form({ consent: 'yes' }));
    const me = await call(e, '/me', { headers: { cookie: cookieOf(ok) } });
    expect(me.status).toBe(200);
    expect(me.text).toContain('지도 데이터를 아직 쓸 수 없어요');
  });
});

describe('/s/:id 공유 카드 페이지', () => {
  it('PNG 이미지·줄 글·OG 태그, 없는 id는 404, 출발·도착·날짜 없음', async () => {
    const e = await setup({ ext: { publicUrl: 'https://nubi.example', installUrl: 'https://nubi.example/install' } });
    await driveEast(e, V, T0 + 1000, 80);
    const card = (await call(e, '/share/cards', post('', { vehicleId: V, kind: 'national' }))).body;
    expect(card.url).toBe(`https://nubi.example/s/${card.id}`);
    const r = await call(e, `/s/${card.id}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`src="/share/cards/${card.id}.png"`);
    expect(r.text).toContain(`<meta property="og:image" content="https://nubi.example/share/cards/${card.id}.png">`);
    expect(r.text).toContain('전국 완료율');
    expect(r.text).toContain('href="https://nubi.example/install"');
    expect(r.text).toContain('© OpenStreetMap contributors');
    expect(r.text).not.toContain(V);
    expect(r.text).not.toMatch(/\d{2,3}\.\d{4,}|20\d\d-\d\d/);
    expect((await call(e, '/s/nonexistent1234')).status).toBe(404);
    expect((await call(e, '/s/x')).status).toBe(404);
  });
});
