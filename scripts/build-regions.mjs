#!/usr/bin/env node
// 시군구 경계 DB 빌드(사양 03 3장): 행정동 경계 GeoJSON → 시군구 단위 병합 → 단순화 → SQLite(+R-tree).
// 사용: node scripts/build-regions.mjs <geojson> <YYYYMM> [--out <path>] [--codes c1,c2,...] [--depop <json>] [--stats-json <path>]
//  입력  : vuski/admdongkor 의 HangJeongDong_verYYYYMMDD.geojson (EPSG:4326, 속성 sgg·sido·sidonm·sggnm). 행정동 → 시군구(5자리) 병합.
//  --codes: 담을 시군구 코드(기존 2025 코드 또는 새 코드)만 남긴다(테스트 픽스처용).
//  --out  : 기본 server/data/regions/regions.sqlite
//  --depop: 인구감소지역 목록. 기본 server/data/regions/depopulation.json
// 외부 npm 의존성 없음(Node 22 node:sqlite).
// 출처: 통계청 SGIS 행정동 경계(공공누리 제1유형) 가공본 vuski/admdongkor(CC BY 4.0). 사양 03 3장 참조.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync, statSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointInRing, regionDisplayName } from './geo-utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 2026-07-01 전남광주통합특별시: 기존 시군구 코드 → 새 코드. 광주 5구 + 전남 22시군(1:1, 이름 불변).
 *  출처: vuski/admdongkor ver20261001(통계청 SGIS 2026-10 행정동 경계)의 sgg 코드, 시도 코드 12 '전남광주통합특별시'.
 *  행정안전부 코드 고시 원문(법정동·행정동 코드 일괄 개정)은 찾지 못했다 → 고시와 대조 필요(코드 값은 SGIS 경계 파일 기준).
 *  근거 법률: 「전남광주통합특별시 설치를 위한 특별법」(법률 제21446호, 2026-03-05 공포, 2026-07-01 시행).
 *  코드는 행안부 행정표준코드(code.go.kr, 시도 12) 대조 결과와 같다(코디네이터 확인, 2026-11-10). */
export const NEW_SIDO = { code: '12', name: '전남광주통합특별시' };
export const REGION_ALIAS = {
  // 광주광역시 5구
  29110: '12210',
  29140: '12240',
  29155: '12270',
  29170: '12300',
  29200: '12330',
  // 전라남도 5시 17군
  46110: '12110',
  46130: '12130',
  46150: '12150',
  46170: '12170',
  46230: '12190',
  46710: '12710',
  46720: '12720',
  46730: '12730',
  46770: '12740',
  46780: '12750',
  46790: '12760',
  46800: '12770',
  46810: '12780',
  46820: '12790',
  46830: '12800',
  46840: '12810',
  46860: '12820',
  46870: '12830',
  46880: '12840',
  46890: '12850',
  46900: '12860',
  46910: '12870',
};

const SCHEMA_SQL = `
CREATE TABLE regions(code TEXT PRIMARY KEY, sido_code TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL, sido_name TEXT NOT NULL,
  depop_89 INTEGER NOT NULL DEFAULT 0, depop_92 INTEGER NOT NULL DEFAULT 0, area_km2 REAL NOT NULL, polygons INTEGER NOT NULL,
  minlon REAL, minlat REAL, maxlon REAL, maxlat REAL, geom_json TEXT NOT NULL);
CREATE VIRTUAL TABLE regions_rtree USING rtree(region_id, minlon, maxlon, minlat, maxlat);
CREATE TABLE region_alias(old_code TEXT PRIMARY KEY, new_code TEXT NOT NULL, new_name TEXT NOT NULL, new_sido_code TEXT NOT NULL, new_sido_name TEXT NOT NULL);
CREATE TABLE snapshot(month TEXT PRIMARY KEY, built_at TEXT NOT NULL, source_name TEXT NOT NULL, region_count INTEGER NOT NULL,
  polygon_count INTEGER NOT NULL, depop_89_count INTEGER NOT NULL, depop_92_count INTEGER NOT NULL, note TEXT);
`;

// ---------------------------------------------------------------- 기하 -----
const QUANT = 1e7; // 병합용 정점 키: 약 1 cm
const key = (p) => `${Math.round(p[0] * QUANT)},${Math.round(p[1] * QUANT)}`;
const signedArea = (r) => {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
};
const ringBbox = (r) => {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const [x, y] of r) {
    if (x < a) a = x;
    if (x > c) c = x;
    if (y < b) b = y;
    if (y > d) d = y;
  }
  return [a, b, c, d];
};
/** 행정동 고리들을 병합: 바깥 CCW·구멍 CW로 정규화 → 반대 방향으로 겹치는 간선 상쇄 → 남은 간선을 이어 고리 복원 → 폴리곤 조립. */
function dissolve(polygons) {
  const edges = new Map(); // "a>b" -> [pa, pb]
  const addRing = (ring, ccw) => {
    let r = ring;
    if (signedArea(r) > 0 !== ccw) r = [...r].reverse();
    for (let i = 0; i < r.length - 1; i++) {
      const ka = key(r[i]),
        kb = key(r[i + 1]);
      if (ka === kb) continue;
      const rev = `${kb}>${ka}`;
      if (edges.has(rev)) edges.delete(rev);
      else edges.set(`${ka}>${kb}`, [r[i], r[i + 1], ka, kb]);
    }
  };
  for (const p of polygons) p.forEach((ring, i) => addRing(ring, i === 0));
  const out = new Map(); // ka -> [edge...]
  for (const e of edges.values()) {
    if (!out.has(e[2])) out.set(e[2], []);
    out.get(e[2]).push(e);
  }
  const rings = [];
  for (const list of out.values()) {
    for (const start of list) {
      if (start.used) continue;
      const ring = [start[0]];
      let cur = start;
      for (;;) {
        cur.used = true;
        ring.push(cur[1]);
        if (cur[3] === start[2]) break;
        const next = (out.get(cur[3]) ?? []).find((e) => !e.used);
        if (!next) break; // 열린 고리(데이터 결함): 버린다
        cur = next;
      }
      if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
    }
  }
  const outers = [],
    holes = [];
  for (const r of rings) (signedArea(r) > 0 ? outers : holes).push({ r, bb: ringBbox(r), a: Math.abs(signedArea(r)) });
  const polys = outers.map((o) => [o.r]);
  const owner = outers.map((o) => o);
  for (const h of holes) {
    let best = -1;
    for (let i = 0; i < outers.length; i++) {
      const o = outers[i];
      if (o.a <= h.a || h.bb[0] < o.bb[0] || h.bb[2] > o.bb[2] || h.bb[1] < o.bb[1] || h.bb[3] > o.bb[3]) continue;
      if (!pointInRing(h.r[0][0], h.r[0][1], o.r)) continue;
      if (best < 0 || o.a < owner[best].a) best = i;
    }
    if (best >= 0) polys[best].push(h.r);
    // 바깥이 없는 구멍은 버린다(데이터 결함)
  }
  return polys;
}

/** Douglas-Peucker(닫힌 고리). 단위 m(위도 방향 평면 근사). */
function simplifyRing(ring, tolM) {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180),
    ky = 110574;
  const pts = ring.slice(0, -1).map(([x, y]) => [x * kx, y * ky]);
  const n = pts.length;
  if (n < 4) return null;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  // 고리를 가장 먼 두 점(0번과 그로부터 가장 먼 점)으로 쪼개 두 구간에 DP 적용
  let far = 0,
    fd = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const keep = new Array(n).fill(false);
  keep[0] = keep[far] = true;
  const dp = (lo, hi) => {
    const stack = [[lo, hi]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let m = -1,
        md = tolM;
      const a = pts[s % n],
        b = pts[e % n];
      for (let i = s + 1; i < e; i++) {
        const d = dist(pts[i % n], a, b);
        if (d > md) {
          md = d;
          m = i;
        }
      }
      if (m >= 0) {
        keep[m % n] = true;
        stack.push([s, m], [m, e]);
      }
    }
  };
  dp(0, far);
  dp(far, n);
  const res = [];
  for (let i = 0; i < n; i++) if (keep[i]) res.push(ring[i]);
  // 좌표 5자리, 연속 중복 제거
  const r5 = [];
  for (const [x, y] of res) {
    const q = [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5];
    const last = r5[r5.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) r5.push(q);
  }
  if (r5.length < 3) return null;
  r5.push(r5[0]);
  return r5.length >= 4 ? r5 : null;
}

const ringAreaKm2 = (r) => {
  const lat0 = r.reduce((s, p) => s + p[1], 0) / r.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180),
    ky = 110.574;
  return Math.abs(signedArea(r.map(([x, y]) => [x * kx, y * ky])));
};

// ---------------------------------------------------------------- 실행 -----
function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const outArg = opt('--out');
  const codesArg = opt('--codes');
  const depopArg = opt('--depop');
  const statsJson = opt('--stats-json');
  const [inArg, month] = args;
  if (!inArg || !/^\d{6}$/.test(month ?? '')) {
    console.error('사용: build-regions.mjs <geojson> <YYYYMM> [--out path] [--codes c1,c2] [--depop json] [--stats-json path]');
    process.exit(2);
  }
  const t0 = Date.now();
  const out = resolve(outArg ?? join(ROOT, 'server/data/regions/regions.sqlite'));
  const depopPath = resolve(depopArg ?? join(ROOT, 'server/data/regions/depopulation.json'));
  const only = codesArg ? new Set(codesArg.split(',').map((s) => s.trim())) : null;

  const gj = JSON.parse(readFileSync(resolve(inArg), 'utf8'));
  // 1) 행정동 → 시군구 그룹(일반구는 상위 시로 합침: 수원시장안구 → 수원시 41110)
  const groups = new Map(); // oldCode -> {sido, sidoName, name, polys: []}
  for (const f of gj.features) {
    const p = f.properties;
    let code = String(p.sgg),
      name = p.sggnm;
    const m = /^(.+?시)(.+구)$/.exec(name);
    if (m && !code.endsWith('0')) {
      code = code.slice(0, 4) + '0';
      name = m[1];
    }
    let g = groups.get(code);
    if (!g) groups.set(code, (g = { sido: String(p.sido), sidoName: p.sidonm, name, polys: [] }));
    const geom = f.geometry;
    if (geom.type === 'Polygon') g.polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') g.polys.push(...geom.coordinates);
  }

  // 2) 인구감소지역 목록(이름→2025 시군구 코드)
  const depop89 = new Set(),
    depop92 = new Set();
  const depopMissing = [];
  if (existsSync(depopPath)) {
    const dj = JSON.parse(readFileSync(depopPath, 'utf8'));
    // 2025 경계의 시도명(전라남도 등)과 맞추려고 sidoAt2021(통합특별시 편입 전 이름)도 후보로 본다.
    const find = (e) => [...groups].find(([, g]) => (g.sidoName === e.sido || g.sidoName === e.sidoAt2021) && g.name === e.name)?.[0];
    for (const e of dj.list89 ?? []) {
      const c = find(e);
      if (c) {
        depop89.add(c);
        depop92.add(c);
      } else depopMissing.push(`89:${e.sido} ${e.name}`);
    }
    for (const e of dj.list92Added ?? []) {
      const c = find(e);
      if (c) depop92.add(c);
      else depopMissing.push(`92:${e.sido} ${e.name}`);
    }
    for (const e of dj.list92Removed ?? []) {
      const c = find(e);
      if (c) depop92.delete(c);
    }
  }

  // 3) DB
  mkdirSync(dirname(out), { recursive: true });
  const tmpOut = `${out}.tmp`;
  rmSync(tmpOut, { force: true });
  const db = new DatabaseSync(tmpOut);
  db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
  db.exec(SCHEMA_SQL);
  const insR = db.prepare('INSERT INTO regions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insT = db.prepare('INSERT INTO regions_rtree VALUES (?,?,?,?,?)');
  const insA = db.prepare('INSERT INTO region_alias VALUES (?,?,?,?,?)');
  let nRegions = 0,
    nPolys = 0,
    rawPolys = 0,
    rawPts = 0,
    outPts = 0,
    d89 = 0,
    d92 = 0;
  const bySido = {};
  // 표시 이름(사양 03 3장): 유일성은 `--codes`로 줄이기 전 전국 전체(새 코드 기준) 이름으로 판단한다.
  const allRegions = [...groups].map(([oldCode, g]) => ({
    code: REGION_ALIAS[oldCode] ?? oldCode,
    name: g.name,
    sidoCode: REGION_ALIAS[oldCode] ? NEW_SIDO.code : g.sido,
  }));
  const display = new Map(allRegions.map((r) => [r.code, regionDisplayName(r, allRegions)]));
  db.exec('BEGIN');
  for (const [oldCode, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const newCode = REGION_ALIAS[oldCode] ?? oldCode;
    if (only && !only.has(oldCode) && !only.has(newCode)) continue;
    const aliased = newCode !== oldCode;
    const sidoCode = aliased ? NEW_SIDO.code : g.sido;
    const sidoName = aliased ? NEW_SIDO.name : g.sidoName;
    rawPolys += g.polys.length;
    for (const p of g.polys) for (const r of p) rawPts += r.length;
    const merged = dissolve(g.polys);
    const polys = [];
    let area = 0;
    for (const p of merged) {
      const outer = simplifyRing(p[0], 30);
      if (!outer) continue;
      const rings = [outer];
      for (let i = 1; i < p.length; i++) {
        const h = simplifyRing(p[i], 30);
        if (h) rings.push(h);
      }
      polys.push(rings);
      area += ringAreaKm2(p[0]) - p.slice(1).reduce((s, h) => s + ringAreaKm2(h), 0);
    }
    if (!polys.length) throw new Error(`폴리곤이 모두 사라짐: ${oldCode} ${g.name}`);
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const p of polys) {
      outPts += p.reduce((s, r) => s + r.length, 0);
      const bb = ringBbox(p[0]);
      a = Math.min(a, bb[0]);
      b = Math.min(b, bb[1]);
      c = Math.max(c, bb[2]);
      d = Math.max(d, bb[3]);
    }
    const geom = JSON.stringify({ type: 'MultiPolygon', coordinates: polys });
    const is89 = depop89.has(oldCode) ? 1 : 0,
      is92 = depop92.has(oldCode) ? 1 : 0;
    const info = insR.run(
      newCode,
      sidoCode,
      g.name,
      display.get(newCode),
      sidoName,
      is89,
      is92,
      +area.toFixed(3),
      polys.length,
      a,
      b,
      c,
      d,
      geom,
    );
    insT.run(Number(info.lastInsertRowid), a, c, b, d);
    if (aliased) insA.run(oldCode, newCode, g.name, NEW_SIDO.code, NEW_SIDO.name);
    nRegions++;
    nPolys += polys.length;
    d89 += is89;
    d92 += is92;
    bySido[sidoName] = (bySido[sidoName] ?? 0) + 1;
  }
  const note = '통합특별시(12) 매핑 반영. 인천 구 개편(2026-07)·화성 일반구는 2025 경계 기준 미반영';
  db.prepare('INSERT INTO snapshot VALUES (?,?,?,?,?,?,?,?)').run(
    month,
    new Date().toISOString(),
    inArg.split('/').pop(),
    nRegions,
    nPolys,
    d89,
    d92,
    note,
  );
  db.exec('COMMIT');
  db.exec('ANALYZE');
  db.close();
  rmSync(out, { force: true });
  renameSync(tmpOut, out);

  const stats = {
    out,
    month,
    codes: only ? [...only] : null,
    regions: nRegions,
    polygons: nPolys,
    rawPolygons: rawPolys,
    rawPoints: rawPts,
    outPoints: outPts,
    depop89: d89,
    depop92: d92,
    depopMissing,
    bySido,
    dbBytes: statSync(out).size,
    seconds: (Date.now() - t0) / 1000,
  };
  if (statsJson) writeFileSync(statsJson, JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
