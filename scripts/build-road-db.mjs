#!/usr/bin/env node
// 도로 DB 빌드(사양 3-2): osmium tags-filter → osmium export(GeoJSONSeq) → SQLite.
// 사용: node scripts/build-road-db.mjs <pbf> <YYYYMM> [--bbox minlon,minlat,maxlon,maxlat] [--out <path>] [--stats-json <path>]
//  --bbox : 이 범위와 겹치는 way만 담는다(테스트용 소형 DB). osmium extract(complete_ways)로 먼저 자른다.
//  --out  : 기본 server/data/roads-<YYYYMM>.sqlite
// 외부 npm 의존성 없음(Node 22 node:sqlite). osmium-tool 필요(brew install osmium-tool).
// 출처: © OpenStreetMap contributors (ODbL). 결과 DB는 파생 DB이며 사용자 기록 DB와 파일을 분리한다.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, existsSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HIGHWAYS = [
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
const HALF_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6 };

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const bboxArg = opt('--bbox');
const outArg = opt('--out');
const statsJson = opt('--stats-json');
const [pbfArg, month] = args;
if (!pbfArg || !/^\d{6}$/.test(month ?? '')) {
  console.error('사용: build-road-db.mjs <pbf> <YYYYMM> [--bbox minlon,minlat,maxlon,maxlat] [--out path]');
  process.exit(2);
}
const pbf = resolve(pbfArg);
const out = resolve(outArg ?? join(ROOT, 'server/data', `roads-${month}.sqlite`));
const bbox = bboxArg ? bboxArg.split(',').map(Number) : null;
if (bbox && (bbox.length !== 4 || bbox.some(Number.isNaN))) throw new Error('--bbox 형식 오류');

const t0 = Date.now();
const work = mkdtempSync(join(tmpdir(), 'nubi-roads-'));
const sh = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'inherit', 'inherit'] });

let src = pbf;
if (bbox) {
  src = join(work, 'extract.osm.pbf');
  sh('osmium', ['extract', '-b', bbox.join(','), '-s', 'complete_ways', pbf, '-o', src]);
}
const filtered = join(work, 'roads.osm.pbf');
sh('osmium', ['tags-filter', src, ...HIGHWAYS.map((h) => `w/highway=${h}`), '-o', filtered]);
const pbfTimestamp =
  execFileSync('osmium', ['fileinfo', '-g', 'header.option.osmosis_replication_timestamp', pbf]).toString().trim() || null;

// --- 규칙 -----------------------------------------------------------------
const normalize = (s) => s.normalize('NFKC').replace(/\s+/g, '');
function classify(tags, wayId) {
  const hw = tags.highway;
  const major = hw.replace(/_link$/, '');
  const ref = tags.ref ? tags.ref.split(';')[0].trim() : '';
  const name = tags.name ? tags.name.trim() : '';
  if (ref && major === 'motorway') return { key: `mw:${normalize(ref)}`, display: name || `고속도로 ${ref}` };
  if (ref && (major === 'trunk' || major === 'primary')) return { key: `nr:${normalize(ref)}`, display: `국도 ${ref}호선` };
  if (ref && (major === 'secondary' || major === 'tertiary')) return { key: `lr:${normalize(ref)}`, display: `지방도 ${ref}호선` };
  // ref가 있어도 위 등급이 아니면(unclassified·residential) 이름 규칙으로 넘어간다
  if (name) return { key: `nm:${normalize(name)}`, display: name };
  return { key: `unnamed:${wayId}`, display: null };
}
const R = 6371008.8;
const rad = Math.PI / 180;
function haversine(a, b) {
  const dLat = (b[1] - a[1]) * rad,
    dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --- DB --------------------------------------------------------------------
mkdirSync(dirname(out), { recursive: true });
const tmpOut = `${out}.tmp`;
rmSync(tmpOut, { force: true });
const db = new DatabaseSync(tmpOut);
db.exec(`
PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
CREATE TABLE ways(way_id INTEGER PRIMARY KEY, road_key TEXT NOT NULL, highway TEXT NOT NULL, name TEXT, ref TEXT,
  length_m REAL NOT NULL, oneway TEXT, eff_length_m REAL NOT NULL, minlon REAL, minlat REAL, maxlon REAL, maxlat REAL, geom_json TEXT NOT NULL);
CREATE INDEX ways_road_key ON ways(road_key);
CREATE VIRTUAL TABLE ways_rtree USING rtree(way_id, minlon, maxlon, minlat, maxlat);
CREATE TABLE roads(road_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, highway_major TEXT NOT NULL,
  total_length_m REAL NOT NULL, way_count INTEGER NOT NULL, names_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE snapshot(month TEXT PRIMARY KEY, built_at TEXT NOT NULL, pbf_name TEXT NOT NULL, pbf_timestamp TEXT,
  total_named_length_m REAL NOT NULL, total_all_length_m REAL NOT NULL, by_class_json TEXT NOT NULL);
`);
const insWay = db.prepare('INSERT OR REPLACE INTO ways VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insRtree = db.prepare('INSERT OR REPLACE INTO ways_rtree VALUES (?,?,?,?,?)');

const roads = new Map(); // key -> {names:Map(표시이름→way 수), nameLen:Map(way name→길이 m), rank, len, n, c:[minlon,minlat,maxlon,maxlat] (way bbox 중심들의 범위)}
const byClass = {};
let totalAll = 0,
  totalNamed = 0,
  wayCount = 0,
  unnamedWays = 0,
  unnamedLen = 0,
  skipped = 0;

const exp = spawn('osmium', ['export', '-f', 'geojsonseq', '--geometry-types=linestring', '--add-unique-id=type_id', filtered], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = new Promise((res, rej) => {
  exp.on('exit', (c) => (c === 0 ? res() : rej(new Error(`osmium export 종료 코드 ${c}`))));
});
db.exec('BEGIN');
for await (const raw of createInterface({ input: exp.stdout, crlfDelay: Infinity })) {
  const line = raw.replace(/^\x1e/, '').trim();
  if (!line) continue;
  const f = JSON.parse(line);
  const id = typeof f.id === 'string' && f.id[0] === 'w' ? Number(f.id.slice(1)) : NaN;
  const coords = f.geometry?.coordinates;
  const tags = f.properties ?? {};
  if (!Number.isFinite(id) || !coords || coords.length < 2 || !HIGHWAYS.includes(tags.highway)) {
    skipped++;
    continue;
  }
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
  const { key, display } = classify(tags, id);
  const major = tags.highway.replace(/_link$/, '');
  // 분리 차로(사양 6-3): 고속·국도·지방도(주요 4등급 + link)의 oneway=yes way는 상·하행 쌍이 한 도로라고 보고 총길이·분모에 1/2로 센다
  const eff = tags.oneway === 'yes' && HALF_CLASSES.has(major) ? len / 2 : len;
  insWay.run(
    id,
    key,
    tags.highway,
    tags.name ?? null,
    tags.ref ?? null,
    len,
    tags.oneway ?? null,
    eff,
    minlon,
    minlat,
    maxlon,
    maxlat,
    JSON.stringify(coords),
  );
  insRtree.run(id, minlon, maxlon, minlat, maxlat);
  wayCount++;
  totalAll += len;
  byClass[tags.highway] ??= { length_m: 0, ways: 0 };
  byClass[tags.highway].length_m += len;
  byClass[tags.highway].ways++;
  if (display === null) {
    unnamedWays++;
    unnamedLen += len;
    continue;
  }
  totalNamed += eff;
  let r = roads.get(key);
  if (!r) roads.set(key, (r = { names: new Map(), nameLen: new Map(), rank: 99, len: 0, n: 0, c: [181, 91, -181, -91] }));
  r.names.set(display, (r.names.get(display) ?? 0) + 1);
  if (tags.name) r.nameLen.set(tags.name.trim(), (r.nameLen.get(tags.name.trim()) ?? 0) + len);
  r.rank = Math.min(r.rank, RANK[major] ?? 99);
  r.len += eff;
  r.n++;
  const cx = (minlon + maxlon) / 2,
    cy = (minlat + maxlat) / 2;
  if (cx < r.c[0]) r.c[0] = cx;
  if (cy < r.c[1]) r.c[1] = cy;
  if (cx > r.c[2]) r.c[2] = cx;
  if (cy > r.c[3]) r.c[3] = cy;
}
await exited;
const insRoad = db.prepare('INSERT INTO roads VALUES (?,?,?,?,?,?)');
const rankName = Object.fromEntries(Object.entries(RANK).map(([k, v]) => [v, k]));
let farApart = 0,
  farApartWays = 0,
  nmRoads = 0;
for (const [key, r] of roads) {
  const display = [...r.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // names_json: 그 도로를 이루는 way의 name 상위 200개(길이 순, 가안: 사양 6-1의 20개로는 짧은 구간의 거리명이 빠져 검색이 안 됨). 국도 31호선 = 세종대로 외 처럼 거리명으로 찾기 위한 것(사양 6-1)
  const topNames = [...r.nameLen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([n]) => n);
  insRoad.run(key, display, rankName[r.rank] ?? 'residential', r.len, r.n, JSON.stringify(topNames));
  if (key.startsWith('nm:')) {
    nmRoads++;
    if (haversine([r.c[0], r.c[1]], [r.c[2], r.c[3]]) > 50_000) {
      farApart++;
      farApartWays += r.n;
    }
  }
}
db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?)').run(
  month,
  new Date().toISOString(),
  basename(pbf),
  pbfTimestamp,
  totalNamed,
  totalAll,
  JSON.stringify(byClass),
);
db.exec('COMMIT');
db.exec('ANALYZE');
db.close();
rmSync(out, { force: true });
renameSync(tmpOut, out);
rmSync(work, { recursive: true, force: true });

const stats = {
  out,
  bbox,
  month,
  pbfTimestamp,
  ways: wayCount,
  roads: roads.size,
  nmRoads,
  skipped,
  totalAllKm: totalAll / 1000,
  totalNamedKm: totalNamed / 1000,
  unnamedWays,
  unnamedKm: unnamedLen / 1000,
  unnamedLengthRatio: totalAll ? unnamedLen / totalAll : 0,
  unnamedWayRatio: wayCount ? unnamedWays / wayCount : 0,
  byClassKm: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { km: +(v.length_m / 1000).toFixed(1), ways: v.ways }])),
  nmKeysFarApart_gt50km: farApart,
  nmKeysFarApartWays: farApartWays,
  seconds: (Date.now() - t0) / 1000,
  dbBytes: statSync(out).size,
};
if (statsJson) writeFileSync(statsJson, JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
