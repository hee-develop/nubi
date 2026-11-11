import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeValhalla, makePoints, makeRoadsDb, matchedResponse, type SynthWay } from './helpers.js';
import { call, extApp, MIN, post, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const V = 'veh-page-0001';
const W = (id: number, lengthM: number, roadKey: string, at: [number, number]): SynthWay => ({ id, roadKey, lengthM, highway: 'residential', at });

const setup = async (extra: Parameters<typeof extApp>[0] = {}) => {
  const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 1000, 'nm:a', [126.978, 37.5665]), W(2, 1000, 'nm:b', [127.0, 37.57])]);
  return extApp({ roadsPath, valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }], 40)) }, ...extra });
};
const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const guestCode = async (e: ExtApp) => (await call(e, '/guest/code', post('', { vehicleId: V, gear: 'P' }))).body.code as string;
const pairCode = async (e: ExtApp) => (await call(e, '/pair/code', post('', { vehicleId: V, gear: 'P' }))).body.code as string;
const drive = async (e: ExtApp, offsetMs = 0) => {
  const pts = makePoints(40, 25, 37.5665, 126.978, 12).map((p) => ({ ...p, ts: new Date(Date.parse(p.ts) + offsetMs).toISOString() }));
  const start = await call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId: V, driverId: V, startedAt: pts[0]!.ts }));
  const id = start.body.tripId as string;
  await call(e, `/trips/${id}/points`, post('', { points: pts }));
  await call(e, `/trips/${id}/end`, post('', { endedAt: pts.at(-1)!.ts }));
  await e.app.matching.idle();
};
const tokenOf = (res: Response) => new URL(res.headers.get('location')!, 'http://localhost').searchParams.get('t')!;

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
    // 사용된 코드
    const j = await e.app.request(`/g/${code}/join`, form({ consent: 'yes' }));
    expect(j.status).toBe(303);
    const used = await call(e, `/g/${code}`);
    expect(used.status).toBe(410);
    expect(used.text).toContain('이미 쓴 코드');
    // 만료
    const c2 = await guestCode(e);
    e.clock.t += 5 * MIN + 1;
    const exp = await call(e, `/g/${c2}`);
    expect(exp.status).toBe(410);
    expect(exp.text).toContain('만료');
  });

  it('동의 없이 참여하면 400(세션 안 열림), 동의하면 303으로 /me 링크, 기록은 같이 탄 동안만', async () => {
    const e = await setup();
    const code = await guestCode(e);
    const no = await call(e, `/g/${code}/join`, form({ nickname: '지수' }));
    expect(no.status).toBe(400);
    expect(no.text).toContain('동의가 필요');
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get() as any).n).toBe(0);
    const ok = await e.app.request(`/g/${code}/join`, form({ consent: 'yes', nickname: '지수' }));
    expect(ok.status).toBe(303);
    const token = tokenOf(ok);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await call(e, '/guest/sessions?vehicleId=' + V)).body).toEqual({ active: 1 });
    await drive(e);
    const me = await call(e, `/me?t=${token}`);
    expect(me.status).toBe(200);
    expect(me.text).toContain('같이 탄 길의 누비 지도');
    expect(me.text).toContain('지금 같이 타고 있어요');
    expect(me.text).toContain('<svg');
    expect(me.text).toMatch(/<b>2<\/b><span>달린 도로 km/);
    expect(me.text).toContain('서울 종로구');
    // 비식별: 좌표 원본·차량 ID·way id 없음
    expect(me.text).not.toMatch(/\d{2,3}\.\d{4,}/);
    for (const s of [V, 'way_id', 'wayId']) expect(me.text).not.toContain(s);
    expect(me.res.headers.get('referrer-policy')).toBe('no-referrer');
    // 내리기
    const leave = await e.app.request('/me/leave', form({ t: token }));
    expect(leave.status).toBe(303);
    expect((await call(e, '/guest/sessions?vehicleId=' + V)).body).toEqual({ active: 0 });
    expect((await call(e, `/me?t=${token}`)).text).toContain('내린 상태');
    // 기록 지우기
    const del = await e.app.request('/me/delete-session', form({ t: token }));
    expect(del.status).toBe(303);
    expect((await call(e, `/me?t=${token}`)).text).toMatch(/<b>0<\/b><span>달린 도로 km/);
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
    await drive(e);
    const me = await call(e, `/me?t=${tokenOf(ok)}`);
    expect(me.text).toContain('내 차의 누비 지도');
    expect(me.text).toMatch(/<b>2<\/b><span>달린 도로 km/);
    expect(me.text).not.toContain('내리기');
    expect((await call(e, `/p/${code}`)).status).toBe(410);
    // 다른 코드로 또 연결 → 이미 연결된 차
    e.db.prepare("INSERT INTO link_codes (code, kind, vehicle_id, created_at, expires_at) VALUES ('444444', 'pair', ?, 'x', ?)").run(V, new Date(e.clock.t + MIN).toISOString());
    expect((await call(e, '/p/444444/join', form({ consent: 'yes' }))).status).toBe(409);
    // 게스트 코드는 /p에서 404
    expect((await call(e, `/p/${await guestCode(e)}`)).status).toBe(404);
  });
});

describe('/me', () => {
  it('토큰이 없거나 틀리면 401 페이지(토큰 미반사), 차량 토큰은 쓸 수 없다', async () => {
    const e = await setup({ ext: { auth: 'optional' } });
    for (const t of ['', 'abc', 'x'.repeat(43), '<script>alert(1)</script>']) {
      const r = await call(e, `/me?t=${encodeURIComponent(t)}`);
      expect(r.status).toBe(401);
      expect(r.text).not.toContain('alert(1)');
    }
    expect((await call(e, '/me')).status).toBe(401);
    const reg = (await call(e, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    expect((await call(e, `/me?t=${reg.vehicleToken}`)).status).toBe(401);
    expect((await e.app.request('/me/leave', form({ t: 'nope' }))).status).toBe(401);
    expect((await e.app.request('/me/delete-session', form({}))).status).toBe(401);
  });

  it('지도 데이터가 없어도(도로·지역 DB 없음) 페이지는 열린다', async () => {
    const e = extApp({ roadsPath: null, regionsPath: null });
    const code = await guestCode(e);
    const ok = await e.app.request(`/g/${code}/join`, form({ consent: 'yes' }));
    const me = await call(e, `/me?t=${tokenOf(ok)}`);
    expect(me.status).toBe(200);
    expect(me.text).toContain('지도 데이터를 아직 쓸 수 없어요');
  });
});

describe('/s/:id 공유 카드 페이지', () => {
  it('카드 이미지·줄 글·OG 태그, 없는 id는 404, 출발·도착·날짜 없음', async () => {
    const e = await setup({ ext: { publicUrl: 'https://nubi.example', installUrl: 'https://nubi.example/install' } });
    await drive(e);
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
