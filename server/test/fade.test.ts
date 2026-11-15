import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFaded } from '../src/shared/fade.js';
// @ts-expect-error 타입 선언이 없는 .mjs
import { recompute } from '../../scripts/recompute-coverage.mjs';
import { extApp } from './ext-helpers.js';
import { driveTrip, fakeValhalla, getJson, json, makePoints, makeRoadsDb, matchedResponse, newApp, type SynthWay } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));
const W = (id: number, lengthM: number, roadKey: string, extra: Partial<SynthWay> = {}): SynthWay => ({ id, roadKey, lengthM, highway: 'residential', ...extra });
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-12T00:00:00Z');

describe('isFaded', () => {
  it('365일이 지나야 true이고 시각을 못 읽으면 false', () => {
    const now = Date.parse('2026-11-12T00:00:00Z');
    expect(isFaded(new Date(now - 364 * DAY).toISOString(), now)).toBe(false);
    expect(isFaded(new Date(now - 365 * DAY).toISOString(), now)).toBe(false); // 정확히 365일은 아직
    expect(isFaded(new Date(now - 365 * DAY - 1).toISOString(), now)).toBe(true);
    expect(isFaded('2020-01-01T00:00:00Z', now, 30)).toBe(true);
    expect(isFaded(null, now)).toBe(false);
    expect(isFaded('쓰레기', now)).toBe(false);
  });
});

/** way 1(1000m)·2(1000m) 두 개, 서울 중구 부근을 달린 차량 하나. */
const setup = async (extra: { debug?: boolean } = {}) => {
  const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 1000, 'nm:a'), W(2, 1000, 'nm:a', { at: [127.01, 37] }), W(3, 5000, 'nm:b', { at: [127.02, 37] })]);
  const clock = { t: T0 };
  const app = newApp({
    roadsPath,
    now: () => clock.t,
    ext: { debug: extra.debug ?? true },
    valhalla: { fetchFn: fakeValhalla(() => matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 1 }, { way_id: 3, length: 0.9 }], 40)) },
  });
  return { app, clock, roadsPath };
};
const drive = async (app: ReturnType<typeof newApp>, day = 9, vehicleId = 'v1') => {
  await driveTrip(app, { vehicleId, points: makePoints(40, 25, 37.5665, 126.978, day) });
  await app.matching.idle();
};

describe('바램', () => {
  it('segments·regions/list·regions/geo에 faded가 붙고 debug/age로 당기면 true, 완료율·등급은 그대로', async () => {
    const { app, clock } = await setup();
    await drive(app);
    const seg = async () => (await getJson(app, '/coverage/segments?vehicleId=v1&bbox=126.9,36.9,127.2,37.2')).body.features as any[];
    expect((await seg()).length).toBe(3);
    expect((await seg()).every((f) => f.properties.faded === false)).toBe(true);
    const before = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
    const listBefore = (await getJson(app, '/regions/list?vehicleId=v1&filter=all')).body.items as any[];
    expect(listBefore.find((i) => i.level > 0)).toMatchObject({ faded: false });

    const age = await app.request('/debug/age', json({ vehicleId: 'v1', days: 400 }));
    expect(age.status).toBe(200);
    expect(await age.json()).toMatchObject({ ok: true, ways: 3 });
    expect((await seg()).every((f) => f.properties.faded === true)).toBe(true);
    const list = (await getJson(app, '/regions/list?vehicleId=v1&filter=all')).body.items as any[];
    const colored = list.filter((i) => i.level > 0);
    expect(colored.length).toBeGreaterThan(0);
    expect(colored.every((i) => i.faded === true)).toBe(true);
    expect(list.filter((i) => i.level === 0).every((i) => i.faded === false)).toBe(true); // 안 간 곳은 바랜 것이 아니다
    const geo = (await getJson(app, '/regions/geo?vehicleId=v1&bbox=126.9,37.4,127.2,37.7')).body.features as any[];
    expect(geo.find((f) => f.properties.level > 0).properties.faded).toBe(true);
    // 등급·완료율은 바래도 그대로
    const after = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
    expect(after.nationalPercent).toBe(before.nationalPercent);
    expect(after.roadsStarted).toBe(before.roadsStarted);
    expect(colored.map((i) => i.level)).toEqual(listBefore.filter((i) => i.level > 0).map((i) => i.level));
    // 시계가 흐르면(now) 안 당겨도 바랜다
    clock.t = T0 + 400 * DAY;
    expect((await getJson(app, '/regions/list?vehicleId=v1')).body.items.some((i: any) => i.faded)).toBe(true);
  });

  it('다시 달려 바램이 풀리면 되살린 거리(revivedKm)에 누적되고 완료율은 늘지 않는다', async () => {
    const { app } = await setup();
    await drive(app);
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body.revivedKm).toBe(0);
    const pct = (await getJson(app, '/coverage/summary?vehicleId=v1')).body.nationalPercent;
    await app.request('/debug/age', json({ vehicleId: 'v1', days: 400 }));
    await drive(app, 10); // 다시 달림
    const s = (await getJson(app, '/coverage/summary?vehicleId=v1')).body;
    expect(s.revivedKm).toBe(2.9); // 다시 달린 커버리지만: 1000 + 1000 + 5000m x 0.18(900m 매칭)
    expect(s.nationalPercent).toBe(pct);
    const seg = (await getJson(app, '/coverage/segments?vehicleId=v1&bbox=126.9,36.9,127.2,37.2')).body.features as any[];
    expect(seg.every((f) => f.properties.faded === false)).toBe(true); // 바램이 풀렸다
    // 같은 길을 또 달려도(바랜 적 없음) 늘지 않는다
    await drive(app, 11);
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body.revivedKm).toBe(2.9);
    // 364일만 당기면 바랜 것이 아니므로 되살림도 없다
    await app.request('/debug/age', json({ vehicleId: 'v1', days: 300 }));
    await drive(app, 12);
    expect((await getJson(app, '/coverage/summary?vehicleId=v1')).body.revivedKm).toBe(2.9);
    // 다른 차량은 0
    expect((await getJson(app, '/coverage/summary?vehicleId=v2')).body.revivedKm).toBe(0);
  });

  it('debug/age 입력 검증(400, 입력을 되돌려 주지 않음)과 production(debug=false)에서는 라우트가 없다', async () => {
    const { app } = await setup();
    for (const body of [{}, { vehicleId: 'v1' }, { vehicleId: 'v1', days: 0 }, { vehicleId: 'v1', days: -3 }, { vehicleId: 'v1', days: 1.5 }, { vehicleId: '', days: 3 }, { vehicleId: 'v1', days: 99999 }]) {
      const res = await app.request('/debug/age', json(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect((await app.request('/debug/age', { method: 'POST', body: '{깨짐' })).status).toBe(400);
    const prod = await setup({ debug: false });
    expect((await prod.app.request('/debug/age', json({ vehicleId: 'v1', days: 400 }))).status).toBe(404);
  });
});

describe('filter=almost(거의 다 달린 도로)', () => {
  it('완주율 80% 이상 95% 미만만 나오고 q와 함께 쓸 수 있다, 잘못된 값은 400', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [
      W(1, 1000, 'nm:full'), // 100%
      W(2, 1000, 'nm:almost', { at: [127.01, 37] }), // 90%
      W(3, 1000, 'nm:low', { at: [127.02, 37] }), // 50%
      W(4, 1000, 'nm:edge80', { at: [127.03, 37] }), // 80%
      W(5, 1000, 'nm:edge95', { at: [127.04, 37] }), // 95%(완주)
    ]);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse([{ way_id: 1, length: 1 }, { way_id: 2, length: 0.9 }, { way_id: 3, length: 0.5 }, { way_id: 4, length: 0.8 }, { way_id: 5, length: 0.95 }], 40),
        ),
      },
    });
    await driveTrip(app);
    await app.matching.idle();
    const keys = async (q: string) => ((await getJson(app, `/coverage/roads?vehicleId=v1&${q}`)).body.items as any[]).map((i) => i.roadKey).sort();
    expect(await keys('filter=almost')).toEqual(['nm:almost', 'nm:edge80']);
    expect((await getJson(app, '/coverage/roads?vehicleId=v1&filter=almost')).body.total).toBe(2);
    expect(await keys('filter=almost&q=edge')).toEqual(['nm:edge80']);
    expect(await keys('filter=all')).toHaveLength(5);
    expect((await getJson(app, '/coverage/roads?vehicleId=v1&filter=nope')).status).toBe(400);
  });
});

describe('월간 재계산 스크립트', () => {
  it('새 도로 DB 기준 차량별 집계가 API와 같고, 기본은 읽기만 하며 --apply가 스냅샷을 남긴다', async () => {
    const { app } = await setup();
    await drive(app);
    const dbPath = join(tmp(), 'u.sqlite');
    // 인메모리 앱 DB의 기록을 파일로 옮긴 뒤(스크립트는 파일 DB를 연다) 새 도로 DB(way 3 사라짐)를 붙여 계산한다.
    const user = new DatabaseSync(dbPath);
    user.exec('CREATE TABLE driven_ways (vehicle_id TEXT NOT NULL, way_id INTEGER NOT NULL, coverage REAL NOT NULL, first_driven_at TEXT NOT NULL, last_driven_at TEXT NOT NULL, trip_id_first TEXT NOT NULL, snapshot_month TEXT NOT NULL, PRIMARY KEY (vehicle_id, way_id))');
    user.exec('CREATE TABLE vehicle_alias (alias_id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL)');
    user.exec("INSERT INTO driven_ways VALUES ('v1', 1, 1, 'a', 'b', 't', '209901'), ('v1', 2, 1, 'a', 'b', 't', '209901'), ('v1', 3, 0.9, 'a', 'b', 't', '209901'), ('u1', 2, 1, 'a', 'b', 't', '209901')");
    user.exec("INSERT INTO vehicle_alias VALUES ('u1', 'v1')");
    const newRoads = await makeRoadsDb(join(tmp(), 'new.sqlite'), [W(1, 1000, 'nm:a'), W(2, 1000, 'nm:a', { at: [127.01, 37] }), W(9, 3000, 'nm:z', { at: [127.5, 37] })], '210001');
    user.exec(`ATTACH DATABASE '${pathToFileURL(newRoads).href}?mode=ro' AS rd`);
    const total = (user.prepare('SELECT total_named_length_m AS t FROM rd.snapshot').get() as { t: number }).t;
    const dry = recompute(user, { month: '210001', totalNamedLengthM: total });
    expect(dry).toEqual([
      expect.objectContaining({ vehicleId: 'v1', drivenM: 2000, totalM: 5000, percent: 40, roadsStarted: 1, roadsCompleted: 1, missingWays: 1, previous: null }),
    ]);
    expect(user.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'coverage_snapshots'").get()).toEqual({ n: 0 }); // 기본은 쓰지 않는다
    expect(user.prepare("SELECT COUNT(*) AS n FROM driven_ways WHERE snapshot_month = '210001'").get()).toEqual({ n: 0 });
    recompute(user, { month: '210001', totalNamedLengthM: total, apply: true, now: new Date('2026-12-01T00:00:00Z') });
    expect(user.prepare('SELECT vehicle_id, month, driven_m, percent, missing_ways FROM coverage_snapshots').all()).toEqual([
      { vehicle_id: 'v1', month: '210001', driven_m: 2000, percent: 40, missing_ways: 1 },
    ]);
    // 새 DB에 있는 way만 새 달로 맞추고 사라진 way(3)는 지우지 않는다
    expect(user.prepare("SELECT way_id FROM driven_ways WHERE snapshot_month = '210001' ORDER BY way_id").all()).toEqual([{ way_id: 1 }, { way_id: 2 }, { way_id: 2 }]);
    expect(user.prepare('SELECT COUNT(*) AS n FROM driven_ways WHERE way_id = 3').get()).toEqual({ n: 1 });
    user.close();
  });
});

describe('되살린 거리 트리거(DB)', () => {
  const ins = (db: any, v: string, way: number, cov: number, last: string) =>
    db
      .prepare("INSERT INTO driven_ways VALUES (?, ?, ?, ?, ?, 't', '209901') ON CONFLICT (vehicle_id, way_id) DO UPDATE SET coverage = MAX(coverage, excluded.coverage), last_driven_at = MAX(last_driven_at, excluded.last_driven_at)")
      .run(v, way, cov, last, last);
  const rows = (db: any) => db.prepare('SELECT vehicle_id, way_id, cov FROM way_revived ORDER BY id').all();

  it('같은 차량의 alias 행이 오래됐고 정본 ID로 새 행이 INSERT되면 되살림, 최근 alias 행이 있으면 아니다. 같은 갱신을 되풀이해도 중복 없음', () => {
    const e = extApp();
    e.db.prepare("INSERT INTO vehicle_alias VALUES ('uuid-old', 'v-main')").run();
    ins(e.db, 'uuid-old', 1, 1, '2024-01-01T00:00:00.000Z'); // 옛 기록(alias로 올림)
    ins(e.db, 'v-main', 1, 0.8, '2026-11-01T00:00:00.000Z'); // 정본 ID의 새 행(INSERT 경로) → 되살림
    expect(rows(e.db)).toEqual([{ vehicle_id: 'v-main', way_id: 1, cov: 0.8 }]);
    ins(e.db, 'v-main', 1, 0.8, '2026-11-01T00:00:00.000Z'); // 같은 값 되풀이: last 증가 없음 → 중복 없음
    ins(e.db, 'v-main', 1, 0.9, '2026-11-02T00:00:00.000Z'); // 하루 뒤: 이전 마지막이 최근이라 되살림 아님
    expect(rows(e.db)).toHaveLength(1);
    // 최근 alias 행이 있으면 정본 행이 오래돼도 되살림이 아니다
    ins(e.db, 'uuid-old', 2, 1, '2026-10-20T00:00:00.000Z');
    ins(e.db, 'v-main', 2, 1, '2026-11-02T00:00:00.000Z');
    expect(rows(e.db)).toHaveLength(1);
    // 다른 차량의 오래된 행은 상관없다
    ins(e.db, 'other', 3, 1, '2023-01-01T00:00:00.000Z');
    ins(e.db, 'v-main', 3, 1, '2026-11-02T00:00:00.000Z');
    expect(rows(e.db)).toHaveLength(1);
  });

  it('UPDATE 경로: 정본 행이 최근이어도 alias 행이 더 최근이면 되살림 아님, 365일 넘게 비었다 돌아오면 한 번만', () => {
    const e = extApp();
    e.db.prepare("INSERT INTO vehicle_alias VALUES ('uuid-old', 'v-main')").run();
    ins(e.db, 'v-main', 1, 1, '2024-01-01T00:00:00.000Z');
    ins(e.db, 'uuid-old', 1, 1, '2026-10-30T00:00:00.000Z'); // alias가 최근에 달림(INSERT, 같은 차량의 기존 행이 오래됨 → 되살림 1건)
    const before = rows(e.db).length;
    ins(e.db, 'v-main', 1, 1, '2026-11-01T00:00:00.000Z'); // 정본 행 갱신: 직전 최댓값(alias 10-30)이 최근이라 되살림 아님
    expect(rows(e.db)).toHaveLength(before);
  });
});
