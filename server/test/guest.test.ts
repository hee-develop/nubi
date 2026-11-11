import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeValhalla, makePoints, makeRoadsDb, matchedResponse, type SynthWay } from './helpers.js';
import { bearer, call, extApp, HOUR, MIN, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const V = 'veh-owner';

const guestCode = async (e: ExtApp, vehicleId = V) => call(e, '/guest/code', post('', { vehicleId, gear: 'P' }));
const claim = async (e: ExtApp, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  call(e, '/guest/claim', post('', { code, consent: true, ...extra }, headers));
const sit = async (e: ExtApp, vehicleId = V, headers: Record<string, string> = {}) => {
  const c = await guestCode(e, vehicleId);
  return claim(e, c.body.code, {}, headers);
};
const active = async (e: ExtApp, vehicleId = V) => (await call(e, `/guest/sessions?vehicleId=${vehicleId}`)).body.active as number;

/** 트립을 직접 넣는다(매칭 없이). */
const addTrip = (e: ExtApp, vehicleId: string, startMs: number, endMs: number | null, lat = 37.5665, lon = 126.978) => {
  const id = crypto.randomUUID();
  e.db.prepare('INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, vehicleId, vehicleId, new Date(startMs).toISOString(), endMs ? new Date(endMs).toISOString() : null, 'x');
  e.db.prepare('INSERT INTO trip_points (trip_id, seq, ts, lat, lon) VALUES (?, 0, ?, ?, ?)').run(id, new Date(startMs).toISOString(), lat, lon);
  return id;
};

describe('게스트 코드·세션', () => {
  it('코드는 P에서만(403), 6자리+5분, 본문 오류 400(입력 미반사)', async () => {
    const e = extApp();
    const ok = await guestCode(e);
    expect(ok.status).toBe(200);
    expect(ok.body.code).toMatch(/^\d{6}$/);
    expect(ok.body.url).toBe(`http://localhost/g/${ok.body.code}`);
    expect(Date.parse(ok.body.expiresAt)).toBe(T0 + 5 * MIN);
    expect((await call(e, '/guest/code', post('', { vehicleId: V, gear: 'D' }))).status).toBe(403);
    const bad = await call(e, '/guest/code', post('', { vehicleId: V }));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_body' });
  });

  it('claim: 동의 없으면 400(세션 안 열림), 동의하면 sessionId·token, 코드는 1회용(410), 없는 코드 404, 만료 410', async () => {
    const e = extApp();
    const c = await guestCode(e);
    for (const body of [{ code: c.body.code }, { code: c.body.code, consent: false }, { code: c.body.code, consent: 'yes' }]) {
      const r = await call(e, '/guest/claim', post('', body));
      expect(r.status).toBe(400);
    }
    expect((await call(e, '/guest/claim', post('', { code: c.body.code, consent: false }))).body).toEqual({ error: 'consent_required' });
    expect(await active(e)).toBe(0);
    const ok = await claim(e, c.body.code, { nickname: '지수' });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.sessionId).toBe('string');
    expect(ok.body.token.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(e.db.prepare('SELECT * FROM auth_tokens').all())).not.toContain(ok.body.token);
    expect(await active(e)).toBe(1);
    expect((await claim(e, c.body.code)).status).toBe(410);
    const wrong = c.body.code === '000000' ? '111111' : '000000';
    expect((await claim(e, wrong)).status).toBe(404);
    const c2 = await guestCode(e);
    e.clock.t += 5 * MIN + 1;
    const exp = await claim(e, c2.body.code);
    expect(exp.status).toBe(410);
    expect(exp.body).toEqual({ error: 'code_expired' });
    expect((await claim(e, '12ab56')).status).toBe(400);
    expect((await claim(e, 'x', { nickname: 'a'.repeat(30) })).status).toBe(400);
  });

  it('차주 연결 코드는 게스트 claim에 쓸 수 없고 그 반대도 같다(404)', async () => {
    const e = extApp();
    const pair = (await call(e, '/pair/code', post('', { vehicleId: V, gear: 'P' }))).body;
    expect((await claim(e, pair.code)).status).toBe(404);
    const g = (await guestCode(e)).body;
    expect((await call(e, '/pair/claim', post('', { code: g.code }))).status).toBe(404);
  });

  it('차량당 동시 4명 상한: 5번째는 409(코드 발급도 409)', async () => {
    const e = extApp();
    for (let i = 0; i < 4; i++) expect((await sit(e)).status).toBe(200);
    expect(await active(e)).toBe(4);
    const g = await guestCode(e);
    expect(g.status).toBe(409);
    expect(g.body).toEqual({ error: 'guest_limit' });
    // 코드는 이미 있었다고 해도 claim에서 막는다
    e.db.prepare("INSERT INTO link_codes (code, kind, vehicle_id, created_at, expires_at) VALUES ('999999', 'guest', ?, 'x', ?)").run(V, new Date(T0 + MIN).toISOString());
    expect((await claim(e, '999999')).status).toBe(409);
    // 다른 차량은 따로 센다
    expect((await sit(e, 'other')).status).toBe(200);
  });

  it('종료: 게스트 본인이 내리기(200, 다시 하면 alreadyEnded), 남의 세션은 못 끝낸다(403), 없는 세션 404', async () => {
    const e = extApp();
    const a = (await sit(e)).body;
    const b = (await sit(e)).body;
    expect((await call(e, `/guest/${a.sessionId}/end`, { method: 'POST' })).status).toBe(401);
    expect((await call(e, `/guest/${a.sessionId}/end`, { method: 'POST', headers: bearer(b.token) })).status).toBe(403);
    expect((await call(e, `/guest/${a.sessionId}/end`, post('', { vehicleId: 'other' }))).status).toBe(403);
    expect((await call(e, '/guest/nope/end', { method: 'POST', headers: bearer(a.token) })).status).toBe(404);
    const end = await call(e, `/guest/${a.sessionId}/end`, { method: 'POST', headers: bearer(a.token) });
    expect(end.status).toBe(200);
    expect(end.body).toMatchObject({ ok: true, alreadyEnded: false });
    expect(await active(e)).toBe(1);
    expect((await call(e, `/guest/${a.sessionId}/end`, { method: 'POST', headers: bearer(a.token) })).body).toMatchObject({ alreadyEnded: true });
    // 차(차량 ID)가 끝낸다
    const byCar = await call(e, `/guest/${b.sessionId}/end`, post('', { vehicleId: V }));
    expect(byCar.status).toBe(200);
    expect(await active(e)).toBe(0);
  });

  it('차주 모두 내리기(end-all)와 인원만 보이는 sessions(게스트 정보 없음)', async () => {
    const e = extApp();
    await sit(e);
    await sit(e);
    const s = await call(e, `/guest/sessions?vehicleId=${V}`);
    expect(s.body).toEqual({ active: 2 });
    expect((await call(e, '/guest/sessions')).status).toBe(400);
    expect((await call(e, '/guest/end-all', post('', {}))).status).toBe(400);
    const r = await call(e, '/guest/end-all', post('', { vehicleId: V }));
    expect(r.body).toEqual({ ok: true, ended: 2 });
    expect(await active(e)).toBe(0);
    expect((await call(e, '/guest/end-all', post('', { vehicleId: V }))).body).toEqual({ ok: true, ended: 0 });
  });

  it('마지막 트립 종료 후 12시간이 지나면 세션이 끝난다(트립 없으면 세션 시작 기준), 트립이 있으면 그 종료 기준', async () => {
    const e = extApp();
    await sit(e);
    e.clock.t = T0 + 11 * HOUR;
    expect(await active(e)).toBe(1);
    e.clock.t = T0 + 12 * HOUR + 1;
    expect(await active(e)).toBe(0);
    const row = e.db.prepare('SELECT ended_at, end_reason FROM guest_sessions').get() as any;
    expect(row).toEqual({ ended_at: new Date(T0 + 12 * HOUR).toISOString(), end_reason: 'idle' });
    // 트립이 있으면 종료 시각 + 12시간
    e.clock.t = T0 + 20 * HOUR;
    await sit(e);
    addTrip(e, V, T0 + 20 * HOUR + MIN, T0 + 21 * HOUR);
    e.clock.t = T0 + 32 * HOUR;
    expect(await active(e)).toBe(1);
    e.clock.t = T0 + 33 * HOUR + 1;
    expect(await active(e)).toBe(0);
    // 진행 중인 트립(종료 안 됨)은 마지막 점 시각 기준으로 활동 중이다
    e.clock.t = T0 + 40 * HOUR;
    await sit(e);
    addTrip(e, V, T0 + 40 * HOUR + MIN, null);
    e.clock.t = T0 + 51 * HOUR;
    expect(await active(e)).toBe(1);
  });

  it('새 트립이 12시간 뒤에 시작되면 그 트립은 이전 세션에 귀속되지 않는다(시작 때 세션을 마무리)', async () => {
    const e = extApp();
    await sit(e);
    const start = T0 + 13 * HOUR;
    e.clock.t = start;
    const r = await call(e, '/trips', post('', { localId: 'l1', vehicleId: V, driverId: V, startedAt: new Date(start).toISOString() }));
    expect(r.status).toBe(201);
    const row = e.db.prepare('SELECT ended_at, end_reason FROM guest_sessions').get() as any;
    expect(row.end_reason).toBe('idle');
    expect(row.ended_at).toBe(new Date(T0 + 12 * HOUR).toISOString());
  });

  it('게스트가 자기 차(차주 계정)에서 트립을 시작하면 그 게스트 세션이 끝난다. 다른 차량 트립은 영향 없음', async () => {
    const e = extApp();
    // 차주 계정(자기 차 'car-mine')이 V의 게스트로 앉는다
    const mine = (await call(e, '/pair/claim', post('', { code: (await call(e, '/pair/code', post('', { vehicleId: 'car-mine', gear: 'P' }))).body.code }))).body;
    const s = await sit(e, V, bearer(mine.token));
    expect(s.status).toBe(200);
    expect(s.body.token).toBe(mine.token);
    expect(await active(e)).toBe(1);
    // 게스트 세션 중에 또 앉으려 하면(다른 차) 먼저 시작한 세션만 인정: 409
    const dup = await sit(e, 'third-car', bearer(mine.token));
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: 'already_in_session' });
    // 남의 차 트립 시작은 영향 없음
    e.clock.t += HOUR;
    await call(e, '/trips', post('', { localId: 'x', vehicleId: 'third-car', driverId: 'x', startedAt: new Date(e.clock.t).toISOString() }));
    expect(await active(e)).toBe(1);
    // 자기 차 트립 시작
    e.clock.t += HOUR;
    await call(e, '/trips', post('', { localId: 'y', vehicleId: 'car-mine', driverId: 'x', startedAt: new Date(e.clock.t).toISOString() }));
    expect(await active(e)).toBe(0);
    expect(e.db.prepare('SELECT end_reason FROM guest_sessions').get()).toEqual({ end_reason: 'own_trip' });
    // 자기 차 코드로는 앉을 수 없다
    const code = await guestCode(e, 'car-mine');
    expect((await claim(e, code.body.code, {}, bearer(mine.token))).status).toBe(409);
  });

  it('잘못된 토큰(401)과 차량 토큰으로 claim(403)', async () => {
    const e = extApp({ ext: { auth: 'optional' } });
    const c = await guestCode(e);
    expect((await claim(e, c.body.code, {}, bearer('q'.repeat(43)))).status).toBe(401);
    const reg = (await call(e, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    expect((await claim(e, c.body.code, {}, bearer(reg.vehicleToken))).status).toBe(403);
  });

  it('시도 제한: 실패가 쌓이면 429', async () => {
    const e = extApp({ ext: { rateLimit: { max: 2, windowMs: 5 * MIN } } });
    const c = await guestCode(e);
    const wrong = c.body.code === '000000' ? '111111' : '000000';
    expect((await claim(e, wrong)).status).toBe(404);
    expect((await claim(e, wrong)).status).toBe(404);
    expect((await claim(e, c.body.code)).status).toBe(429);
  });

  it('세션 데이터 삭제: 본인만(403), 도로·시군구 기록이 사라지고 다시 지울 수 없다(404)', async () => {
    const e = extApp();
    const a = (await sit(e)).body;
    const b = (await sit(e)).body;
    e.db.prepare("INSERT INTO driven_ways VALUES (?, 1, 1, ?, ?, 't', '209901')").run(V, new Date(T0 + MIN).toISOString(), new Date(T0 + 2 * MIN).toISOString());
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM guest_ways').get() as any).n).toBe(2);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE' })).status).toBe(401);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(b.token) })).status).toBe(403);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(a.token) })).status).toBe(200);
    expect(e.db.prepare('SELECT session_id FROM guest_ways').all()).toEqual([{ session_id: b.sessionId }]);
    expect(await active(e)).toBe(1);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(a.token) })).status).toBe(404);
  });
});

describe('게스트 기록 인정(/me)', () => {
  const W = (id: number, lengthM: number, roadKey: string, at: [number, number]): SynthWay => ({ id, roadKey, lengthM, highway: 'residential', at });
  const setup = async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 1000, 'nm:a', [126.978, 37.5665]), W(2, 1000, 'nm:b', [127.0, 37.57])]);
    const e = extApp({
      roadsPath,
      valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }], 40)) },
    });
    return e;
  };
  /** 시각을 [offsetMs]만큼 민 점으로 트립 하나를 매칭까지 돌린다. */
  const drive = async (e: ExtApp, vehicleId: string, offsetMs: number) => {
    const pts = makePoints(40, 25, 37.5665, 126.978, 12).map((p) => ({ ...p, ts: new Date(Date.parse(p.ts) + offsetMs).toISOString() }));
    const start = await call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: pts[0]!.ts }));
    const tripId = start.body.tripId as string;
    await call(e, `/trips/${tripId}/points`, post('', { points: pts }));
    await call(e, `/trips/${tripId}/end`, post('', { endedAt: pts.at(-1)!.ts }));
    await e.app.matching.idle();
  };

  it('세션 중 트립은 게스트의 도로·시군구로 인정되고 차주 기록과 별개이며, 내린 뒤 트립은 인정되지 않는다', async () => {
    const e = await setup();
    const a = (await sit(e)).body;
    await drive(e, V, 0);
    const sum = await call(e, '/me/summary', { headers: bearer(a.token) });
    expect(sum.status).toBe(200);
    expect(sum.body.role).toBe('guest');
    expect(sum.body.activeSessionId).toBe(a.sessionId);
    expect(sum.body.coverage.drivenKm).toBe(2);
    expect(sum.body.regions.colored).toBeGreaterThan(0);
    expect(sum.body).not.toHaveProperty('vehicleId');
    const regs = (await call(e, '/me/regions', { headers: bearer(a.token) })).body.items as any[];
    expect(regs.filter((r) => r.level >= 1).map((r) => r.displayName).sort()).toEqual(['서울 종로구', '서울 중구']);
    // 내린다
    e.clock.t = T0 + 2 * HOUR;
    await call(e, `/guest/${a.sessionId}/end`, { method: 'POST', headers: bearer(a.token) });
    await drive(e, V, 3 * HOUR); // 내린 뒤의 트립(시각이 세션 종료 뒤)
    const after = (await call(e, '/me/summary', { headers: bearer(a.token) })).body;
    expect(after.coverage.drivenKm).toBe(2);
    expect(after.activeSessionId).toBeNull();
    // 차주 기록은 별개: 차량 쪽 집계는 그대로 있다
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(2);
    // 게스트가 아닌 사람의 /me는 인증이 필요하다
    expect((await call(e, '/me/summary')).status).toBe(401);
    expect((await call(e, '/me/regions', { headers: bearer('k'.repeat(43)) })).status).toBe(401);
  });

  it('세션 전 트립은 소급하지 않고, 두 게스트는 서로의 기록을 볼 수 없다', async () => {
    const e = await setup();
    await drive(e, V, -2 * HOUR); // 세션 전
    const a = (await sit(e)).body;
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(0);
    const b = (await sit(e)).body;
    await drive(e, V, 0);
    const sa = (await call(e, '/me/summary', { headers: bearer(a.token) })).body;
    const sb = (await call(e, '/me/summary', { headers: bearer(b.token) })).body;
    expect(sa.coverage.drivenKm).toBe(2);
    expect(sb.coverage.drivenKm).toBe(2);
    // 한 명이 지우면 다른 사람 것은 남는다
    await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(a.token) });
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(0);
    expect((await call(e, '/me/summary', { headers: bearer(b.token) })).body.coverage.drivenKm).toBe(2);
  });

  it('차주 계정의 /me/summary는 차량 기록(vehicleId 포함)을 준다', async () => {
    const e = await setup();
    const owner = (await call(e, '/pair/claim', post('', { code: (await call(e, '/pair/code', post('', { vehicleId: V, gear: 'P' }))).body.code }))).body;
    await drive(e, V, 0);
    const s = (await call(e, '/me/summary', { headers: bearer(owner.token) })).body;
    expect(s).toMatchObject({ role: 'owner', vehicleId: V });
    expect(s.coverage.drivenKm).toBe(2);
    expect(s.regions.colored).toBeGreaterThan(0);
  });

  it('게스트 도로 기록은 세션 시간 창만: 세션 중 다시 달리기·바랜 길 되살림도 트리거로 반영', async () => {
    const e = await setup();
    const a = (await sit(e)).body;
    // 직접 driven_ways를 넣어 트리거를 확인(INSERT → guest_ways, UPDATE로 늘어난 커버리지 → 반영, 창 밖 시각 → 무시)
    const ins = (way: number, cov: number, last: number) =>
      e.db
        .prepare("INSERT INTO driven_ways VALUES (?, ?, ?, ?, ?, 't', '209901') ON CONFLICT (vehicle_id, way_id) DO UPDATE SET coverage = MAX(coverage, excluded.coverage), last_driven_at = MAX(last_driven_at, excluded.last_driven_at)")
        .run(V, way, cov, new Date(last).toISOString(), new Date(last).toISOString());
    ins(1, 0.5, T0 + MIN);
    ins(2, 0.9, T0 - HOUR); // 세션 전
    ins(1, 0.8, T0 + 2 * MIN);
    const rows = e.db.prepare('SELECT way_id, coverage FROM guest_ways ORDER BY way_id').all();
    expect(rows).toEqual([{ way_id: 1, coverage: 0.8 }]);
    expect(a.sessionId).toBeTruthy();
  });
});
