import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { isFaded } from '../src/shared/fade.js';
import { classesForZ, maxSpanDeg, RATE_MAX, shapeFor, simplify } from '../src/routes/map.js';
import { initMapSchema } from '../src/db/schema-map.js';
import { driveTrip, FIXTURE_NORTH, ROADS_TEST_DB, fakeValhalla, getJson, json, makePoints, makeRoadsDb, newApp, REGIONS_TEST_DB } from './helpers.js';

const fixture = JSON.parse(readFileSync(FIXTURE_NORTH, 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-map-'));

describe('단순화·z별 등급 순수 함수', () => {
  it('Douglas-Peucker는 끝점을 지키고 오차 안의 점만 뺀다', () => {
    const line: [number, number][] = [[0, 0], [1, 0.0001], [2, 0], [3, 1], [4, 0]];
    expect(simplify(line, 0.01)).toEqual([[0, 0], [2, 0], [3, 1], [4, 0]]);
    expect(simplify(line, 0)).toEqual(line);
    expect(simplify([[0, 0], [1, 1]], 5)).toEqual([[0, 0], [1, 1]]);
  });
  it('shapeFor는 5자리로 반올림하고 점 2개 아래로 줄지 않는다', () => {
    const s = shapeFor([[126.97812345, 37.5], [126.97812346, 37.5000001]], 5);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual([126.97812, 37.5]);
  });
  it('z별 등급·bbox 상한은 계약서 값', () => {
    expect(classesForZ(8)).toEqual(['mw']);
    expect(classesForZ(10)).toEqual(['mw', 'pr']);
    expect(classesForZ(12)).toEqual(['mw', 'pr', 'sc']);
    expect(classesForZ(13)).toEqual(['mw', 'pr', 'sc', 'mn']);
    expect([8, 10, 12, 13].map(maxSpanDeg)).toEqual([3, 2, 0.5, 0.15]);
  });
});

describe('GET /map/base', () => {
  const setup = async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'roads.sqlite'), [
      { id: 1, roadKey: 'mw:1', highway: 'motorway', lengthM: 2000, at: [127.0, 37.5], name: '경부고속도로' },
      { id: 2, roadKey: 'nr:6', highway: 'primary', lengthM: 1000, at: [127.0, 37.501] },
      { id: 3, roadKey: 'nm:a:대로', highway: 'tertiary', lengthM: 800, at: [127.0, 37.502], name: '대로' },
      { id: 4, roadKey: 'nm:a:골목', highway: 'residential', lengthM: 300, at: [127.0, 37.503], name: '골목' },
      { id: 5, roadKey: 'nm:a:바깥', highway: 'primary', lengthM: 300, at: [128.5, 36.0], name: '바깥' },
      { id: 6, roadKey: 'unnamed:6', highway: 'residential', lengthM: 300, at: [127.0, 37.504] },
    ]);
    const db = openDb(':memory:');
    const app = createApp(db, { vehicleHmacKey: 'k', roadsPath, regionsPath: REGIONS_TEST_DB });
    return { app, db };
  };
  const BOX = '126.99,37.49,127.03,37.52'; // 한 변 0.04° (z13 이상 상한 0.15° 안)

  it('z13 이상은 이름 있는 way를 모두, 이름 없는 way·bbox 밖은 뺀다', async () => {
    const { app } = await setup();
    const { status, body } = await getJson(app, `/map/base?bbox=${BOX}&z=14`);
    expect(status).toBe(200);
    expect(body.z).toBe(14);
    expect(body.ways.map((w: { id: number }) => w.id)).toEqual([1, 2, 3, 4]); // 등급 순(mw·pr·sc·mn)
    expect(body.ways.map((w: { cls: string }) => w.cls)).toEqual(['mw', 'pr', 'sc', 'mn']);
    expect(body.ways[0].rk).toBe('mw:1');
    expect(body.ways[0].c[0]).toEqual([127, 37.5]);
    expect(body.ways[0].d).toBeUndefined(); // vehicleId 없으면 d 없음
    expect(body.attribution).toContain('OpenStreetMap');
  });

  it('z가 낮을수록 등급이 줄고 bbox 상한을 넘으면 400', async () => {
    const { app } = await setup();
    const at = async (z: number, bbox = BOX) => (await getJson(app, `/map/base?bbox=${bbox}&z=${z}`)).body.ways.map((w: { id: number }) => w.id);
    expect(await at(8)).toEqual([1]);
    expect(await at(10)).toEqual([1, 2]);
    expect(await at(12)).toEqual([1, 2, 3]);
    expect((await getJson(app, '/map/base?bbox=126,37,127.5,37.5&z=14')).body.error).toBe('invalid_bbox'); // 1.5° > 0.15°
    expect((await getJson(app, '/map/base?bbox=120,30,123,33&z=8')).status).toBe(200); // 3° <= 3°
    expect((await getJson(app, '/map/base?bbox=120,30,125,34&z=8')).body.error).toBe('invalid_bbox'); // 5° > 3°
    expect((await getJson(app, `/map/base?bbox=${BOX}&z=abc`)).body.error).toBe('invalid_z');
    expect((await getJson(app, '/map/base?bbox=1,2,3&z=10')).body.error).toBe('invalid_bbox');
    expect((await getJson(app, '/map/base?bbox=127,37,126,38&z=10')).body.error).toBe('invalid_bbox');
  });

  it('차량이 인정받은 way에만 d(at·cov)를 합치고 alias도 합친다', async () => {
    const { app, db } = await setup();
    const ins = db.prepare('INSERT INTO driven_ways VALUES (?,?,?,?,?,?,?)');
    ins.run('v1', 1, 0.8, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 't', '209901');
    ins.run('v1', 3, 1, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 't', '209901');
    ins.run('v2', 2, 1, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 't', '209901');
    db.prepare("INSERT INTO vehicle_alias VALUES ('u1', 'v1')").run();
    ins.run('u1', 4, 0.5, '2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 't', '209901');
    const { body } = await getJson(app, `/map/base?bbox=${BOX}&z=14&vehicleId=v1`);
    const d = Object.fromEntries(body.ways.map((w: { id: number; d?: unknown }) => [w.id, w.d]));
    expect(d[1]).toEqual({ at: '2026-02-01T00:00:00.000Z', cov: 0.8 });
    expect(d[2]).toBeUndefined(); // 다른 차량이 달린 길
    expect(d[3]).toEqual({ at: '2026-03-01T00:00:00.000Z', cov: 1 });
    expect(d[4]).toEqual({ at: '2026-04-01T00:00:00.000Z', cov: 0.5 }); // alias로 올린 트립
    // alias ID로 조회해도 같은 정본 기록
    const viaAlias = (await getJson(app, `/map/base?bbox=${BOX}&z=14&vehicleId=u1`)).body.ways.find((w: { id: number }) => w.id === 1);
    expect(viaAlias.d.cov).toBe(0.8);
  });

  it('도로 DB가 없으면 503', async () => {
    const app = newApp({ roadsPath: null });
    expect((await getJson(app, '/map/base?bbox=126,37,126.1,37.1&z=14')).status).toBe(503);
  });
});

describe('GET /map/regions', () => {
  it('bbox 한 변 상한 없이 시군구 칠(단계·인구감소·바램)을 단순화해 준다', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { vehicleHmacKey: 'k', roadsPath: null, regionsPath: REGIONS_TEST_DB, now: () => Date.parse('2026-11-11T00:00:00Z') });
    const all = (await getJson(app, '/map/regions?bbox=124,33,132,39&z=6&vehicleId=v1')).body;
    expect(all.regions.length).toBeGreaterThan(0);
    const jung = all.regions.find((r: { code: string }) => r.code === '11140');
    expect(jung.name).toBe('서울 중구');
    expect(jung.level).toBe(0);
    expect(jung.p[0][0].length).toBeGreaterThanOrEqual(4);
    const first = jung.p[0][0];
    expect(first[0]).toEqual(first.at(-1)); // 링이 닫혀 있다
    db.prepare("INSERT INTO visited_regions VALUES ('v1','11140',2,'2025-01-01T00:00:00.000Z','2025-02-01T00:00:00.000Z',1,1,0)").run();
    db.prepare("INSERT INTO visited_regions VALUES ('v1','11110',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',1,0,0)").run();
    const after = (await getJson(app, '/map/regions?bbox=124,33,132,39&z=6&vehicleId=v1')).body;
    const byCode = Object.fromEntries(after.regions.map((r: { code: string }) => [r.code, r]));
    expect(byCode['11140']).toMatchObject({ level: 2, faded: true }); // 마지막 통과가 365일을 넘음
    expect(byCode['11110']).toMatchObject({ level: 1, faded: false });
    expect((await getJson(app, '/map/regions?bbox=1,2&z=6')).body.error).toBe('invalid_bbox');
  });
});

describe('실시간 잠정 매칭과 GET /trips/:id/live', () => {
  const start = async (app: ReturnType<typeof newApp>, vehicleId = 'v1') => {
    const r = await app.request('/trips', json({ localId: crypto.randomUUID(), vehicleId, driverId: vehicleId, startedAt: '2026-11-09T00:00:00Z' }));
    return ((await r.json()) as { tripId: string }).tripId;
  };
  const post = (app: ReturnType<typeof newApp>, tripId: string, points: ReturnType<typeof makePoints>) =>
    app.request(`/trips/${tripId}/points`, json({ points }));
  // 세종대로 픽스처에서 잠정 기준(커버리지 0.5 또는 60m, 이름 있음)을 넘는 way
  const EXPECTED = [651229500, 788411950, 73541403, 1199229109, 474532059];

  it('점 업로드 뒤 잠정 way가 쌓이고 isNew·region이 붙으며 완료율·도감에는 안 들어간다', async () => {
    const fetchFn = fakeValhalla(() => fixture);
    const app = newApp({ liveMatching: true, valhalla: { fetchFn } });
    const tripId = await start(app);
    expect((await getJson(app, `/trips/${tripId}/live`)).body).toMatchObject({ status: 'idle', upToSeq: -1, ways: [] });
    await post(app, tripId, makePoints(30));
    await app.live.idle();
    const { status, body } = await getJson(app, `/trips/${tripId}/live`);
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.upToSeq).toBe(29);
    expect(body.ways.map((w: { id: number }) => w.id).sort((a: number, b: number) => a - b)).toEqual([...EXPECTED].sort((a, b) => a - b));
    expect(body.ways.every((w: { isNew: boolean }) => w.isNew)).toBe(true);
    expect(body.ways[0].c[0]).toHaveLength(2);
    expect(body.region).toEqual({ code: '11110', displayName: '서울 종로구', level: 0, firstTime: true }); // 마지막 점(광화문에서 북쪽 약 0.7km)의 시군구
    // 잠정 결과는 확정 기록이 아니다
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body).toMatchObject({ nationalPercent: 0, roadsStarted: 0 });
    expect((await getJson(app, '/regions/summary?vehicleId=v1')).body.colored).toBe(0);
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('디바운스: 바로 이어 온 점은 간격이 찰 때까지 묶이고, 다음 창은 앞 창과 겹쳐 보낸다', async () => {
    const fetchFn = fakeValhalla(() => fixture);
    const app = newApp({ liveMatching: true, valhalla: { fetchFn }, liveIntervalMs: 60_000 });
    const tripId = await start(app);
    const pts = makePoints(60);
    await post(app, tripId, pts.slice(0, 30));
    await app.live.idle();
    await post(app, tripId, pts.slice(30));
    await app.live.idle();
    expect(fetchFn.calls).toHaveLength(1); // 60초 안이라 두 번째 호출은 예약만
    // 뒤 가장자리 타이머만 걸린 대기는 '진행 중'이 아니다(status ready, e2e flaky 방지)
    expect(app.live.isBusy(tripId)).toBe(false);
    expect((await getJson(app, `/trips/${tripId}/live`)).body.status).toBe('ready');
    await app.live.flush(tripId);
    expect(fetchFn.calls).toHaveLength(2);
    expect(fetchFn.calls[1]!.body.shape).toHaveLength(10 + 30); // 겹침 10점 + 새 30점(seq 29 이후 20..29 + 30..59)
    expect((await getJson(app, `/trips/${tripId}/live`)).body.upToSeq).toBe(59);
    app.live.stop();
  });

  it('같은 차량이 확정 매칭으로 인정받은 way는 다음 트립에서 isNew=false', async () => {
    const app = newApp({ liveMatching: true, valhalla: { fetchFn: fakeValhalla(() => fixture) } });
    await driveTrip(app, { points: makePoints(30) });
    await app.matching.idle();
    const second = await start(app);
    await post(app, second, makePoints(30, 25, 37.5665, 126.978, 10));
    await app.live.idle();
    const { body } = await getJson(app, `/trips/${second}/live`);
    const isNew = Object.fromEntries(body.ways.map((w: { id: number; isNew: boolean }) => [w.id, w.isNew]));
    // 확정(커버리지 0.7·500m, 이름 있음)에서는 62m·67m·34m짜리 way만 인정된다
    expect(isNew[651229500]).toBe(false);
    expect(isNew[788411950]).toBe(false);
    expect(isNew[1199229109]).toBe(false);
    expect(isNew[73541403]).toBe(true);
    expect(isNew[474532059]).toBe(true);
    expect(body.region.level).toBeGreaterThan(0); // 이미 한 번 지난 시군구 → 처음이 아니다
    expect(body.region.firstTime).toBe(false);
  });

  it('끝난 트립에는 잠정 매칭을 돌리지 않고, 없는 트립은 404, 도로 DB·Valhalla가 없어도 점 업로드는 성공한다', async () => {
    const fetchFn = fakeValhalla(() => fixture);
    const app = newApp({ liveMatching: true, valhalla: { fetchFn } });
    await driveTrip(app, { points: makePoints(30) }); // 점 업로드 시점엔 아직 안 끝났으므로 한 번은 돈다
    await app.live.idle();
    const callsAfterDrive = fetchFn.calls.length;
    const trips = (await getJson(app, '/trips?vehicleId=v1')).body.trips;
    await post(app, trips[0].tripId, makePoints(5, 25, 37.57, 126.978));
    await app.live.idle();
    expect(fetchFn.calls.length).toBe(callsAfterDrive);
    expect((await getJson(app, '/trips/nope/live')).status).toBe(404);

    const noRoads = newApp({ liveMatching: true, roadsPath: null, valhalla: { fetchFn } });
    const t2 = await start(noRoads);
    expect((await post(noRoads, t2, makePoints(30))).status).toBe(200);
    await noRoads.live.idle();
    expect((await getJson(noRoads, `/trips/${t2}/live`)).body).toMatchObject({ status: 'idle', ways: [] });

    const down = newApp({ liveMatching: true, valhalla: { fetchFn: fakeValhalla(() => new Response('x', { status: 503 })) } });
    const t3 = await start(down);
    expect((await post(down, t3, makePoints(30))).status).toBe(200);
    await down.live.idle();
    expect((await getJson(down, `/trips/${t3}/live`)).body).toMatchObject({ status: 'idle', ways: [] });
  });
});

describe('지도 API 보강', () => {
  it('바램 판정은 now - lastAt > 365일(T2 isFaded와 같은 규칙)', () => {
    const now = Date.parse('2026-11-11T00:00:00Z');
    expect(isFaded(new Date(now - 365 * 86_400_000).toISOString(), now)).toBe(false);
    expect(isFaded(new Date(now - 365 * 86_400_000 - 1).toISOString(), now)).toBe(true);
    expect(isFaded('2025-01-01T00:00:00Z', now)).toBe(true);
  });

  it('트립을 지우면 잠정 행도 함께 지워진다(ON DELETE CASCADE)', async () => {
    const app = newApp({ liveMatching: true, valhalla: { fetchFn: fakeValhalla(() => fixture) } });
    const r = await app.request('/trips', json({ localId: 'x', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-09T00:00:00Z' }));
    const { tripId } = (await r.json()) as { tripId: string };
    await app.request(`/trips/${tripId}/points`, json({ points: makePoints(30) }));
    await app.live.idle();
    const db = (app as unknown as { db?: unknown }).db;
    expect(db).toBeUndefined(); // 앱은 DB를 노출하지 않으므로 별도 DB로 아래에서 확인한다
    const raw = openDb(':memory:');
    raw.prepare("INSERT INTO trips (id, vehicle_id, driver_id, started_at, created_at) VALUES ('t','v','v','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO trip_live VALUES ('t', 3, 'x')").run();
    raw.prepare("INSERT INTO trip_live_ways VALUES ('t', 1, 1)").run();
    raw.prepare("DELETE FROM trips WHERE id = 't'").run(); // FK가 걸려 있어도 실패하지 않는다
    expect(raw.prepare('SELECT COUNT(*) AS n FROM trip_live').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM trip_live_ways').get()).toEqual({ n: 0 });
  });

  it('CASCADE 없이 만들어진 옛 테이블은 행을 보존한 채 다시 만든다', () => {
    const raw = openDb(':memory:');
    raw.exec('DROP TABLE trip_live; DROP TABLE trip_live_ways;');
    raw.exec('CREATE TABLE trip_live (trip_id TEXT PRIMARY KEY REFERENCES trips (id), up_to_seq INTEGER NOT NULL, updated_at TEXT NOT NULL)');
    raw.exec('CREATE TABLE trip_live_ways (trip_id TEXT NOT NULL REFERENCES trips (id), way_id INTEGER NOT NULL, is_new INTEGER NOT NULL, PRIMARY KEY (trip_id, way_id))');
    raw.prepare("INSERT INTO trips (id, vehicle_id, driver_id, started_at, created_at) VALUES ('t','v','v','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO trip_live VALUES ('t', 3, 'x')").run();
    raw.prepare("INSERT INTO trip_live_ways VALUES ('t', 1, 1)").run();
    expect(() => raw.prepare("DELETE FROM trips WHERE id = 't'").run()).toThrow(); // 옛 테이블은 삭제가 막힌다
    initMapSchema(raw);
    initMapSchema(raw); // 다시 불러도 안전
    expect(raw.prepare('SELECT COUNT(*) AS n FROM trip_live_ways').get()).toEqual({ n: 1 });
    raw.prepare("DELETE FROM trips WHERE id = 't'").run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM trip_live').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM trip_live_ways').get()).toEqual({ n: 0 });
  });

  it('/map/regions: 인구감소지역 표시는 지역 DB와 같고 z·bbox 상한이 있다', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { vehicleHmacKey: 'k', roadsPath: null, regionsPath: REGIONS_TEST_DB });
    const { DatabaseSync } = await import('node:sqlite');
    const rg = new DatabaseSync(REGIONS_TEST_DB, { readOnly: true });
    const expected = new Map((rg.prepare('SELECT code, depop_92 FROM regions').all() as { code: string; depop_92: number }[]).map((r) => [r.code, r.depop_92 === 1]));
    const body = (await getJson(app, '/map/regions?bbox=124,33,132,39&z=6&vehicleId=v1')).body;
    for (const r of body.regions) expect(r.depop).toBe(expected.get(r.code));
    expect((await getJson(app, '/map/regions?bbox=124,33,132,39&z=16&vehicleId=v1')).body.z).toBe(13); // z는 13으로 맞춘다
    expect((await getJson(app, '/map/regions?bbox=100,20,140,50&z=6')).body.error).toBe('invalid_bbox');
  });

  const setupRoads = async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'roads.sqlite'), [
      { id: 1, roadKey: 'mw:1', highway: 'motorway', lengthM: 2000, at: [127.0, 37.5], name: '경부고속도로' },
      { id: 2, roadKey: 'nr:6', highway: 'primary_link', lengthM: 400, at: [127.0, 37.501], name: '램프' },
    ]);
    const db = openDb(':memory:');
    return { db, roadsPath, app: createApp(db, { vehicleHmacKey: 'k', roadsPath, regionsPath: REGIONS_TEST_DB }) };
  };

  it('연결로(_link)는 z13 이상에서 나오고 낮은 z에서는 빠진다', async () => {
    const { app } = await setupRoads();
    const ids = async (z: number) => (await getJson(app, `/map/base?bbox=126.99,37.49,127.03,37.52&z=${z}`)).body.ways.map((w: { id: number }) => w.id);
    expect(await ids(14)).toEqual([1, 2]);
    expect(await ids(12)).toEqual([1]);
  });

  it('도형은 서버에서 캐시하되 차량별 d는 매번 합친다', async () => {
    const { app, db } = await setupRoads();
    const q = (v: string) => getJson(app, `/map/base?bbox=126.99,37.49,127.03,37.52&z=14&vehicleId=${v}`);
    const a = await q('v1');
    db.prepare("INSERT INTO driven_ways VALUES ('v1',1,1,'2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z','t','209901')").run();
    const b = await q('v1'); // 캐시된 도형 위에 새로 달린 길 정보가 반영된다
    const other = await q('v2');
    expect(a.body.ways[0].d).toBeUndefined();
    expect(b.body.ways[0].d).toEqual({ at: '2026-02-01T00:00:00.000Z', cov: 1 });
    expect(other.body.ways[0].d).toBeUndefined();
    expect(b.body.ways[0].c).toEqual(a.body.ways[0].c);
  });

  it('요청 제한: 같은 차량이 창 안에 한도를 넘으면 429', async () => {
    const { app } = await setupRoads();
    let last = 200;
    for (let i = 0; i <= RATE_MAX; i++) last = (await app.request('/map/base?bbox=126.99,37.49,127.03,37.52&z=14&vehicleId=spam')).status;
    expect(last).toBe(429);
    expect((await app.request('/map/base?bbox=126.99,37.49,127.03,37.52&z=14&vehicleId=other')).status).toBe(200);
  });

  it('접근 확인 지점이 false면 403(인증 붙일 때 이 함수만 바꾼다)', async () => {
    const { mapRoutes } = await import('../src/routes/map.js');
    const { Hono } = await import('hono');
    const raw = openDb(':memory:');
    const hono = new Hono().route('/', mapRoutes(raw, () => null, () => null, undefined, Date.now, () => false));
    raw.prepare("INSERT INTO trips (id, vehicle_id, driver_id, started_at, created_at) VALUES ('t','v','v','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    expect((await hono.request('/trips/t/live')).status).toBe(403);
    expect((await hono.request('/map/regions?bbox=1,2,3,4&z=6&vehicleId=v')).status).toBe(503); // 지역 DB 없음이 먼저
  });

  it('/live?since=: 새 잠정 way만 주고 cursor로 이어 받으며, 잘못된 since는 400', async () => {
    const fetchFn = fakeValhalla(() => fixture);
    const app = newApp({ liveMatching: true, valhalla: { fetchFn }, liveIntervalMs: 60_000 });
    const r = await app.request('/trips', json({ localId: 'y', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-09T00:00:00Z' }));
    const { tripId } = (await r.json()) as { tripId: string };
    await app.request(`/trips/${tripId}/points`, json({ points: makePoints(30) }));
    await app.live.idle();
    const first = (await getJson(app, `/trips/${tripId}/live`)).body;
    expect(first.ways.length).toBe(5);
    expect(first.cursor).toBeGreaterThan(0);
    const again = (await getJson(app, `/trips/${tripId}/live?since=${first.cursor}`)).body;
    expect(again.ways).toEqual([]);
    expect(again.cursor).toBe(first.cursor);
    const partial = (await getJson(app, `/trips/${tripId}/live?since=${first.cursor - 2}`)).body;
    expect(partial.ways).toHaveLength(2);
    expect((await getJson(app, `/trips/${tripId}/live?since=abc`)).status).toBe(400);
    app.live.stop();
  });

  it('직전 트립의 확정 매칭이 안 끝났어도 그 트립의 잠정 way는 이미 달린 길이다', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { vehicleHmacKey: 'k', roadsPath: ROADS_TEST_DB, regionsPath: REGIONS_TEST_DB, liveMatching: true, valhalla: { fetchFn: fakeValhalla(() => fixture) } });
    // 직전 트립: 끝났고 확정 매칭은 아직 queued. 잠정으로 73541403(청계천로)를 칠했다.
    db.prepare("INSERT INTO trips (id, vehicle_id, driver_id, started_at, ended_at, created_at) VALUES ('prev','v1','v1','2026-11-08T00:00:00Z','2026-11-08T00:10:00Z','x')").run();
    db.prepare("INSERT INTO trip_live_ways VALUES ('prev', 73541403, 1)").run();
    db.prepare("INSERT INTO trip_matching (trip_id, status, queued_at) VALUES ('prev','queued','x')").run();
    const r = await app.request('/trips', json({ localId: 'z', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-10T00:00:00Z' }));
    const sid = ((await r.json()) as { tripId: string }).tripId;
    await app.request(`/trips/${sid}/points`, json({ points: makePoints(30, 25, 37.5665, 126.978, 10) }));
    await app.live.idle();
    const isNew = Object.fromEntries((await getJson(app, `/trips/${sid}/live`)).body.ways.map((w: { id: number; isNew: boolean }) => [w.id, w.isNew]));
    expect(isNew[73541403]).toBe(false); // 직전 트립이 잠정으로 칠한 길
    expect(isNew[474532059]).toBe(true);
    // 확정이 끝나면(done) 확정 기록(driven_ways)이 기준이 된다
    db.prepare("UPDATE trip_matching SET status = 'done' WHERE trip_id = 'prev'").run();
    db.prepare("DELETE FROM trip_live_ways WHERE trip_id = ?").run(sid);
    db.prepare("DELETE FROM trip_live WHERE trip_id = ?").run(sid);
    await app.live.flush(sid);
    const after = Object.fromEntries((await getJson(app, `/trips/${sid}/live`)).body.ways.map((w: { id: number; isNew: boolean }) => [w.id, w.isNew]));
    expect(after[73541403]).toBe(true);
    app.live.stop();
  });

  it('잠정 매칭을 켜도 확정 매칭 결과는 같다(잠정은 완료율·도감을 건드리지 않는다)', async () => {
    const run = async (liveMatching: boolean) => {
      const app = newApp({ liveMatching, valhalla: { fetchFn: fakeValhalla(() => fixture) } });
      const { tripId } = await driveTrip(app, { points: makePoints(30) });
      await app.matching.idle();
      await app.live.idle();
      const m = (await getJson(app, `/trips/${tripId}/matching`)).body;
      const regions = (await getJson(app, '/regions/summary?vehicleId=v1')).body;
      const cov = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
      const strip = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (k, v) => (k === 'ms' ? undefined : v)));
      return { result: strip(m.result), colored: regions.colored, pct: cov.nationalPercent, started: cov.roadsStarted };
    };
    const a = await run(true);
    const b = await run(false);
    expect(a).toEqual(b);
  });

  it('끝난 지 오래된 트립의 잠정 행은 정리하고 방금 끝난 트립은 남긴다', async () => {
    let t = Date.parse('2026-11-11T00:00:00Z');
    const app = newApp({ liveMatching: true, now: () => t, valhalla: { fetchFn: fakeValhalla(() => fixture) } });
    const r = await app.request('/trips', json({ localId: 'p', vehicleId: 'v1', driverId: 'v1', startedAt: '2026-11-10T00:00:00Z' }));
    const { tripId } = (await r.json()) as { tripId: string };
    await app.request(`/trips/${tripId}/points`, json({ points: makePoints(30) }));
    await app.live.idle();
    await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-10T00:10:00Z' }));
    expect(app.live.purge()).toBe(0); // 방금 끝난 트립은 남긴다
    t += 25 * 3_600_000;
    expect(app.live.purge()).toBe(1); // 종료가 24시간 넘게 지남
    expect((await getJson(app, `/trips/${tripId}/live`)).body.ways).toEqual([]);
  });
});
