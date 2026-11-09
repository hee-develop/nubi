import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// 도로 DB 규칙(사양 3-2·6-1·6-3). 빌드 스크립트가 쓰는 모듈을 그대로 검증한다.
// @ts-expect-error 타입 선언이 없는 .mjs
import {
  classify,
  effLength,
  isSplitWay,
  MAX_STORED_NAMES,
  normalize,
  onewayValue,
  RoadAccumulator,
  wayRecord,
} from '../../scripts/road-rules.mjs';
import { makeRoadsDb } from './helpers.js';

describe('classify (사양 6-1)', () => {
  const c = (tags: Record<string, string>, id = 1) => classify(tags, id);

  it('ref가 있는 고속·국도·지방도는 번호 키, 표시 이름 규칙', () => {
    expect(c({ highway: 'motorway', ref: '1', name: '경부고속도로' })).toEqual({ key: 'mw:1', display: '경부고속도로' });
    expect(c({ highway: 'motorway_link', ref: '1' })).toEqual({ key: 'mw:1', display: '고속도로 1' });
    expect(c({ highway: 'trunk', ref: '31', name: '세종대로' })).toEqual({ key: 'nr:31', display: '국도 31호선' });
    expect(c({ highway: 'primary_link', ref: '6' }).key).toBe('nr:6');
    expect(c({ highway: 'secondary', ref: '7' })).toEqual({ key: 'lr:7', display: '지방도 7호선' });
    expect(c({ highway: 'tertiary', ref: '7' }).key).toBe('lr:7');
  });

  it('ref는 `;` 앞 첫 값만 쓰고, unclassified·residential의 ref는 무시하고 이름 규칙으로 간다', () => {
    expect(c({ highway: 'primary', ref: '3;4' }).key).toBe('nr:3');
    expect(c({ highway: 'residential', ref: '99', name: '중앙로' })).toEqual({ key: 'nm:중앙로', display: '중앙로' });
    expect(c({ highway: 'unclassified', ref: '99' }).key).toBe('unnamed:1');
  });

  it('이름 정규화: 공백 제거·전각→반각, 둘 다 없으면 unnamed', () => {
    expect(normalize(' 세종 대로 ')).toBe('세종대로');
    expect(normalize('ＡＢＣ １２')).toBe('ABC12');
    expect(c({ highway: 'residential', name: '세종 대로' }).key).toBe('nm:세종대로');
    expect(c({ highway: 'residential' }, 77)).toEqual({ key: 'unnamed:77', display: null });
  });
});

describe('oneway·유효 길이 (사양 3-2·6-3)', () => {
  it('yes·-1은 일방통행, motorway(_link)는 태그가 없어도 암묵 일방통행, 명시적 no는 암묵보다 우선', () => {
    expect(onewayValue({ highway: 'primary', oneway: 'yes' })).toBe('yes');
    expect(onewayValue({ highway: 'primary', oneway: '-1' })).toBe('-1');
    expect(onewayValue({ highway: 'motorway' })).toBe('implicit');
    expect(onewayValue({ highway: 'motorway_link' })).toBe('implicit');
    expect(onewayValue({ highway: 'motorway', oneway: 'no' })).toBe('no');
    expect(onewayValue({ highway: 'trunk' })).toBeNull();
    expect(onewayValue({ highway: 'primary', oneway: 'reversible' })).toBe('reversible');
  });

  it('분리 구간은 주요 4등급(+link)의 일방통행뿐이고 유효 길이를 1/2로 센다', () => {
    for (const highway of ['motorway', 'trunk', 'primary', 'secondary', 'trunk_link', 'secondary_link'])
      expect(isSplitWay({ highway, oneway: 'yes' }), highway).toBe(true);
    expect(isSplitWay({ highway: 'primary', oneway: '-1' })).toBe(true);
    expect(isSplitWay({ highway: 'motorway' })).toBe(true); // 암묵
    expect(isSplitWay({ highway: 'motorway_link' })).toBe(true);
    for (const highway of ['tertiary', 'tertiary_link', 'unclassified', 'residential'])
      expect(isSplitWay({ highway, oneway: 'yes' }), highway).toBe(false);
    expect(isSplitWay({ highway: 'primary' })).toBe(false); // 태그 없는 primary는 양방향
    expect(isSplitWay({ highway: 'primary', oneway: 'no' })).toBe(false);
    expect(isSplitWay({ highway: 'primary', oneway: 'reversible' })).toBe(false);
    expect(effLength({ highway: 'primary', oneway: 'yes' }, 1000)).toBe(500);
    expect(effLength({ highway: 'motorway' }, 1000)).toBe(500);
    expect(effLength({ highway: 'tertiary', oneway: 'yes' }, 1000)).toBe(1000);
    expect(effLength({ highway: 'primary' }, 1000)).toBe(1000);
  });

  it('wayRecord는 좌표에서 길이·bbox를 구하고 분리 구간 표시를 담는다', () => {
    const r = wayRecord(5, { highway: 'trunk', ref: '1', oneway: 'yes' }, [
      [127, 37],
      [127, 37.01],
    ]);
    expect(r).toMatchObject({ id: 5, key: 'nr:1', oneway: 'yes', split: true, minlon: 127, maxlat: 37.01 });
    expect(r.len).toBeGreaterThan(1100);
    expect(r.len).toBeLessThan(1120);
    expect(r.eff).toBeCloseTo(r.len / 2, 6);
  });
});

describe('roads 집계 (names_json·묶음 상한 열)', () => {
  const rec = (id: number, tags: Record<string, string>, lenM: number) => {
    const r = wayRecord(id, tags, [
      [127, 37],
      [127.001, 37],
    ]);
    r.len = lenM;
    r.eff = tags.oneway === 'yes' ? lenM / 2 : lenM;
    return r;
  };

  it('names_json은 name 길이 순 상위 200개, split_length_m은 분리 구간의 유효 길이 합', () => {
    const acc = new RoadAccumulator();
    for (let i = 1; i <= 250; i++) acc.add(rec(i, { highway: 'primary', ref: '5', name: `거리${i}` }, i)); // 길수록 앞
    acc.add(rec(1000, { highway: 'primary', ref: '5', oneway: 'yes' }, 400));
    const [road] = acc.rows();
    const names = JSON.parse(road.names_json) as string[];
    expect(road.road_key).toBe('nr:5');
    expect(names).toHaveLength(MAX_STORED_NAMES);
    expect(names[0]).toBe('거리250');
    expect(names.at(-1)).toBe('거리51');
    expect(road.way_count).toBe(251);
    expect(road.split_length_m).toBe(200);
    expect(road.total_length_m).toBe((250 * 251) / 2 + 200);
  });

  it('합성 DB(helpers)도 같은 규칙으로 roads.split_length_m·총길이를 만든다', async () => {
    const path = await makeRoadsDb(join(mkdtempSync(join(tmpdir(), 'nubi-rules-')), 'r.sqlite'), [
      { id: 1, roadKey: 'nr:9', lengthM: 1000, highway: 'primary', oneway: 'yes' },
      { id: 2, roadKey: 'nr:9', lengthM: 1000, highway: 'primary', oneway: '-1' },
      { id: 3, roadKey: 'nr:9', lengthM: 600, highway: 'primary' },
      { id: 4, roadKey: 'mw:1', lengthM: 800, highway: 'motorway' }, // 암묵 oneway
    ]);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('SELECT road_key, total_length_m AS t, split_length_m AS s FROM roads ORDER BY road_key').all();
    expect(rows.map((r: any) => ({ ...r }))).toEqual([
      { road_key: 'mw:1', t: 400, s: 400 },
      { road_key: 'nr:9', t: 1600, s: 1000 },
    ]);
    db.close();
  });
});
