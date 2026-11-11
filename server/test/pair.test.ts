import { describe, expect, it } from 'vitest';
import { bearer, call, extApp, MIN, post } from './ext-helpers.js';

const V = 'vehicle-aaaa';

const issue = async (e: ReturnType<typeof extApp>, vehicleId = V) => (await call(e, '/pair/code', post('/pair/code', { vehicleId, gear: 'P' }))).body as { code: string; url: string; expiresAt: string };

describe('차주 연결 pair', () => {
  it('P에서만 6자리 코드(5분)와 url을 낸다. P가 아니면 403, 잘못된 본문은 400(입력을 되돌려 주지 않음)', async () => {
    const e = extApp();
    const ok = await call(e, '/pair/code', post('/pair/code', { vehicleId: V, gear: 'P' }));
    expect(ok.status).toBe(200);
    expect(ok.body.code).toMatch(/^\d{6}$/);
    expect(ok.body.url).toBe(`http://localhost/p/${ok.body.code}`);
    expect(Date.parse(ok.body.expiresAt)).toBe(e.clock.t + 5 * MIN);
    for (const gear of ['D', 'R', 'N']) {
      const r = await call(e, '/pair/code', post('/pair/code', { vehicleId: V, gear }));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'not_parked' });
    }
    for (const body of [{}, { vehicleId: V }, { vehicleId: V, gear: 'X' }, { vehicleId: '', gear: 'P' }, { vehicleId: 5, gear: 'P' }]) {
      const r = await call(e, '/pair/code', post('/pair/code', body));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid_body' });
    }
    expect((await call(e, '/pair/code', { method: 'POST', body: '{' })).status).toBe(400);
  });

  it('publicUrl 설정이 있으면 그 주소로 url을 만든다', async () => {
    const e = extApp({ ext: { publicUrl: 'https://nubi.example/' } });
    expect((await issue(e)).url).toMatch(/^https:\/\/nubi\.example\/p\/\d{6}$/);
  });

  it('claim: 계정·토큰·차량 ID를 주고, 같은 코드는 다시 못 쓴다(410), 새 코드를 내면 이전 코드는 무효(404)', async () => {
    const e = extApp();
    const a = await issue(e);
    const b = await issue(e);
    if (a.code !== b.code) expect((await call(e, '/pair/claim', post('', { consent: true, code: a.code }))).status).toBe(404); // 새 코드를 내면 이전 코드는 무효
    const claim = await call(e, '/pair/claim', post('', { code: b.code, consent: true }));
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ vehicleId: V });
    expect(typeof claim.body.accountId).toBe('string');
    expect(claim.body.token.length).toBeGreaterThanOrEqual(32);
    // 토큰은 해시로만 저장한다
    const stored = e.db.prepare('SELECT token_hash FROM auth_tokens').all() as { token_hash: string }[];
    expect(stored.map((r) => r.token_hash)).not.toContain(claim.body.token);
    expect(JSON.stringify(e.db.prepare('SELECT * FROM accounts').all())).not.toContain(claim.body.token);
    const again = await call(e, '/pair/claim', post('', { consent: true, code: b.code }));
    expect(again.status).toBe(410);
    expect(again.body).toEqual({ error: 'code_used' });
    expect((await call(e, '/pair/code', post('', { vehicleId: V, gear: 'P' }))).status).toBe(409); // 차 1대에 차주 1명
    expect((await call(e, '/pair', {})).status).toBe(400);
    expect((await call(e, `/pair?vehicleId=${V}`)).body).toMatchObject({ paired: true });
  });

  it('claim 실패: 형식 오류 400, 없는 코드 404, 만료 410, consent=false 400', async () => {
    const e = extApp();
    const a = await issue(e);
    for (const code of ['12345', 'abcdef', '1234567', 123456, null]) expect((await call(e, '/pair/claim', post('', { code }))).status).toBe(400);
    const wrong = a.code === '000000' ? '000001' : '000000';
    const nf = await call(e, '/pair/claim', post('', { consent: true, code: wrong }));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: 'code_not_found' });
    expect((await call(e, '/pair/claim', post('', { code: a.code, consent: false }))).body).toEqual({ error: 'consent_required' });
    expect((await call(e, '/pair/claim', post('', { code: a.code }))).body).toEqual({ error: 'consent_required' }); // 동의 없이는 연결하지 않는다(consent 필수)
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as any).n).toBe(0);
    e.clock.t += 5 * MIN + 1;
    const exp = await call(e, '/pair/claim', post('', { consent: true, code: a.code }));
    expect(exp.status).toBe(410);
    expect(exp.body).toEqual({ error: 'code_expired' });
  });

  it('시도 횟수 제한: 실패가 쌓이면 맞는 코드도 429, 시간이 지나면 풀린다', async () => {
    const e = extApp({ ext: { rateLimit: { max: 3, windowMs: 5 * MIN } } });
    const a = await issue(e);
    const wrong = a.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i++) expect((await call(e, '/pair/claim', post('', { consent: true, code: wrong }))).status).toBe(404);
    expect((await call(e, '/pair/claim', post('', { consent: true, code: a.code }))).status).toBe(429);
    e.clock.t += 5 * MIN + 1;
    const b = await issue(e);
    expect((await call(e, '/pair/claim', post('', { consent: true, code: b.code }))).status).toBe(200);
  });

  it('DELETE /pair: 토큰 없으면 401, 차주 토큰으로 해제(200) 후 토큰은 무효, 이미 해제는 401', async () => {
    const e = extApp();
    const claim = (await call(e, '/pair/claim', post('', { consent: true, code: (await issue(e)).code }))).body;
    expect((await call(e, '/pair', { method: 'DELETE' })).status).toBe(401);
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer('x'.repeat(40)) })).status).toBe(401);
    const del = await call(e, '/pair', { method: 'DELETE', headers: bearer(claim.token) });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, vehicleId: V });
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(claim.token) })).status).toBe(401);
    expect((await call(e, `/pair?vehicleId=${V}`)).body).toEqual({ paired: false });
    // 해제하면 다시 연결할 수 있다
    expect((await call(e, '/pair/claim', post('', { consent: true, code: (await issue(e)).code }))).status).toBe(200);
  });

  it('게스트 계정 토큰으로는 차주 연결을 해제할 수 없다(403)와 차량 토큰은 가능, 연결 없으면 404', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const reg = (await call(e, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(reg.vehicleToken) })).status).toBe(404);
    const { code } = await issue(e, reg.vehicleId);
    expect((await call(e, '/pair/claim', post('', { consent: true, code }))).status).toBe(200);
    // 게스트 계정 하나를 만들어(직접 삽입) 시도
    const t = 'g'.repeat(43);
    const { createHash } = await import('node:crypto');
    e.db.prepare("INSERT INTO accounts (id, kind, created_at) VALUES ('ga', 'guest', 'x')").run();
    e.db.prepare("INSERT INTO auth_tokens (token_hash, kind, subject, created_at) VALUES (?, 'account', 'ga', 'x')").run(createHash('sha256').update(t).digest('hex'));
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(t) })).status).toBe(403);
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(reg.vehicleToken) })).status).toBe(200);
  });
});

describe('토큰 인증(NUBI_AUTH)', () => {
  const register = async (e: ReturnType<typeof extApp>, vin = 'KMHABCDEF12345678') => (await call(e, '/vehicles/register', post('', { vin }))).body as { vehicleId: string; vehicleToken?: string };

  it('off(기본): register 응답에 토큰이 없고 인증 없이 모두 동작한다', async () => {
    const e = extApp();
    expect(Object.keys(await register(e))).toEqual(['vehicleId']);
    expect((await call(e, '/trips?vehicleId=any')).status).toBe(200);
  });

  it('required: 토큰이 없으면 401, 잘못된 토큰 401, 다른 차량 403, 자기 차량 200. 면제 경로는 토큰 없이 열린다', async () => {
    const e = extApp({ ext: { auth: 'required' } });
    const a = await register(e);
    const b = await register(e, 'KMHZZZZZZ12345678');
    expect(a.vehicleToken!.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(e.db.prepare('SELECT * FROM auth_tokens').all())).not.toContain(a.vehicleToken);
    expect((await call(e, '/health')).status).toBe(200);
    for (const path of [`/trips?vehicleId=${a.vehicleId}`, `/coverage/summary?vehicleId=${a.vehicleId}`, `/regions/summary?vehicleId=${a.vehicleId}`, '/regions/geo?bbox=1,1,2,2']) {
      expect((await call(e, path)).status).toBe(401);
    }
    expect((await call(e, `/trips?vehicleId=${a.vehicleId}`, { headers: bearer('z'.repeat(43)) })).status).toBe(401);
    expect((await call(e, `/trips?vehicleId=${b.vehicleId}`, { headers: bearer(a.vehicleToken!) })).status).toBe(403);
    expect((await call(e, `/trips?vehicleId=${a.vehicleId}`, { headers: bearer(a.vehicleToken!) })).status).toBe(200);
    // 트립 쓰기: 본문의 vehicleId와 트립 경로의 차량도 토큰 범위를 따른다
    const start = (b: string) => ({ localId: crypto.randomUUID(), vehicleId: b, driverId: b, startedAt: '2026-11-09T00:00:00Z' });
    expect((await call(e, '/trips', post('', start(a.vehicleId)))).status).toBe(401);
    expect((await call(e, '/trips', post('', start(b.vehicleId), bearer(a.vehicleToken!)))).status).toBe(403);
    const t = await call(e, '/trips', post('', start(a.vehicleId), bearer(a.vehicleToken!)));
    expect(t.status).toBe(201);
    expect((await call(e, `/trips/${t.body.tripId}`, { headers: bearer(b.vehicleToken!) })).status).toBe(403);
    expect((await call(e, `/trips/${t.body.tripId}`, { headers: bearer(a.vehicleToken!) })).status).toBe(200);
    expect((await call(e, `/trips/${t.body.tripId}/end`, post('', { endedAt: '2026-11-09T00:10:00Z' }, bearer(b.vehicleToken!)))).status).toBe(403);
    // 면제: 연결 claim(코드 오류라 404지만 401은 아니다)
    expect((await call(e, '/pair/claim', post('', { consent: true, code: '123456' }))).status).toBe(404);
    // 코드 발급은 차량 토큰 범위
    expect((await call(e, '/pair/code', post('', { vehicleId: a.vehicleId, gear: 'P' }))).status).toBe(401);
    expect((await call(e, '/pair/code', post('', { vehicleId: a.vehicleId, gear: 'P' }, bearer(b.vehicleToken!)))).status).toBe(403);
    expect((await call(e, '/pair/code', post('', { vehicleId: a.vehicleId, gear: 'P' }, bearer(a.vehicleToken!)))).status).toBe(200);
  });

  it('alias로 이은 UUID 차량 ID도 정본 차량 토큰으로 접근된다', async () => {
    const e = extApp({ ext: { auth: 'required' } });
    const a = await register(e);
    const h = bearer(a.vehicleToken!);
    expect((await call(e, `/trips?vehicleId=uuid-1`, { headers: h })).status).toBe(403);
    expect((await call(e, '/vehicles/alias', post('', { fromVehicleId: 'uuid-1', toVehicleId: a.vehicleId }, h))).status).toBe(201);
    expect((await call(e, `/trips?vehicleId=uuid-1`, { headers: h })).status).toBe(200);
  });

  it('optional: 토큰이 없으면 통과, 있으면 검증(잘못되면 401, 다른 차량 403)', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const a = await register(e);
    const b = await register(e, 'KMHZZZZZZ12345678');
    expect((await call(e, `/trips?vehicleId=${a.vehicleId}`)).status).toBe(200);
    expect((await call(e, `/trips?vehicleId=${a.vehicleId}`, { headers: bearer('q'.repeat(43)) })).status).toBe(401);
    expect((await call(e, `/trips?vehicleId=${a.vehicleId}`, { headers: bearer(b.vehicleToken!) })).status).toBe(403);
  });

  it('차주 계정 토큰은 자기 차량만 접근한다', async () => {
    const e = extApp({ ext: { auth: 'required' } });
    const a = await register(e);
    const claim = (await call(e, '/pair/claim', post('', { consent: true, code: (await call(e, '/pair/code', post('', { vehicleId: a.vehicleId, gear: 'P' }, bearer(a.vehicleToken!)))).body.code }))).body;
    expect((await call(e, `/coverage/summary?vehicleId=${a.vehicleId}`, { headers: bearer(claim.token) })).status).toBe(200);
    expect((await call(e, '/coverage/summary?vehicleId=other', { headers: bearer(claim.token) })).status).toBe(403);
  });

  it('vehicleToken은 차량당 최대 5개만 남는다', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const tokens: string[] = [];
    for (let i = 0; i < 7; i++) {
      e.clock.t += 1000;
      tokens.push((await register(e)).vehicleToken!);
    }
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get() as { n: number }).n).toBe(5);
    expect((await call(e, '/pair', { method: 'DELETE', headers: bearer(tokens[0]!) })).status).toBe(401);
  });
});
