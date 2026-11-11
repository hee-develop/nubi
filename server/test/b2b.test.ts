import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRoadsDb, type SynthWay } from './helpers.js';
import { bearer, call, DAY, extApp, HOUR, post, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const KEY = 'b2b-secret-key-123';
const IN_JUNGGU: [number, number] = [37.5665, 126.978]; // 서울 중구(11140) 안
const W = (id: number, lengthM: number, roadKey: string, at: [number, number]): SynthWay => ({ id, roadKey, lengthM, highway: 'residential', at, name: roadKey });

const b2b = (e: ExtApp, path: string, init: RequestInit = {}) => call(e, path, { ...init, headers: { ...(init.headers as Record<string, string>), ...bearer(KEY) } });

let seq = 0;
/** 트립 하나(종료 지점이 [at])를 직접 넣는다. 매칭 결과에 통과한 시군구를 적는다. */
const addTrip = (e: ExtApp, vehicleId: string, startMs: number, endMs: number, opts: { passed?: string[]; at?: [number, number] } = {}) => {
  const id = `trip-${++seq}`;
  const iso = (ms: number) => new Date(ms).toISOString();
  e.db.prepare('INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, vehicleId, vehicleId, iso(startMs), iso(endMs), 'x');
  const [lat, lon] = opts.at ?? IN_JUNGGU;
  e.db.prepare('INSERT INTO trip_points (trip_id, seq, ts, lat, lon) VALUES (?, 0, ?, ?, ?)').run(id, iso(startMs), lat, lon);
  e.db.prepare('INSERT INTO trip_points (trip_id, seq, ts, lat, lon) VALUES (?, 1, ?, ?, ?)').run(id, iso(endMs), lat, lon);
  e.db
    .prepare("INSERT INTO trip_matching (trip_id, status, queued_at, result_json) VALUES (?, 'done', 'x', ?)")
    .run(id, JSON.stringify({ outcome: 'counted', regions: { passed: opts.passed ?? [], newPassed: [] } }));
  return id;
};
const event = (e: ExtApp, vehicleId: string, kind: 'visit' | 'stay', atMs: number, tripId: string, code = '11140') =>
  e.db.prepare('INSERT INTO region_events (vehicle_id, code, kind, at, trip_id) VALUES (?, ?, ?, ?, ?)').run(vehicleId, code, kind, new Date(atMs).toISOString(), tripId);

const NOV = Date.parse('2026-11-10T03:00:00Z');

describe('B2B 인증', () => {
  it('키가 설정되지 않으면 503, 없거나 틀리면 401, 맞으면 통과. 반복 실패는 429', async () => {
    const e0 = extApp();
    expect((await call(e0, '/b2b/regions/11140/monthly?month=2026-11', { headers: bearer(KEY) })).body).toEqual({ error: 'b2b_not_configured' });
    const e = extApp({ ext: { b2bKey: KEY } });
    const url = '/b2b/regions/11140/monthly?month=2026-11';
    expect((await call(e, url)).status).toBe(401);
    expect((await call(e, url, { headers: bearer('wrong') })).status).toBe(401);
    expect((await call(e, url, { headers: { authorization: `Basic ${KEY}` } })).status).toBe(401);
    expect((await b2b(e, url)).status).toBe(200);
    for (let i = 0; i < 20; i++) await call(e, url, { headers: bearer('bad' + i) });
    expect((await b2b(e, url)).status).toBe(429); // 실패가 쌓이면 맞는 키도 잠시 막는다
    e.clock.t += 6 * 60_000;
    expect((await b2b(e, url)).status).toBe(200);
  });

  it('차량 토큰(NUBI_AUTH=required)과 별개로 B2B는 자기 키만 쓴다', async () => {
    const e = extApp({ ext: { b2bKey: KEY, auth: 'required' } });
    expect((await b2b(e, '/b2b/regions/11140/monthly?month=2026-11')).status).toBe(200);
  });
});

describe('B2B 월간 집계', () => {
  it('통과·방문·숙박 차량 수와 k=5 숨김, 내 지역·익명 통계 끈 차량 제외, 차량 ID·좌표는 응답에 없다', async () => {
    const e = extApp({ ext: { b2bKey: KEY } });
    // 6대가 중구를 통과(11월), 그 중 5대 방문, 4대 숙박
    for (let i = 0; i < 6; i++) {
      const v = `veh-${i}`;
      const t = addTrip(e, v, NOV + i * 1000, NOV + HOUR, { passed: ['11140', '11110'] });
      if (i < 5) event(e, v, 'visit', NOV + 2 * HOUR, t);
      if (i < 4) event(e, v, 'stay', NOV + 3 * HOUR, t);
    }
    // 10월 기록·다른 시군구 통과는 11월 중구에 세지 않는다
    addTrip(e, 'veh-oct', Date.parse('2026-10-31T10:00:00Z'), Date.parse('2026-10-31T11:00:00Z'), { passed: ['11140'] });
    addTrip(e, 'veh-other', NOV, NOV + HOUR, { passed: ['11110'] });
    const r = await b2b(e, '/b2b/regions/11140/monthly?month=2026-11');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: '11140', displayName: '서울 중구', month: '2026-11', k: 5, pass: { vehicles: 6 }, visit: { vehicles: 5 }, stay: { vehicles: null, suppressed: true } });
    expect(JSON.stringify(r.body)).not.toMatch(/veh-|trip-|lat|lon|coordinates/);
    // 익명 통계 참여를 끄면 빠진다 → 5대
    await call(e, '/vehicles/veh-0/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statsOptIn: false }) });
    expect((await b2b(e, '/b2b/regions/11140/monthly?month=2026-11')).body).toMatchObject({ pass: { vehicles: 5 }, visit: { vehicles: null, suppressed: true } });
    // '내 지역'이 중구인 차량은 중구 집계에서 빠진다 → 4대, 칸 숨김
    await call(e, '/vehicles/veh-1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeRegion: '11140' }) });
    expect((await b2b(e, '/b2b/regions/11140/monthly?month=2026-11')).body.pass).toEqual({ vehicles: null, suppressed: true });
    // 다른 시군구 집계에는 '내 지역'이 영향이 없다(종로구: 통과 6대 + veh-other 1대 − 익명 통계 끈 veh-0 1대)
    expect((await b2b(e, '/b2b/regions/11110/monthly?month=2026-11')).body.pass).toEqual({ vehicles: 6 });
  });

  it('alias로 올린 트립은 정본 차량 하나로 센다', async () => {
    const e = extApp({ ext: { b2bKey: KEY } });
    await call(e, '/vehicles/alias', post('', { fromVehicleId: 'uuid-x', toVehicleId: 'veh-x' }));
    for (let i = 0; i < 4; i++) addTrip(e, `veh-${i}`, NOV, NOV + HOUR, { passed: ['11140'] });
    addTrip(e, 'veh-x', NOV, NOV + HOUR, { passed: ['11140'] });
    addTrip(e, 'uuid-x', NOV + DAY, NOV + DAY + HOUR, { passed: ['11140'] });
    expect((await b2b(e, '/b2b/regions/11140/monthly?month=2026-11')).body.pass).toEqual({ vehicles: 5 });
  });

  it('체류 3시간: 하루(KST) 정차 합계 3시간 이상인 차량만, 7일 넘는 장기 주차와 다른 시군구 정차는 제외', async () => {
    const e = extApp({ ext: { b2bKey: KEY } });
    const loc = await call(e, `/regions/at?lat=${IN_JUNGGU[0]}&lon=${IN_JUNGGU[1]}`);
    expect(loc.body.code).toBe('11140');
    // 5대: 저녁 6시(KST)에 중구에서 종료 → 다음 날 오전 9시 출발 → 첫날 6시간, 다음날 9시간
    for (let i = 0; i < 5; i++) {
      const end = Date.parse('2026-11-10T09:00:00Z'); // 18:00 KST
      addTrip(e, `d-${i}`, end - HOUR, end);
      addTrip(e, `d-${i}`, Date.parse('2026-11-11T00:00:00Z'), Date.parse('2026-11-11T01:00:00Z'), { at: [37.7, 127.5] });
    }
    // 2시간만 정차(3시간 미만), 7일 넘는 정차, 다른 시군구(종로 밖 좌표)에서 정차
    const e1 = Date.parse('2026-11-10T09:00:00Z');
    addTrip(e, 'short', e1 - HOUR, e1);
    addTrip(e, 'short', e1 + 2 * HOUR, e1 + 3 * HOUR, { at: [37.7, 127.5] });
    addTrip(e, 'long', e1 - HOUR, e1);
    addTrip(e, 'long', e1 + 8 * DAY, e1 + 8 * DAY + HOUR, { at: [37.7, 127.5] });
    addTrip(e, 'elsewhere', e1 - HOUR, e1, { at: [37.7, 127.5] });
    addTrip(e, 'elsewhere', e1 + 12 * HOUR, e1 + 13 * HOUR, { at: [37.7, 127.5] });
    e.clock.t = Date.parse('2026-11-12T00:00:00Z');
    const r = await b2b(e, '/b2b/regions/11140/monthly?month=2026-11');
    expect(r.body.dwell3h).toEqual({ vehicles: 5 });
    // 한 대를 더 빼면(4대) 숨겨진다
    await call(e, '/vehicles/d-0/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statsOptIn: false }) });
    expect((await b2b(e, '/b2b/regions/11140/monthly?month=2026-11')).body.dwell3h).toEqual({ vehicles: null, suppressed: true });
  });

  it('입력 검증: 형식 400, 없는 시군구 404, 월 형식 400(입력 미반사)', async () => {
    const e = extApp({ ext: { b2bKey: KEY } });
    expect((await b2b(e, '/b2b/regions/abc/monthly?month=2026-11')).body).toEqual({ error: 'invalid_code' });
    expect((await b2b(e, '/b2b/regions/99999/monthly?month=2026-11')).status).toBe(404);
    for (const m of ['', '2026-13', '202611', 'x']) expect((await b2b(e, `/b2b/regions/11140/monthly?month=${m}`)).body).toEqual({ error: 'invalid_month' });
    expect((await call(extApp({ ext: { b2bKey: KEY }, regionsPath: null }), '/b2b/regions/11140/monthly?month=2026-11', { headers: bearer(KEY) })).status).toBe(503);
  });
});

describe('코스·완주 인증', () => {
  const setup = async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 1000, 'nm:a', [127.9, 38.1]), W(2, 2000, 'nm:b', [128.0, 38.1]), W(3, 1000, 'nm:z', [128.1, 38.1])]);
    return extApp({ roadsPath, ext: { b2bKey: KEY } });
  };
  const drive = (e: ExtApp, v: string, ways: [number, number][], lastIso = '2026-11-10T00:00:00.000Z') => {
    for (const [w, cov] of ways) e.db.prepare("INSERT INTO driven_ways VALUES (?, ?, ?, ?, ?, 't', '209901')").run(v, w, cov, lastIso, lastIso);
  };
  const course = async (e: ExtApp, body: unknown = { name: '양구 펀치볼 둘레길', regionCode: '51800', roadKeys: ['nm:a', 'nm:b'] }) => b2b(e, '/b2b/courses', post('', body));

  it('코스 생성(201)·목록·검증(400·401)', async () => {
    const e = await setup();
    const c = await course(e);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: '양구 펀치볼 둘레길', regionCode: '51800', roadKeys: ['nm:a', 'nm:b'], lengthKm: 3 });
    expect((await call(e, '/b2b/courses', post('', { name: 'x', regionCode: '51800', roadKeys: ['nm:a'] }))).status).toBe(401);
    expect((await course(e, { name: 'x', regionCode: '51800', roadKeys: ['nm:없음'] })).body).toEqual({ error: 'unknown_road' });
    expect((await course(e, { name: 'x', regionCode: '99999', roadKeys: ['nm:a'] })).body).toEqual({ error: 'invalid_region' });
    for (const b of [{}, { name: '', regionCode: '51800', roadKeys: ['nm:a'] }, { name: 'x', regionCode: '518', roadKeys: ['nm:a'] }, { name: 'x', regionCode: '51800', roadKeys: [] }]) {
      expect((await course(e, b)).body).toEqual({ error: 'invalid_body' });
    }
    expect(((await b2b(e, '/b2b/courses')).body.items as any[]).map((i) => i.name)).toEqual(['양구 펀치볼 둘레길']);
    const pub = (await call(e, '/courses')).body.items[0];
    expect(pub).toEqual({ id: c.body.id, name: '양구 펀치볼 둘레길', regionCode: '51800', lengthKm: 3 });
  });

  it('완주 집계: 코스 도로를 모두 95% 이상 달린 차량만, 월 구분·k=5·익명 통계 제외', async () => {
    const e = await setup();
    const c = (await course(e)).body;
    for (let i = 0; i < 5; i++) drive(e, `done-${i}`, [[1, 1], [2, 1]]);
    drive(e, 'half', [[1, 1], [2, 0.5]]); // nm:b 50%
    drive(e, 'one', [[1, 1]]);
    drive(e, 'oldmonth', [[1, 1], [2, 1]], '2026-10-10T00:00:00.000Z');
    const m = (await b2b(e, `/b2b/courses/${c.id}/completions?month=2026-11`)).body;
    expect(m).toEqual({ courseId: c.id, name: '양구 펀치볼 둘레길', month: '2026-11', k: 5, vehicles: 5 });
    expect((await b2b(e, `/b2b/courses/${c.id}/completions?month=2026-10`)).body).toMatchObject({ vehicles: null, suppressed: true });
    await call(e, '/vehicles/done-0/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statsOptIn: false }) });
    expect((await b2b(e, `/b2b/courses/${c.id}/completions?month=2026-11`)).body).toMatchObject({ vehicles: null, suppressed: true });
    expect((await b2b(e, '/b2b/courses/nope/completions?month=2026-11')).status).toBe(404);
    expect((await b2b(e, `/b2b/courses/${c.id}/completions?month=zz`)).body).toEqual({ error: 'invalid_month' });
    expect((await call(e, `/b2b/courses/${c.id}/completions?month=2026-11`)).status).toBe(401);
  });

  it('인증서: 완주하면 추측 불가 id의 공개 HTML(차량 ID·날짜 없음), 미완주 409, 없는 코스 404, 형식 오류 400. 같은 코스·차량은 같은 인증서', async () => {
    const e = await setup();
    const c = (await course(e)).body;
    drive(e, 'done', [[1, 1], [2, 0.96]]);
    drive(e, 'half', [[1, 1], [2, 0.5]]);
    const issue = (v: string, id = c.id) => call(e, `/courses/${id}/certificate`, post('', { vehicleId: v }));
    const cert = await issue('done');
    expect(cert.status).toBe(200);
    expect(cert.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(cert.body.number).toMatch(/^NB-[0-9A-F]{10}$/);
    expect(cert.body.url).toBe(`http://localhost/c/${cert.body.id}`);
    expect(JSON.stringify(cert.body)).not.toContain('done');
    expect((await issue('done')).body).toEqual(cert.body); // 멱등
    const r = await call(e, `/c/${cert.body.id}`); // 토큰 없이 열림, URL에 vehicleId 없음
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toContain('text/html');
    expect(r.res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(r.text).toContain('코스 완주 인증서');
    expect(r.text).toContain('양구 펀치볼 둘레길');
    expect(r.text).toContain('양구군');
    expect(r.text).toContain(cert.body.number);
    expect(r.text).toContain('완주율 95% 이상'); // 판정 기준 문구는 실제 기준(95%)과 같다
    expect(r.text).not.toMatch(/>\s*100%\s*</); // 예전의 '완주 구간 100%' 표기는 없다
    expect(r.text).not.toContain('done');
    expect(r.text).not.toMatch(/20\d\d-\d\d|20\d\d년/);
    drive(e, 'done2', [[1, 1], [2, 1]]);
    expect((await issue('done2')).body.id).not.toBe(cert.body.id);
    expect((await issue('half')).body).toEqual({ error: 'not_completed' });
    expect((await issue('nobody')).status).toBe(409);
    expect((await issue('done', 'nope')).status).toBe(404);
    expect((await call(e, `/courses/${c.id}/certificate`, post('', {}))).status).toBe(400);
    expect((await call(e, '/c/nonexistent0000000000')).status).toBe(404);
    expect((await call(e, '/c/x')).status).toBe(404);
    // 예전 vehicleId 쿼리 경로는 없다
    expect((await call(e, `/courses/${c.id}/certificate?vehicleId=done`)).status).toBe(404);
    // 차량 데이터 삭제 때 인증서도 지워진다
    await call(e, '/vehicles/done/data', { method: 'DELETE' });
    expect((await call(e, `/c/${cert.body.id}`)).status).toBe(404);
  });

  it('인증 required에서 인증서 발급은 차량 토큰이 필요하다(401·403), 조회 페이지는 공개', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r2.sqlite'), [W(1, 1000, 'nm:a', [127.9, 38.1])]);
    const r = extApp({ roadsPath, ext: { b2bKey: KEY, auth: 'required' } });
    const a = (await call(r, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    const b = (await call(r, '/vehicles/register', post('', { vin: 'KMHZZZZZZ12345678' }))).body;
    const c = (await b2b(r, '/b2b/courses', post('', { name: '코스', regionCode: '51800', roadKeys: ['nm:a'] }))).body;
    r.db.prepare("INSERT INTO driven_ways VALUES (?, 1, 1, 'a', 'b', 't', '209901')").run(a.vehicleId);
    const issue = (h: Record<string, string> = {}) => call(r, `/courses/${c.id}/certificate`, post('', { vehicleId: a.vehicleId }, h));
    expect((await issue()).status).toBe(401);
    expect((await issue(bearer(b.vehicleToken))).status).toBe(403);
    const ok = await issue(bearer(a.vehicleToken));
    expect(ok.status).toBe(200);
    expect((await call(r, `/c/${ok.body.id}`)).status).toBe(200);
  });
});
