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
import { HIGHWAYS, RoadAccumulator, SCHEMA_SQL, haversine, wayRecord, wayRowValues } from './road-rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  const w = wayRecord(id, tags, coords);
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
