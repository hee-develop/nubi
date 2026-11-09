import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { attachRoads } from '../src/roads/index.js';
import { driveTrip, fakeValhalla, getJson, makeRoadsDb, matchedResponse, newApp, type SynthWay } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nubi-test-'));

const W = (id: number, lengthM: number, roadKey: string, extra: Partial<SynthWay> = {}): SynthWay => ({
  id,
  roadKey,
  lengthM,
  highway: 'residential',
  ...extra,
});

/** 가짜 Valhalla가 돌려주는 way들을 한 번에 달린 것처럼 트립 하나를 매칭한다. */
const driveWays = async (app: ReturnType<typeof newApp>, vehicleId = 'v1') => {
  const { tripId } = await driveTrip(app, { vehicleId });
  await app.matching.idle();
  return tripId;
};

describe('조회 API', () => {
  it('summary: percent 계산·거리·완주/시작 수, 응답마다 snapshotMonth·attribution', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [
      W(1, 1000, 'nm:a'),
      W(2, 1000, 'nm:a', { at: [127.01, 37] }),
      W(3, 2000, 'nm:b', { at: [127.02, 37] }),
    ]);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 1, length: 1 },
              { way_id: 2, length: 1 },
              { way_id: 3, length: 0.8 },
            ],
            40,
          ),
        ),
      },
    });
    await driveWays(app);
    const { status, body } = await getJson(app, '/coverage/summary?vehicleId=v1');
    expect(status).toBe(200);
    expect(body).toMatchObject({ snapshotMonth: '209901', roadsStarted: 2, roadsCompleted: 1, totalKm: 4, drivenKm: 2.8 });
    expect(body.attribution).toContain('ODbL');
    expect(body.nationalPercent).toBe(70); // 2800 / 4000
    // 다른 차량은 0
    expect((await getJson(app, '/coverage/summary?vehicleId=other')).body).toMatchObject({ nationalPercent: 0, roadsStarted: 0 });
    expect((await getJson(app, '/coverage/summary')).status).toBe(400);
  });

  it('roads: sort percent|recent|length, limit·offset, 잘못된 sort는 400', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [
      W(1, 1000, 'nm:a'), // 1000 중 1000 → 100%
      W(2, 4000, 'nm:b', { at: [127.01, 37] }), // 4000 중 2000 → 50%
      W(3, 1000, 'nm:c', { at: [127.02, 37] }), // 1000 중 700 → 70%
    ]);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 1, length: 1 },
              { way_id: 2, length: 2 },
              { way_id: 3, length: 0.7 },
            ],
            40,
          ),
        ),
      },
    });
    await driveWays(app);
    const keys = async (qs: string) =>
      ((await getJson(app, `/coverage/roads?vehicleId=v1&${qs}`)).body.items as any[]).map((i) => i.roadKey);
    expect(await keys('sort=percent')).toEqual(['nm:a', 'nm:c', 'nm:b']);
    expect(await keys('sort=length')).toEqual(['nm:b', 'nm:a', 'nm:c']);
    expect(await keys('sort=recent')).toHaveLength(3);
    expect(await keys('sort=percent&limit=1&offset=1')).toEqual(['nm:c']);
    const page = (await getJson(app, '/coverage/roads?vehicleId=v1&limit=2')).body;
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ roadKey: 'nm:a', percent: 100, completed: true, drivenM: 1000, totalM: 1000 });
    expect(page.items[0].lastDrivenAt).toMatch(/^2026-/);
    expect(page.snapshotMonth).toBe('209901');
    expect((await getJson(app, '/coverage/roads?vehicleId=v1&sort=bogus')).status).toBe(400);
  });

  it('roads q: 표시 이름과 names(구간 거리명)를 함께 검색하고 검색어에 걸린 이름을 앞에 둔다', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [
      W(1, 1000, 'nr:31', { highway: 'primary', name: '녹사평대로' }),
      W(2, 1000, 'nr:31', { highway: 'primary', name: '세종대로', at: [127.01, 37] }),
      W(3, 1000, 'nm:을지로', { name: '을지로', at: [127.02, 37] }),
    ]);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 1, length: 1 },
              { way_id: 2, length: 1 },
              { way_id: 3, length: 1 },
            ],
            40,
          ),
        ),
      },
    });
    await driveWays(app);
    const byName = (await getJson(app, `/coverage/roads?vehicleId=v1&q=${encodeURIComponent('세종대로')}`)).body;
    expect(byName.total).toBe(1);
    expect(byName.items[0].roadKey).toBe('nr:31');
    expect(byName.items[0].names[0]).toBe('세종대로');
    expect(byName.items[0].names).toContain('녹사평대로');
    expect(byName.items[0].namesTotal).toBe(2); // names_json 전체 개수(응답 names는 최대 20개)
    const byDisplay = (await getJson(app, `/coverage/roads?vehicleId=v1&q=${encodeURIComponent('을지')}`)).body;
    expect(byDisplay.items.map((i: any) => i.roadKey)).toEqual(['nm:을지로']);
    // 와일드카드 문자는 문자 그대로 검색한다
    expect((await getJson(app, '/coverage/roads?vehicleId=v1&q=%25')).body.total).toBe(0);
    expect((await getJson(app, '/coverage/roads?vehicleId=v1&q=없는길')).body.items).toEqual([]);
  });

  it('segments: bbox 검증(필수·순서·한 변 ≤ 1도), 범위 안의 way만, GeoJSON 속성', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), [W(1, 500, 'nm:a', { name: 'a' }), W(2, 500, 'nm:b', { at: [128, 36] })]);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            [
              { way_id: 1, length: 0.5 },
              { way_id: 2, length: 0.5 },
            ],
            40,
          ),
        ),
      },
    });
    await driveWays(app);
    const seg = (bbox?: string) => getJson(app, `/coverage/segments?vehicleId=v1${bbox === undefined ? '' : `&bbox=${bbox}`}`);
    for (const bad of [undefined, '', '1,2,3', '127,37,126,38', '126,37,127,37', 'a,b,c,d', '126,37,127.5,37.5', '126,36,127,37.2']) {
      expect((await seg(bad)).status, String(bad)).toBe(400);
    }
    expect((await seg('126.9,36.9,127.1,37.1')).body.features).toHaveLength(1);
    const { status, body } = await seg('126.9,36.9,127.1,37.1');
    expect(status).toBe(200);
    expect(body).toMatchObject({ type: 'FeatureCollection', truncated: false, snapshotMonth: '209901' });
    expect(body.features[0].geometry.type).toBe('LineString');
    expect(body.features[0].properties).toMatchObject({ wayId: 1, roadKey: 'nm:a', displayName: 'a', coverage: 1 });
    expect((await seg('127.5,35.5,128.5,36.5')).body.features.map((f: any) => f.properties.wayId)).toEqual([2]);
    expect((await seg('126,36,126.9,36.9')).body.features).toHaveLength(0);
  });

  it('segments: 5,000개를 넘으면 잘라서 truncated: true', async () => {
    const ways = Array.from({ length: 5_001 }, (_, i) => W(i + 1, 10, `nm:r${i}`, { at: [127 + i * 0.00001, 37] }));
    const roadsPath = await makeRoadsDb(join(tmp(), 'r.sqlite'), ways);
    const app = newApp({
      roadsPath,
      valhalla: {
        fetchFn: fakeValhalla(() =>
          matchedResponse(
            ways.map((w) => ({ way_id: w.id, length: 0.01 })),
            40,
          ),
        ),
      },
    });
    await driveWays(app);
    const { body } = await getJson(app, '/coverage/segments?vehicleId=v1&bbox=126.9,36.9,127.5,37.5');
    expect(body.features).toHaveLength(5_000);
    expect(body.truncated).toBe(true);
  });

  it('도로 DB가 없으면 조회 API는 503', async () => {
    const app = newApp({ roadsPath: null });
    for (const p of ['/coverage/summary?vehicleId=v', '/coverage/roads?vehicleId=v', '/coverage/segments?vehicleId=v&bbox=126,36,127,37']) {
      const r = await getJson(app, p);
      expect(r.status, p).toBe(503);
      expect(r.body.attribution).toContain('OpenStreetMap');
    }
  });
});

describe('옛 스키마 도로 DB', () => {
  it('split_length_m 열이 없는 도로 DB는 쓰지 않고 조회 API는 503', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'old.sqlite'), [W(1, 1000, 'nm:a')]);
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(roadsPath);
    old.exec('ALTER TABLE roads DROP COLUMN split_length_m');
    old.close();
    const app = newApp({ roadsPath });
    const r = await getJson(app, '/coverage/summary?vehicleId=v');
    expect(r.status).toBe(503);
    expect(r.body.attribution).toContain('OpenStreetMap');
  });

  it('검사에 실패하면 ATTACH를 풀어 같은 연결에 도로 DB가 남지 않는다', async () => {
    const roadsPath = await makeRoadsDb(join(tmp(), 'old2.sqlite'), [W(1, 1000, 'nm:a')]);
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(roadsPath);
    old.exec('ALTER TABLE roads DROP COLUMN split_length_m');
    old.close();
    const db = openDb(':memory:');
    expect(attachRoads(db, roadsPath)).toBeNull();
    const names = (db.prepare('PRAGMA database_list').all() as { name: string }[]).map((d) => d.name);
    expect(names).not.toContain('rd');
  });
});

describe('뷰어', () => {
  it('GET /viewer 는 200과 MapLibre·OSM 출처가 든 HTML을 준다', async () => {
    const app = newApp();
    const res = await app.request('/viewer?vehicleId=v1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('maplibre-gl@');
    expect(html).toContain('tile.openstreetmap.org');
    expect(html).toContain('OpenStreetMap contributors');
    expect(html).toContain('/coverage/segments');
  });
});
