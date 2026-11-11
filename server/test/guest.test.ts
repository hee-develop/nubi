import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeValhalla, makeRoadsDb, matchedResponse } from './helpers.js';
import { bearer, call, driveEast, eastPoints, eastRoads, extApp, HOUR, MIN, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const V = 'veh-owner';

/** 동쪽으로 이어진 합성 도로 3개(각 1km)와 그 세 도로를 모두 인정으로 돌려주는 가짜 Valhalla. */
const setupRecognition = async (gate?: { p: Promise<void> | null }) => {
  const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), eastRoads(3));
  return extApp({
    roadsPath,
    valhalla: {
      fetchFn: fakeValhalla(async () => {
        if (gate?.p) await gate.p; // 매칭을 일부러 붙잡아 둔다(확정 전 상태를 보려고)
        return matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }, { way_id: 3, length: 1 }], 40);
      }),
    },
  });
};

const guestCode = async (e: ExtApp, vehicleId = V) => call(e, '/guest/code', post('', { vehicleId, gear: 'P' }));
const claim = async (e: ExtApp, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  call(e, '/guest/claim', post('', { code, consent: true, ...extra }, headers));
const sit = async (e: ExtApp, vehicleId = V, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
  const c = await guestCode(e, vehicleId);
  return claim(e, c.body.code, extra, headers);
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
    expect((await call(e, '/pair/claim', post('', { consent: true, code: g.code }))).status).toBe(404);
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
    const mine = (await call(e, '/pair/claim', post('', { consent: true, code: (await call(e, '/pair/code', post('', { vehicleId: 'car-mine', gear: 'P' }))).body.code }))).body;
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

  it('세션 데이터 삭제: 본인만(403), 도로·시군구 기록과 닉네임이 사라지고 다시 지울 수 없다(404)', async () => {
    const e = await setupRecognition();
    const a = (await sit(e, V, {}, { nickname: '지수' })).body;
    const b = (await sit(e)).body;
    await driveEast(e, V, T0 + 1000, 80);
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(2);
    expect((await call(e, '/me/summary', { headers: bearer(b.token) })).body.coverage.drivenKm).toBe(2);
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM guest_trip_ways').get() as any).n).toBe(4);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE' })).status).toBe(401);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(b.token) })).status).toBe(403);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(a.token) })).status).toBe(200);
    expect(e.db.prepare('SELECT DISTINCT session_id FROM guest_trip_ways').all()).toEqual([{ session_id: b.sessionId }]);
    expect(e.db.prepare('SELECT nickname, deleted_at FROM guest_sessions WHERE id = ?').get(a.sessionId)).toMatchObject({ nickname: null });
    expect(await active(e)).toBe(1);
    expect((await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(a.token) })).status).toBe(404);
  });

  it('게스트 탈퇴(DELETE /me): 세션·닉네임·계정·토큰을 지우고 차주는 쓸 수 없다(403)', async () => {
    const e = extApp();
    const g = (await sit(e, V, {}, { nickname: '민수' })).body;
    const owner = (await call(e, '/pair/claim', post('', { consent: true, code: (await call(e, '/pair/code', post('', { vehicleId: 'car-x', gear: 'P' }))).body.code }))).body;
    expect((await call(e, '/me', { method: 'DELETE', headers: bearer(owner.token) })).status).toBe(403);
    expect((await call(e, '/me', { method: 'DELETE' })).status).toBe(401);
    expect((await call(e, '/me', { method: 'DELETE', headers: bearer(g.token) })).body).toEqual({ ok: true });
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get()).toEqual({ n: 0 });
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'guest'").get()).toEqual({ n: 0 });
    expect((await call(e, '/me/summary', { headers: bearer(g.token) })).status).toBe(401);
    expect(await active(e)).toBe(0);
  });
});

describe('게스트 기록 인정(/me): 트립의 점 시각이 세션 창과 겹치는 부분', () => {
  it('세션 중 트립은 게스트의 도로·시군구로 인정되고 차주 기록과 별개이며, 내린 뒤 트립은 인정되지 않는다', async () => {
    const e = await setupRecognition();
    const a = (await sit(e)).body;
    await driveEast(e, V, T0 + 1000, 80);
    const sum = await call(e, '/me/summary', { headers: bearer(a.token) });
    expect(sum.status).toBe(200);
    expect(sum.body.role).toBe('guest');
    expect(sum.body.activeSessionId).toBe(a.sessionId);
    expect(sum.body.coverage.drivenKm).toBe(2);
    expect(sum.body.regions.colored).toBeGreaterThan(0);
    expect(sum.body).not.toHaveProperty('vehicleId');
    const regs = (await call(e, '/me/regions', { headers: bearer(a.token) })).body.items as any[];
    expect(regs.filter((r) => r.level >= 1).map((r) => r.displayName)).toContain('서울 중구');
    // 내린다
    e.clock.t = T0 + 2 * HOUR;
    await call(e, `/guest/${a.sessionId}/end`, { method: 'POST', headers: bearer(a.token) });
    await driveEast(e, V, T0 + 3 * HOUR, 120); // 내린 뒤의 트립(시각이 세션 종료 뒤)
    const after = (await call(e, '/me/summary', { headers: bearer(a.token) })).body;
    expect(after.coverage.drivenKm).toBe(2);
    expect(after.activeSessionId).toBeNull();
    // 차주(차량) 기록은 별개: 3km까지 달렸다
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(3);
    expect((await call(e, '/me/summary')).status).toBe(401);
    expect((await call(e, '/me/regions', { headers: bearer('k'.repeat(43)) })).status).toBe(401);
  });

  it('정차 중 탑승·하차(트립 도중): 겹친 점 구간의 도로만 인정하고 앞뒤 도로는 인정하지 않는다', async () => {
    const e = await setupRecognition();
    // 3km 트립(점 120개, 2초 간격). 점 40(1km 지점)에서 탑승, 점 78(약 1.95km 지점)에서 하차 → 두 번째 도로(1~2km)만
    e.clock.t = T0 + 80_000;
    const a = (await sit(e)).body;
    e.clock.t = T0 + 156_000;
    await call(e, `/guest/${a.sessionId}/end`, { method: 'POST', headers: bearer(a.token) });
    await driveEast(e, V, T0, 120);
    const sum = (await call(e, '/me/summary', { headers: bearer(a.token) })).body;
    expect(sum.coverage.drivenKm).toBeGreaterThan(0.9);
    expect(sum.coverage.drivenKm).toBeLessThanOrEqual(1);
    expect(sum.coverage.roadsStarted).toBe(1);
    expect(e.db.prepare('SELECT way_id FROM guest_trip_ways').all()).toEqual([{ way_id: 2 }]);
    // 같은 트립을 차량 쪽에서는 전부(3km) 인정한다
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(3);
  });

  it('커버리지는 겹친 점이 덮은 비율만 쓴다(차량의 MAX 커버리지를 복사하지 않는다)', async () => {
    const e = await setupRecognition();
    await driveEast(e, V, T0 - 5 * HOUR, 120); // 세션 전: 차량은 3km 전부 인정(커버리지 1)
    const a = (await sit(e)).body;
    // 두 번째 트립: 세션이 점 60(1.5km 지점)부터 걸친다 → 두 번째 도로는 절반만, 세 번째는 전부
    const pts = eastPoints(120, T0 + 1000);
    e.clock.t = Date.parse(pts[60]!.ts);
    const b = (await sit(e)).body; // 다른 게스트: 점 60부터 탑승(이 사람만 부분 겹침)
    await driveEast(e, V, T0 + 1000, 120, pts);
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(3);
    const sa = (await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm;
    const sb = (await call(e, '/me/summary', { headers: bearer(b.token) })).body.coverage.drivenKm;
    expect(sa).toBe(3); // 처음부터 앉은 게스트: 전부
    expect(sb).toBeGreaterThan(1.4); // 점 60부터: 두 번째 도로 절반(약 0.53) + 세 번째 도로 전부(약 1)
    expect(sb).toBeLessThan(1.6);
    const cov = e.db.prepare('SELECT way_id, coverage FROM guest_trip_ways WHERE session_id = ? ORDER BY way_id').all(b.sessionId) as { way_id: number; coverage: number }[];
    expect(cov.map((r) => r.way_id)).toEqual([2, 3]);
    expect(cov[0]!.coverage).toBeGreaterThan(0.45);
    expect(cov[0]!.coverage).toBeLessThan(0.65);
  });

  it('매칭이 끝나지 않은 트립은 도로로 인정하지 않고, 끝나면 반영한다. 세션 전 트립은 소급하지 않는다', async () => {
    const gate: { p: Promise<void> | null } = { p: null };
    const e = await setupRecognition(gate);
    await driveEast(e, V, T0 - 2 * HOUR, 80); // 세션 전
    const a = (await sit(e)).body;
    let release!: () => void;
    gate.p = new Promise<void>((r) => (release = r));
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(0);
    const pts = eastPoints(80, T0 + 1000);
    const start = await call(e, '/trips', post('', { localId: 'l-pending', vehicleId: V, driverId: V, startedAt: pts[0]!.ts }));
    await call(e, `/trips/${start.body.tripId}/points`, post('', { points: pts }));
    await call(e, `/trips/${start.body.tripId}/end`, post('', { endedAt: pts.at(-1)!.ts }));
    // 아직 매칭 중이라 확정 전
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(0);
    release();
    await e.app.matching.idle();
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(2);
  });

  it('두 게스트는 서로의 기록을 볼 수 없고, 한 명이 지워도 다른 사람 것은 남는다', async () => {
    const e = await setupRecognition();
    const a = (await sit(e)).body;
    const b = (await sit(e)).body;
    await driveEast(e, V, T0 + 1000, 80);
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(2);
    expect((await call(e, '/me/summary', { headers: bearer(b.token) })).body.coverage.drivenKm).toBe(2);
    await call(e, `/guest/${a.sessionId}/data`, { method: 'DELETE', headers: bearer(a.token) });
    expect((await call(e, '/me/summary', { headers: bearer(a.token) })).body.coverage.drivenKm).toBe(0);
    expect((await call(e, '/me/summary', { headers: bearer(b.token) })).body.coverage.drivenKm).toBe(2);
  });

  it('방문·숙박은 내리기 전에 도착했을 때만 인정한다(마지막 점이 창 밖이면 통과만)', async () => {
    const e = await setupRecognition();
    const a = (await sit(e)).body;
    const pts = eastPoints(80, T0 + 1000);
    // 트립 종료 지점이 중구라고 보고 방문 이벤트를 직접 만든다(판정은 다음 트립이 하지만 이벤트는 그 트립 id에 묶인다)
    const tripId = await driveEast(e, V, T0 + 1000, 80, pts);
    e.db.prepare("INSERT INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES (?, '11140', 'visit', ?, ?)").run(V, new Date(T0 + HOUR).toISOString(), tripId);
    const level = async () => ((await call(e, '/me/regions', { headers: bearer(a.token) })).body.items as any[]).find((r) => r.code === '11140').level as number;
    expect(await level()).toBe(2); // 끝까지 탑승 → 방문
    // 마지막 점 전에 내린 다른 게스트: 방문은 인정하지 않고 통과만
    const e2 = await setupRecognition();
    const a2 = (await sit(e2)).body;
    const t2 = await driveEast(e2, V, T0 + 1000, 80, pts);
    e2.db.prepare("INSERT INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES (?, '11140', 'visit', ?, ?)").run(V, new Date(T0 + HOUR).toISOString(), t2);
    e2.clock.t = Date.parse(pts[50]!.ts);
    await call(e2, `/guest/${a2.sessionId}/end`, { method: 'POST', headers: bearer(a2.token) });
    const lv2 = ((await call(e2, '/me/regions', { headers: bearer(a2.token) })).body.items as any[]).find((r) => r.code === '11140').level as number;
    expect(lv2).toBe(1);
  });

  it('차주 계정이 다른 차에 게스트로 탄 기록도 내 기록(/me/summary·/me/regions)에 합쳐진다', async () => {
    const e = await setupRecognition();
    const owner = (await call(e, '/pair/claim', post('', { consent: true, code: (await call(e, '/pair/code', post('', { vehicleId: 'my-own-car', gear: 'P' }))).body.code }))).body;
    // 내 차는 아무것도 안 달렸다
    expect((await call(e, '/me/summary', { headers: bearer(owner.token) })).body.coverage.drivenKm).toBe(0);
    const s = await sit(e, V, bearer(owner.token));
    expect(s.status).toBe(200);
    await driveEast(e, V, T0 + 1000, 80);
    const sum = (await call(e, '/me/summary', { headers: bearer(owner.token) })).body;
    expect(sum).toMatchObject({ role: 'owner', vehicleId: 'my-own-car', activeSessionId: s.body.sessionId });
    expect(sum.coverage.drivenKm).toBe(2);
    expect(sum.regions.colored).toBeGreaterThan(0);
    const regs = ((await call(e, '/me/regions', { headers: bearer(owner.token) })).body.items as any[]).filter((r) => r.level > 0);
    expect(regs.map((r) => r.displayName)).toContain('서울 중구');
    // 웹 페이지 링크(24시간 읽기 전용)에서도 합쳐져 보인다
    const link = (await call(e, '/me/link', { method: 'POST', headers: bearer(owner.token) })).body.url as string;
    const sent = await e.app.request(link.replace('http://localhost', ''));
    expect(sent.status).toBe(303);
    const page = await e.app.request('/me', { headers: { cookie: sent.headers.get('set-cookie')!.split(';')[0]! } });
    expect(await page.text()).toMatch(/<b>2<\/b><span>달린 도로 km/);
  });

  it('차주 계정의 /me/summary는 차량 기록(vehicleId 포함)을 준다', async () => {
    const e = await setupRecognition();
    const owner = (await call(e, '/pair/claim', post('', { consent: true, code: (await call(e, '/pair/code', post('', { vehicleId: V, gear: 'P' }))).body.code }))).body;
    await driveEast(e, V, T0 + 1000, 80);
    const s = (await call(e, '/me/summary', { headers: bearer(owner.token) })).body;
    expect(s).toMatchObject({ role: 'owner', vehicleId: V });
    expect(s.coverage.drivenKm).toBe(3); // 합성 매칭이 세 도로를 모두 인정(차량 기준)
    expect(s.regions.colored).toBeGreaterThan(0);
  });
});
