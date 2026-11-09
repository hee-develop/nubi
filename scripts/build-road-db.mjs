#!/usr/bin/env node
// 도로 DB 빌드(사양 3-2): osmium tags-filter → osmium export(GeoJSONSeq) → SQLite.
// 사용: node scripts/build-road-db.mjs <pbf> <YYYYMM> [--bbox minlon,minlat,maxlon,maxlat] [--out <path>] [--stats-json <path>] [--regions <regions.sqlite>]
//  --regions: 시군구 DB(사양 03). way 중간 정점의 시군구로 도로 키에 지역 접두를 붙인다(`nm:{sgg}:{name}`, `lr:{sido}:{ref}`). 전국 빌드에서는 필수(--bbox 소형 빌드만 생략 가능, 옛 키). snapshot.regions_month에 지역 DB 월을 기록한다.
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
import { HIGHWAYS, RoadAccumulator, SCHEMA_SQL, haversine, locateWay, normalize, wayRecord, wayRowValues } from './road-rules.mjs';
import { SIDO_SHORT, makeLocator } from './geo-utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const bboxArg = opt('--bbox');
const outArg = opt('--out');
const statsJson = opt('--stats-json');
const regionsArg = opt('--regions');
const [pbfArg, month] = args;
if (!pbfArg || !/^\d{6}$/.test(month ?? '')) {
  console.error('사용: build-road-db.mjs <pbf> <YYYYMM> [--bbox minlon,minlat,maxlon,maxlat] [--out path]');
  process.exit(2);
}
const pbf = resolve(pbfArg);
const out = resolve(outArg ?? join(ROOT, 'server/data', `roads-${month}.sqlite`));
const bbox = bboxArg ? bboxArg.split(',').map(Number) : null;
if (!bbox && !regionsArg) {
  console.error('전국 빌드(--bbox 없음)에는 --regions <regions.sqlite>가 필수입니다(도로 키 지역 접두, 사양 03).');
  process.exit(2);
}
if (bbox && (bbox.length !== 4 || bbox.some(Number.isNaN))) throw new Error('--bbox 형식 오류');

// 시군구 판정기(scripts/geo-utils.mjs 공용): 폴리곤 안 → 50m 이내 가장 가까운 시군구. 전국 빌드는 --regions 필수.
let locate;
let regionsMonth = null;
if (regionsArg) {
  const rdb = new DatabaseSync(resolve(regionsArg), { readOnly: true });
  regionsMonth = rdb.prepare('SELECT month FROM snapshot ORDER BY month DESC LIMIT 1').get()?.month ?? null;
  const loc = makeLocator(rdb);
  locate = (lon, lat) => {
    const r = loc.locate(lon, lat);
    return r ? { sgg: r.code, sggDisplay: r.display_name, sido: r.sido_code, sidoShort: SIDO_SHORT[r.sido_code] ?? r.sido_name } : null;
  };
}

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

// --- DB --------------------------------------------------------------------
mkdirSync(dirname(out), { recursive: true });
const tmpOut = `${out}.tmp`;
rmSync(tmpOut, { force: true });
const db = new DatabaseSync(tmpOut);
db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;`);
db.exec(SCHEMA_SQL);
const insWay = db.prepare('INSERT OR REPLACE INTO ways VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insRtree = db.prepare('INSERT OR REPLACE INTO ways_rtree VALUES (?,?,?,?,?)');

const acc = new RoadAccumulator();
// 지역 접두 효과 측정용: 옛 키(접두 없음)별 중심점 범위와 쪼개진 새 키 집합
const legacy = new Map();
const regionStats = { located: 0, unlocated: 0 };
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
  const region = locate ? locateWay(coords, locate) : undefined;
  const w = wayRecord(id, tags, coords, undefined, region);
  if (locate) {
    regionStats[region ? 'located' : 'unlocated']++;
    if (w.key.startsWith('nm:') || w.key.startsWith('lr:')) {
      const lk =
        (w.key.startsWith('nm:') ? 'nm:' : 'lr:') + normalize((w.key.startsWith('nm:') ? tags.name : tags.ref.split(';')[0]).trim());
      const cx = (w.minlon + w.maxlon) / 2,
        cy = (w.minlat + w.maxlat) / 2;
      let c = legacy.get(lk);
      if (!c) legacy.set(lk, (c = { c: [181, 91, -181, -91], keys: new Set(), n: 0 }));
      c.c = [Math.min(c.c[0], cx), Math.min(c.c[1], cy), Math.max(c.c[2], cx), Math.max(c.c[3], cy)];
      c.keys.add(w.key);
      c.n++;
    }
  }
  insWay.run(...wayRowValues(w));
  insRtree.run(id, w.minlon, w.maxlon, w.minlat, w.maxlat);
  wayCount++;
  totalAll += w.len;
  byClass[tags.highway] ??= { length_m: 0, ways: 0 };
  byClass[tags.highway].length_m += w.len;
  byClass[tags.highway].ways++;
  if (w.display === null) {
    unnamedWays++;
    unnamedLen += w.len;
    continue;
  }
  totalNamed += w.eff;
  acc.add(w);
}
await exited;
const insRoad = db.prepare('INSERT INTO roads VALUES (?,?,?,?,?,?,?)');
let farApart = 0,
  farApartWays = 0,
  nmRoads = 0;
for (const r of acc.rows()) {
  insRoad.run(r.road_key, r.display_name, r.highway_major, r.total_length_m, r.split_length_m, r.way_count, r.names_json);
  if (r.road_key.startsWith('nm:')) {
    nmRoads++;
    if (haversine([r.center[0], r.center[1]], [r.center[2], r.center[3]]) > 50_000) {
      farApart++;
      farApartWays += r.way_count;
    }
  }
}
db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?,?)').run(
  month,
  new Date().toISOString(),
  basename(pbf),
  pbfTimestamp,
  totalNamed,
  totalAll,
  JSON.stringify(byClass),
  regionsMonth,
);
db.exec('COMMIT');
db.exec('ANALYZE');
db.close();
rmSync(out, { force: true });
renameSync(tmpOut, out);
rmSync(work, { recursive: true, force: true });

// 동명이로 해소: 옛 nm: 키 중 중심점 범위 대각선 > 50km인 것(같은 이름의 먼 도로가 한 도로로 묶였던 것)이 새 키로 몇 개로 쪼개졌는지
let legacyNm = 0,
  legacyFar = 0,
  legacyFarSplit = 0,
  newKeysFromFar = 0;
for (const [k, v] of legacy) {
  if (!k.startsWith('nm:')) continue;
  legacyNm++;
  if (haversine([v.c[0], v.c[1]], [v.c[2], v.c[3]]) > 50_000) {
    legacyFar++;
    newKeysFromFar += v.keys.size;
    if (v.keys.size > 1) legacyFarSplit++;
  }
}
const regionKeyStats = regionsArg
  ? {
      regionsDb: resolve(regionsArg),
      waysLocated: regionStats.located,
      waysUnlocated: regionStats.unlocated,
      legacyNmKeys: legacyNm,
      legacyNmKeysFarApart_gt50km: legacyFar,
      legacyFarKeysSplit: legacyFarSplit,
      legacyFarSplitRatio: legacyFar ? legacyFarSplit / legacyFar : 0,
      newKeysFromFarKeys: newKeysFromFar,
    }
  : null;
const stats = {
  out,
  regionKeys: regionKeyStats,
  regionsMonth,
  bbox,
  month,
  pbfTimestamp,
  ways: wayCount,
  roads: acc.roads.size,
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
