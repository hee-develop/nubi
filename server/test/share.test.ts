import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeValhalla, makeRoadsDb, matchedResponse, type SynthWay } from './helpers.js';
import { bearer, call, extApp, post, T0, type ExtApp } from './ext-helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const V = 'veh-share-1234567890';
const W = (id: number, lengthM: number, roadKey: string, at: [number, number]): SynthWay => ({ id, roadKey, lengthM, highway: 'residential', at, name: roadKey });

const setup = async (extra: Parameters<typeof extApp>[0] = {}) => {
  const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 1000, 'nm:a', [126.978, 37.5665]), W(2, 1000, 'nm:b', [127.0, 37.57]), W(3, 2000, 'nm:c', [127.01, 37.58])]);
  return extApp({
    roadsPath,
    valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }, { way_id: 3, length: 0.5 }], 80)) },
    ...extra,
  });
};

/** 서울 중구에서 북쪽으로 [km]km 달리는 트립(점 25m 간격)을 매칭까지. */
const drive = async (e: ExtApp, vehicleId = V, km = 6.7, lat0 = 37.5) => {
  const n = Math.round((km * 1000) / 25) + 1;
  const pts = Array.from({ length: n }, (_, i) => ({ seq: i, ts: new Date(T0 + i * 2000).toISOString(), lat: lat0 + (i * 25) / 111_195, lon: 126.978 }));
  const start = await call(e, '/trips', post('', { localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: pts[0]!.ts }));
  const tripId = start.body.tripId as string;
  await call(e, `/trips/${tripId}/points`, post('', { points: pts }));
  await call(e, `/trips/${tripId}/end`, post('', { endedAt: pts.at(-1)!.ts }));
  await e.app.matching.idle();
  return tripId;
};
const create = (e: ExtApp, body: unknown, headers: Record<string, string> = {}) => call(e, '/share/cards', post('', body, headers));
const svgOf = async (e: ExtApp, id: string) => (await call(e, `/share/cards/${id}.svg`)).text;

/** SVG 안 굵기 [width]인 경로의 y 좌표 범위. */
const pathYRange = (svg: string, width: number) => {
  const m = new RegExp(`<path d="([^"]+)" fill="none" stroke="#f59e0b" stroke-width="${width}"`).exec(svg);
  if (!m) return null;
  const ys = [...m[1]!.matchAll(/[ML]?(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((x) => Number(x[2]));
  return { min: Math.min(...ys), max: Math.max(...ys) };
};

describe('공유 카드', () => {
  it('전국 카드: 응답 형태, PNG(800x960)·SVG 모두 내려가고 비식별(좌표·way id·차량 ID 없음)', async () => {
    const e = await setup();
    const tripId = await drive(e);
    const r = await create(e, { vehicleId: V, kind: 'national' });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(r.body.url).toBe(`http://localhost/s/${r.body.id}`);
    expect(r.body.imageUrl).toBe(`http://localhost/share/cards/${r.body.id}.png`);
    expect(Object.keys(r.body).sort()).toEqual(['id', 'imageUrl', 'url']);
    const png = await e.app.request(`/share/cards/${r.body.id}.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await png.arrayBuffer());
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([800, 960]);
    const svgRes = await e.app.request(`/share/cards/${r.body.id}.svg`);
    expect(svgRes.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await svgRes.text();
    expect(svg).toContain('© OpenStreetMap contributors');
    expect(svg).toContain('누비');
    expect(svg).toMatch(/전국 완료율 [\d.]+%/);
    // 비식별: 위경도 원본(소수 4자리 이상), 차량 ID, 트립 ID, 도로 키·way id 없음
    expect(svg).not.toMatch(/\d{2,3}\.\d{4,}/);
    for (const secret of [V, tripId, 'nm:a', 'wayId', 'way_id', 'lat=', 'lon=']) expect(svg).not.toContain(secret);
    expect(JSON.stringify(r.body)).not.toContain(V);
    // 날짜·시각 표기 없음
    expect(svg).not.toMatch(/20\d\d[-년]/);
  });

  it('여행 카드: 출발·도착 반경 1km를 지우고 월 단위만 표기, 새 도로·시군구 줄', async () => {
    const e = await setup();
    const tripId = await drive(e, V, 6.7);
    const r = await create(e, { vehicleId: V, kind: 'trip', tripIds: [tripId] });
    expect(r.status).toBe(200);
    const svg = await svgOf(e, r.body.id);
    expect(svg).toContain('2026년 11월');
    expect(svg).toMatch(/새 도로 [\d.]+km/);
    expect(svg).not.toMatch(/\d{2,3}\.\d{4,}/);
    for (const secret of [V, tripId, 'nm:']) expect(svg).not.toContain(secret);
    expect(svg).not.toMatch(/2026-11|T\d\d:\d\d/);
    // 6.7km 궤적에서 양 끝 1km씩을 지우면 약 4.7km가 남는다. 틀은 최소 0.06°(약 6.67km)라 453px(= 540 × 0.84)를 6.67km에 대응시키면 약 319px(지우지 않으면 453px 가득)
    const y = pathYRange(svg, 8)!;
    expect(y.max - y.min).toBeGreaterThan(295);
    expect(y.max - y.min).toBeLessThan(345);
  });

  it('여행 카드: 전부 반경 1km 안이면 그릴 것이 없어 409(too_short), 없는 트립·남의 트립은 404, 형식 오류는 400', async () => {
    const e = await setup();
    const short = await drive(e, V, 1.5, 37.5);
    expect((await create(e, { vehicleId: V, kind: 'trip', tripIds: [short] })).body).toEqual({ error: 'too_short' });
    expect((await create(e, { vehicleId: V, kind: 'trip', tripIds: ['없는-트립'] })).status).toBe(404);
    const other = await drive(e, 'other-vehicle', 6.7);
    const r = await create(e, { vehicleId: V, kind: 'trip', tripIds: [other] });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'trip_not_found' });
    for (const b of [{}, { vehicleId: V }, { vehicleId: V, kind: 'trip' }, { vehicleId: V, kind: 'trip', tripIds: [] }, { vehicleId: V, kind: 'road' }, { vehicleId: V, kind: 'weird' }, { kind: 'national' }, { vehicleId: V, kind: 'trip', tripIds: Array(21).fill('x') }]) {
      const bad = await create(e, b);
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'invalid_body' });
    }
  });

  it("'내 지역' 시군구의 구간은 여행 카드에서 숨겨진다(기본 켜짐), 끄면 보인다", async () => {
    const e = await setup();
    const tripId = await drive(e, V, 8, 37.5665);
    const full = pathYRange(await svgOf(e, (await create(e, { vehicleId: V, kind: 'trip', tripIds: [tripId] })).body.id), 8)!;
    // 종로구(11110, 위도 37.566~37.632)를 내 지역으로: 그 구간을 빼면 범위가 줄거나 그릴 것이 없어 409
    await call(e, `/vehicles/${V}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeRegion: '11110' }) });
    const hidden = await create(e, { vehicleId: V, kind: 'trip', tripIds: [tripId] });
    if (hidden.status === 200) {
      const h = pathYRange(await svgOf(e, hidden.body.id), 8)!;
      expect(h.max - h.min).toBeLessThan(full.max - full.min);
    } else expect(hidden.body).toEqual({ error: 'too_short' });
    await call(e, `/vehicles/${V}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hideHomeInCards: false }) });
    const shown = pathYRange(await svgOf(e, (await create(e, { vehicleId: V, kind: 'trip', tripIds: [tripId] })).body.id), 8)!;
    expect(Math.round(shown.max - shown.min)).toBe(Math.round(full.max - full.min));
  });

  it('도로 완주 카드: 완주한 도로만(409 not_completed), 없는 도로 404, 도로 키는 이미지에 없고 날짜는 월 단위', async () => {
    const e = await setup();
    await drive(e);
    const ok = await create(e, { vehicleId: V, kind: 'road', roadKey: 'nm:a' });
    expect(ok.status).toBe(200);
    const svg = await svgOf(e, ok.body.id);
    expect(svg).toContain('a 완주');
    expect(svg).toContain('2026년 11월');
    expect(svg).not.toMatch(/\d{2,3}\.\d{4,}/);
    expect(svg).not.toContain(V);
    expect((await create(e, { vehicleId: V, kind: 'road', roadKey: 'nm:c' })).body).toEqual({ error: 'not_completed' });
    expect((await create(e, { vehicleId: V, kind: 'road', roadKey: 'nm:nope' })).body).toEqual({ error: 'road_not_found' });
    expect((await create(e, { vehicleId: 'someone-else', kind: 'road', roadKey: 'nm:a' })).body).toEqual({ error: 'not_completed' });
  });

  it('이미지 요청 오류: 형식·없는 id는 404, 지운 카드는 사라진다, 도로 DB가 없으면 national 503', async () => {
    const e = await setup();
    await drive(e);
    const r = await create(e, { vehicleId: V, kind: 'national' });
    expect((await call(e, '/share/cards/nope.png')).status).toBe(404);
    expect((await call(e, '/share/cards/abcdefgh12345678.png')).status).toBe(404);
    expect((await call(e, `/share/cards/${r.body.id}.gif`)).status).toBe(404);
    expect((await call(e, `/share/cards/${r.body.id}`)).status).toBe(404);
    expect((await call(e, `/share/cards/${r.body.id}`, { method: 'DELETE' })).status).toBe(400);
    expect((await call(e, `/share/cards/${r.body.id}?vehicleId=other`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(e, `/share/cards/${r.body.id}?vehicleId=${V}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(e, `/share/cards/${r.body.id}.png`)).status).toBe(404);
    const noRoads = extApp({ roadsPath: null });
    expect((await create(noRoads, { vehicleId: V, kind: 'national' })).status).toBe(503);
  });

  it('카드 생성 횟수 제한(429)과 차량 데이터 삭제 시 카드도 삭제', async () => {
    const e = await setup({ ext: { rateLimit: { max: 1, windowMs: 60_000 } } });
    await drive(e);
    const r = await create(e, { vehicleId: V, kind: 'national' });
    expect(r.status).toBe(200);
    expect((await create(e, { vehicleId: V, kind: 'national' })).status).toBe(429);
    await call(e, `/vehicles/${V}/data`, { method: 'DELETE' });
    expect((await call(e, `/share/cards/${r.body.id}.svg`)).status).toBe(404);
  });

  it('공유 카드 조회는 토큰 없이 열리고(unguessable id), 생성은 required에서 차량 토큰이 필요하다', async () => {
    const e = await setup({ ext: { auth: 'required' } });
    const a = (await call(e, '/vehicles/register', post('', { vin: 'KMHABCDEF12345678' }))).body;
    expect((await create(e, { vehicleId: a.vehicleId, kind: 'national' })).status).toBe(401);
    const r = await create(e, { vehicleId: a.vehicleId, kind: 'national' }, bearer(a.vehicleToken));
    expect(r.status).toBe(200);
    expect((await call(e, `/share/cards/${r.body.id}.png`)).status).toBe(200);
  });
});
