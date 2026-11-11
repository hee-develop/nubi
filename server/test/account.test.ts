import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeValhalla, makePoints, makeRoadsDb, matchedResponse, type SynthWay } from './helpers.js';
import { bearer, call, extApp, HOUR, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const V = 'veh-1';
const put = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const W = (id: number, lengthM: number, roadKey: string, at: [number, number]): SynthWay => ({ id, roadKey, lengthM, highway: 'residential', at });

const setup = async (extra: Parameters<typeof extApp>[0] = {}) => {
  const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 1000, 'nm:a', [126.978, 37.5665]), W(2, 1000, 'nm:b', [127.0, 37.57])]);
  return extApp({ roadsPath, valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }], 40)) }, ...extra });
};
/** [dayOffset]일 [hour]시(UTC)부터 달리는 트립 하나를 매칭까지. */
const drive = async (e: ExtApp, vehicleId: string, atMs: number, n = 40) => {
  const pts = makePoints(n, 25, 37.5665, 126.978, 12).map((p, i) => ({ ...p, ts: new Date(atMs + i * 2000).toISOString() }));
  const start = await call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: pts[0]!.ts }));
  const tripId = start.body.tripId as string;
  const up = await call(e, `/trips/${tripId}/points`, post('', { points: pts }));
  await call(e, `/trips/${tripId}/end`, post('', { endedAt: pts.at(-1)!.ts }));
  await e.app.matching.idle();
  return { tripId, up };
};

describe('설정', () => {
  it('기본값을 주고 부분 갱신하며 시군구 코드를 검증한다(없는 코드·형식 오류 400, 입력 미반사)', async () => {
    const e = await setup();
    expect((await call(e, `/vehicles/${V}/settings`)).body).toEqual({
      recordingPaused: false,
      homeRegion: null,
      statsOptIn: true,
      drivingMap: true,
      hideHomeInCards: true,
      consentWithdrawnAt: null,
    });
    const r = await call(e, `/vehicles/${V}/settings`, put({ recordingPaused: true, homeRegion: '11140', statsOptIn: false }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recordingPaused: true, homeRegion: '11140', statsOptIn: false, drivingMap: true });
    // 보내지 않은 항목은 그대로
    expect((await call(e, `/vehicles/${V}/settings`, put({ drivingMap: false }))).body).toMatchObject({ recordingPaused: true, homeRegion: '11140', drivingMap: false });
    expect((await call(e, `/vehicles/${V}/settings`, put({ homeRegion: null }))).body.homeRegion).toBeNull();
    for (const body of [{ homeRegion: '99999' }, { homeRegion: '1114' }, { homeRegion: 11140 }, { recordingPaused: 'yes' }, { statsOptIn: 1 }]) {
      const bad = await call(e, `/vehicles/${V}/settings`, put(body));
      expect(bad.status).toBe(400);
      expect(Object.keys(bad.body)).toEqual(['error']);
      expect(JSON.stringify(bad.body)).not.toContain('99999');
    }
    expect((await call(e, `/vehicles/${V}/settings`, { method: 'PUT', body: '깨짐' })).status).toBe(400);
  });

  it('alias(UUID)로 읽고 써도 정본 차량의 설정이다', async () => {
    const e = await setup();
    await call(e, '/vehicles/alias', post('', { fromVehicleId: 'uuid-1', toVehicleId: V }));
    await call(e, '/vehicles/uuid-1/settings', put({ homeRegion: '11110' }));
    expect((await call(e, `/vehicles/${V}/settings`)).body.homeRegion).toBe('11110');
  });

  it('기록 멈춤이면 점 업로드를 저장하지 않고 200으로 응답한다(차량 큐가 쌓이지 않게), 다시 켜면 저장한다', async () => {
    const e = await setup();
    await call(e, `/vehicles/${V}/settings`, put({ recordingPaused: true }));
    const a = await drive(e, V, T0);
    expect(a.up.body).toEqual({ accepted: 0, duplicated: 0, paused: true });
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM trip_points').get() as any).n).toBe(0);
    await call(e, `/vehicles/${V}/settings`, put({ recordingPaused: false }));
    const b = await drive(e, V, T0 + HOUR);
    expect(b.up.body.accepted).toBe(40);
  });

  it('토큰 인증 required: 설정은 그 차량 토큰만(401·403)', async () => {
    const e = await setup({ ext: { auth: 'required' } });
    const a = (await call(e, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    const b = (await call(e, '/vehicles/register', post('', { vin: 'KMHZZZZZZ12345678' }))).body;
    expect((await call(e, `/vehicles/${a.vehicleId}/settings`)).status).toBe(401);
    expect((await call(e, `/vehicles/${a.vehicleId}/settings`, { headers: bearer(b.vehicleToken) })).status).toBe(403);
    expect((await call(e, `/vehicles/${a.vehicleId}/settings`, { headers: bearer(a.vehicleToken) })).status).toBe(200);
    expect((await call(e, `/vehicles/${a.vehicleId}/data`, { method: 'DELETE', headers: bearer(b.vehicleToken) })).status).toBe(403);
    expect((await call(e, `/vehicles/${a.vehicleId}/data`, { method: 'DELETE' })).status).toBe(401);
  });
});

describe('데이터 삭제(위치정보 동의 철회)', () => {
  it('트립·점·매칭·인정 도로·시군구 기록·게스트 기록을 지우고 기록을 멈춘다. 다른 차량 기록은 그대로', async () => {
    const e = await setup();
    const g = (await call(e, '/guest/code', post('', { vehicleId: V, gear: 'P' }))).body;
    const guest = (await call(e, '/guest/claim', post('', { code: g.code, consent: true }))).body;
    await drive(e, V, T0 + 1000);
    await drive(e, 'other', T0 + 1000);
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(2);
    expect((await call(e, '/me/summary', { headers: bearer(guest.token) })).body.coverage.drivenKm).toBe(2);
    const del = await call(e, `/vehicles/${V}/data`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ ok: true, deleted: { trips: 1, points: 40, ways: 2 } });
    expect(del.body.deleted.regions).toBeGreaterThan(0);
    expect((await call(e, `/trips?vehicleId=${V}`)).body.trips).toEqual([]);
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body).toMatchObject({ drivenKm: 0, roadsStarted: 0 });
    expect((await call(e, `/regions/summary?vehicleId=${V}`)).body.colored).toBe(0);
    expect((await call(e, '/me/summary', { headers: bearer(guest.token) })).body.coverage.drivenKm).toBe(0);
    for (const t of ['trip_points', 'trip_matching', 'region_events', 'visited_regions', 'driven_ways', 'region_pending', 'region_jobs', 'way_revived']) {
      const n = (e.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'trip_points' || t === 'trip_matching' || t === 'region_jobs' ? 'trip_id IN (SELECT id FROM trips WHERE vehicle_id = ?)' : 'vehicle_id = ?'}`).get(V) as any).n;
      expect(n).toBe(0);
    }
    // 다른 차량은 그대로
    expect((await call(e, '/coverage/summary?vehicleId=other')).body.drivenKm).toBe(2);
    // 철회 표시와 기록 멈춤
    expect((await call(e, `/vehicles/${V}/settings`)).body).toMatchObject({ recordingPaused: true });
    expect((await call(e, `/vehicles/${V}/settings`)).body.consentWithdrawnAt).toBe(new Date(T0).toISOString());
    // 다시 켜면(재동의) 철회 표시가 사라진다
    expect((await call(e, `/vehicles/${V}/settings`, put({ recordingPaused: false }))).body.consentWithdrawnAt).toBeNull();
    // 기록이 없어도 지우기는 멱등(200)
    expect((await call(e, `/vehicles/${V}/data`, { method: 'DELETE' })).body.deleted).toEqual({ trips: 0, points: 0, ways: 0, regions: 0 });
  });

  it('alias로 올린 트립도 함께 지운다', async () => {
    const e = await setup();
    await call(e, '/vehicles/alias', post('', { fromVehicleId: 'uuid-9', toVehicleId: V }));
    await drive(e, 'uuid-9', T0 + 1000);
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(2);
    expect((await call(e, `/vehicles/${V}/data`, { method: 'DELETE' })).body.deleted.trips).toBe(1);
    expect((await call(e, `/coverage/summary?vehicleId=${V}`)).body.drivenKm).toBe(0);
  });
});

describe('리포트(KST)', () => {
  it('일간: 새 km·처음 지난 시군구·트립 수·거리, 날짜는 KST 기준이다', async () => {
    const e = await setup();
    // 2026-11-12 10:00 KST = 01:00Z
    await drive(e, V, Date.parse('2026-11-12T01:00:00Z'));
    // 2026-11-12 23:50 KST = 14:50Z (같은 KST 날), 2026-11-13 00:10 KST = 15:10Z(다음 날)
    await drive(e, V, Date.parse('2026-11-12T14:50:00Z'));
    await drive(e, V, Date.parse('2026-11-12T15:10:00Z'));
    const day = (await call(e, `/reports/daily?vehicleId=${V}&date=2026-11-12`)).body;
    expect(day).toMatchObject({ date: '2026-11-12', tripCount: 2, newKm: 2, newWays: 2, revivedKm: 0 });
    expect(day.distanceKm).toBeGreaterThan(1.5);
    expect(day.newRegions.map((r: any) => r.displayName).sort()).toEqual(['서울 종로구', '서울 중구']);
    expect(day.newStays).toEqual([]);
    const next = (await call(e, `/reports/daily?vehicleId=${V}&date=2026-11-13`)).body;
    expect(next).toMatchObject({ tripCount: 1, newKm: 0, newRegions: [] }); // 이미 칠한 길·시군구
    expect((await call(e, `/reports/daily?vehicleId=${V}&date=2026-11-14`)).body).toMatchObject({ tripCount: 0, distanceKm: 0, newKm: 0 });
    expect(JSON.stringify(day)).not.toMatch(/"(lat|lon|wayId|way_id)"/);
  });

  it('월간: 한 달 합계와 이용 일수, 되살린 거리', async () => {
    const e = await setup();
    await drive(e, V, Date.parse('2026-11-12T01:00:00Z'));
    await drive(e, V, Date.parse('2026-11-20T01:00:00Z'));
    await drive(e, V, Date.parse('2026-12-01T01:00:00Z'));
    const m = (await call(e, `/reports/monthly?vehicleId=${V}&month=2026-11`)).body;
    expect(m).toMatchObject({ month: '2026-11', tripCount: 2, daysDriven: 2, newKm: 2, newWays: 2 });
    expect((await call(e, `/reports/monthly?vehicleId=${V}&month=2026-12`)).body).toMatchObject({ tripCount: 1, newKm: 0 });
    // 바랜 길을 다시 달리면 그 달 되살린 거리에 잡힌다
    await call(e, '/debug/age', post('', { vehicleId: V, days: 400 }));
    await drive(e, V, Date.parse('2027-01-05T01:00:00Z'));
    expect((await call(e, `/reports/monthly?vehicleId=${V}&month=2027-01`)).body.revivedKm).toBe(2);
    expect((await call(e, `/reports/monthly?vehicleId=${V}&month=2026-11`)).body.revivedKm).toBe(0);
  });

  it('입력 검증: vehicleId·date·month 누락/형식/없는 날짜는 400(입력 미반사)', async () => {
    const e = await setup();
    expect((await call(e, '/reports/daily?date=2026-11-12')).status).toBe(400);
    for (const d of ['', '2026-13-01', '2026-02-30', '26-11-12', '2026-11-1', '내일']) {
      const r = await call(e, `/reports/daily?vehicleId=${V}&date=${encodeURIComponent(d)}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid_date' });
    }
    expect((await call(e, `/reports/daily?vehicleId=${V}`)).status).toBe(400);
    for (const m of ['', '2026-13', '2026-00', '2026-1', '202611', '1999-01']) expect((await call(e, `/reports/monthly?vehicleId=${V}&month=${m}`)).body).toEqual({ error: 'invalid_month' });
    expect((await call(e, '/reports/monthly?month=2026-11')).status).toBe(400);
  });
});
