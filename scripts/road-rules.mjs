// 도로 DB 규칙(사양 02 3-2·6-1·6-3). 빌드 스크립트(build-road-db.mjs)와 서버 테스트 도구(server/test/helpers.ts)가 함께 쓴다.
// 규칙을 한 곳에만 두려고 분리했다. 외부 의존성 없음.

export const HIGHWAYS = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
];

/** 분리 차로를 1/2로 세는 주요 4등급(+link, 사양 6-3). tertiary 이하의 일방통행은 짝이 없는 경우가 많아 1배로 센다. */
export const HALF_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
export const RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6 };
/** roads.names_json에 저장하는 거리명 개수(길이 순 상위). */
export const MAX_STORED_NAMES = 200;

export const majorOf = (highway) => highway.replace(/_link$/, '');
export const normalize = (s) => s.normalize('NFKC').replace(/\s+/g, '');

/**
 * 도로 키·표시 이름(사양 02 6-1, 사양 03 1·3장 지역 접두).
 * [region]: `undefined`면 지역 접두를 쓰지 않는 옛 규칙(`nm:{name}`, `lr:{ref}`), `null`이면 지역을 알 수 없어 접두 `00`,
 * `{ sgg, sggDisplay, sido, sidoShort }`이면 `nm:{sgg}:{name}`(표시 "{시군구 표시 이름} {도로명}", 예 "서울 중구 세종대로")·`lr:{sido}:{ref}`(표시 "{시도 단축명} 지방도 {ref}호선").
 * 고속도로(`mw:`)·국도(`nr:`)는 전국 단일 키라 지역과 무관하다.
 */
export function classify(tags, wayId, region) {
  const major = majorOf(tags.highway);
  const ref = tags.ref ? tags.ref.split(';')[0].trim() : '';
  const name = tags.name ? tags.name.trim() : '';
  if (ref && major === 'motorway') return { key: `mw:${normalize(ref)}`, display: name || `고속도로 ${ref}` };
  if (ref && (major === 'trunk' || major === 'primary')) return { key: `nr:${normalize(ref)}`, display: `국도 ${ref}호선` };
  if (ref && (major === 'secondary' || major === 'tertiary')) {
    if (region === undefined) return { key: `lr:${normalize(ref)}`, display: `지방도 ${ref}호선` };
    if (region === null) return { key: `lr:${NO_REGION}:${normalize(ref)}`, display: `지방도 ${ref}호선` };
    return { key: `lr:${region.sido}:${normalize(ref)}`, display: `${region.sidoShort} 지방도 ${ref}호선` };
  }
  // ref가 있어도 위 등급이 아니면(unclassified·residential) 이름 규칙으로 넘어간다
  if (name) {
    if (region === undefined) return { key: `nm:${normalize(name)}`, display: name };
    if (region === null) return { key: `nm:${NO_REGION}:${normalize(name)}`, display: name };
    return { key: `nm:${region.sgg}:${normalize(name)}`, display: `${region.sggDisplay} ${name}` };
  }
  return { key: `unnamed:${wayId}`, display: null };
}

/** 시군구를 못 찾은 way(바다·경계 밖)의 접두. */
export const NO_REGION = '00';

/** way의 시군구를 찾는 점: 중간 정점 → 처음 → 끝 순으로 [locate](lon, lat) → 지역|null 을 시도한다. */
export function locateWay(coords, locate) {
  const mid = coords[Math.floor(coords.length / 2)];
  return locate(mid[0], mid[1]) ?? locate(coords[0][0], coords[0][1]) ?? locate(coords.at(-1)[0], coords.at(-1)[1]) ?? null;
}

/**
 * oneway 판정(사양 3-2): `oneway=yes` 또는 `-1`이면 일방통행. `motorway`·`motorway_link`는 태그가 없어도 일방통행(OSM 기본값).
 * 명시적 `oneway=no`는 암묵 규칙보다 우선한다. 그 밖의 값(reversible 등)은 일방통행으로 보지 않는다.
 * @returns {string | null} DB에 저장할 값: 'yes' | '-1' | 'implicit'(motorway 암묵) | 태그 원문 | null
 */
export function onewayValue(tags) {
  const t = tags.oneway;
  if (t === 'yes' || t === '-1') return t;
  if (t === undefined && majorOf(tags.highway) === 'motorway') return 'implicit';
  return t ?? null;
}

/** 일방통행으로 판정된 값인지(`onewayValue`의 결과를 받는다). */
export const isOnewayValue = (v) => v === 'yes' || v === '-1' || v === 'implicit';

/** 분리 구간 묶음에 드는 way인지: 주요 4등급(+link)이면서 일방통행. */
export const isSplitWay = (tags) => HALF_CLASSES.has(majorOf(tags.highway)) && isOnewayValue(onewayValue(tags));

/** 총길이·분모에 세는 유효 길이: 분리 구간은 1/2, 나머지는 그대로. */
export const effLength = (tags, lengthM) => (isSplitWay(tags) ? lengthM / 2 : lengthM);

const R = 6371008.8;
const rad = Math.PI / 180;
export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * rad,
    dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** way 하나의 DB 행 값. [coords]는 [lon, lat] 열. [keyOverride]는 테스트가 도로 키를 직접 정할 때만 쓴다. [region]은 [classify] 참고. */
export function wayRecord(id, tags, coords, keyOverride, region) {
  let len = 0,
    minlon = 181,
    minlat = 91,
    maxlon = -181,
    maxlat = -91;
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = coords[i];
    if (x < minlon) minlon = x;
    if (x > maxlon) maxlon = x;
    if (y < minlat) minlat = y;
    if (y > maxlat) maxlat = y;
    if (i) len += haversine(coords[i - 1], coords[i]);
  }
  const c = classify(tags, id, region);
  const key = keyOverride ?? c.key;
  const display = keyOverride ? (keyOverride.startsWith('unnamed:') ? null : keyOverride.replace(/^\w+:/, '')) : c.display;
  const eff = effLength(tags, len);
  return {
    id,
    key,
    display,
    highway: tags.highway,
    major: majorOf(tags.highway),
    name: tags.name ?? null,
    ref: tags.ref ?? null,
    oneway: onewayValue(tags),
    split: isSplitWay(tags),
    len,
    eff,
    minlon,
    minlat,
    maxlon,
    maxlat,
    geomJson: JSON.stringify(coords),
  };
}

export const SCHEMA_SQL = `
CREATE TABLE ways(way_id INTEGER PRIMARY KEY, road_key TEXT NOT NULL, highway TEXT NOT NULL, name TEXT, ref TEXT,
  length_m REAL NOT NULL, oneway TEXT, eff_length_m REAL NOT NULL, minlon REAL, minlat REAL, maxlon REAL, maxlat REAL, geom_json TEXT NOT NULL);
CREATE INDEX ways_road_key ON ways(road_key);
CREATE VIRTUAL TABLE ways_rtree USING rtree(way_id, minlon, maxlon, minlat, maxlat);
CREATE TABLE roads(road_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, highway_major TEXT NOT NULL,
  total_length_m REAL NOT NULL, split_length_m REAL NOT NULL, way_count INTEGER NOT NULL, names_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE snapshot(month TEXT PRIMARY KEY, built_at TEXT NOT NULL, pbf_name TEXT NOT NULL, pbf_timestamp TEXT,
  total_named_length_m REAL NOT NULL, total_all_length_m REAL NOT NULL, by_class_json TEXT NOT NULL, regions_month TEXT);
`;

/** way 행 삽입 쿼리의 열 순서에 맞는 값 배열. */
export const wayRowValues = (w) => [
  w.id,
  w.key,
  w.highway,
  w.name,
  w.ref,
  w.len,
  w.oneway,
  w.eff,
  w.minlon,
  w.minlat,
  w.maxlon,
  w.maxlat,
  w.geomJson,
];

/**
 * 도로(road_key)별 집계. total_length_m = Σ eff, split_length_m = 분리 구간 묶음의 Σ eff(= Σ length / 2).
 * 양방향 묶음의 상한은 total_length_m − split_length_m이다. 이름 없는 way(`unnamed:`)는 [add]에 넣지 않는다.
 */
export class RoadAccumulator {
  constructor() {
    this.roads = new Map();
  }

  add(w) {
    let r = this.roads.get(w.key);
    if (!r) {
      r = { names: new Map(), nameLen: new Map(), rank: 99, eff: 0, split: 0, n: 0, c: [181, 91, -181, -91] };
      this.roads.set(w.key, r);
    }
    r.names.set(w.display, (r.names.get(w.display) ?? 0) + 1);
    if (w.name) {
      const n = w.name.trim();
      r.nameLen.set(n, (r.nameLen.get(n) ?? 0) + w.len);
    }
    r.rank = Math.min(r.rank, RANK[w.major] ?? 99);
    r.eff += w.eff;
    if (w.split) r.split += w.eff;
    r.n++;
    const cx = (w.minlon + w.maxlon) / 2,
      cy = (w.minlat + w.maxlat) / 2;
    if (cx < r.c[0]) r.c[0] = cx;
    if (cy < r.c[1]) r.c[1] = cy;
    if (cx > r.c[2]) r.c[2] = cx;
    if (cy > r.c[3]) r.c[3] = cy;
  }

  /** roads 테이블 행들. names_json은 name 길이 순 상위 [MAX_STORED_NAMES]개. */
  rows() {
    const rankName = Object.fromEntries(Object.entries(RANK).map(([k, v]) => [v, k]));
    return [...this.roads].map(([key, r]) => ({
      road_key: key,
      display_name: [...r.names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      highway_major: rankName[r.rank] ?? 'residential',
      total_length_m: r.eff,
      split_length_m: r.split,
      way_count: r.n,
      names_json: JSON.stringify(
        [...r.nameLen.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_STORED_NAMES)
          .map(([n]) => n),
      ),
      center: r.c,
    }));
  }
}
