#!/usr/bin/env node
// 테스트 도로 DB의 way 기하에서 E2E용 GPX를 만든다(사양 02 8장): 광화문 → 숭례문 방향 세종대로 하행 차로 중심선, 25m 간격 60점, 고정 시드 ±3m 지터.
// 사용: node scripts/make-gpx-from-road.mjs [roads.sqlite] [out.gpx]
//  기본: server/test/fixtures/roads-test.sqlite → car/app/src/debug/assets/e2e-sejong.gpx
// way는 OSM 디지타이징 방향(=일방통행 진행 방향)으로 이어 붙인다. 외부 의존성 없음(node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(process.argv[2] ?? `${ROOT}/server/test/fixtures/roads-test.sqlite`);
const out = resolve(process.argv[3] ?? `${ROOT}/car/app/src/debug/assets/e2e-sejong.gpx`);

const POINTS = 60;
const STEP_M = 25;
const JITTER_M = 3;
const SEED = 20261109;
// 광화문 북쪽 시작 way(국도 48호선 하행)부터 이어 간다. 이 구간은 nr:48 → nr:31 → nm:세종대로로 이름이 바뀐다.
const START_WAY = 516417601;
// 지역 접두(사양 03): 세종대로는 종로구·중구 두 키로 갈린다
const ROAD_KEYS = new Set(['nr:48', 'nr:31', 'nm:11110:세종대로', 'nm:11140:세종대로']);

const R = 6371008.8;
const rad = Math.PI / 180;
const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * rad,
    dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const node = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

const db = new DatabaseSync(dbPath, { readOnly: true });
const ways = db
  .prepare("SELECT way_id, road_key, geom_json FROM ways WHERE oneway = 'yes' AND highway = 'primary'")
  .all()
  .filter((w) => ROAD_KEYS.has(w.road_key))
  .map((w) => ({ id: w.way_id, coords: JSON.parse(w.geom_json) }));
const byStart = new Map();
for (const w of ways) (byStart.get(node(w.coords[0])) ?? byStart.set(node(w.coords[0]), []).get(node(w.coords[0]))).push(w);

let cur = ways.find((w) => w.id === START_WAY);
if (!cur) throw new Error(`시작 way ${START_WAY}가 도로 DB에 없습니다`);
const line = [...cur.coords];
const used = new Set([cur.id]);
for (;;) {
  const end = line.at(-1);
  // 남쪽으로 가는 다음 way 중 가장 곧게 이어지는 것
  const next = (byStart.get(node(end)) ?? []).filter((w) => !used.has(w.id) && w.coords.at(-1)[1] < end[1])[0];
  if (!next) break;
  used.add(next.id);
  line.push(...next.coords.slice(1));
  if (line.reduce((s, c, i) => (i ? s + hav(line[i - 1], c) : 0), 0) > POINTS * STEP_M + 200) break;
}

// 중심선을 따라 STEP_M 간격으로 재표본
const samples = [line[0]];
let carry = 0;
for (let i = 1; i < line.length && samples.length < POINTS; i++) {
  let a = line[i - 1];
  const b = line[i];
  let seg = hav(a, b);
  while (carry + seg >= STEP_M && samples.length < POINTS) {
    const t = (STEP_M - carry) / seg;
    a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    samples.push(a);
    seg = hav(a, b);
    carry = 0;
  }
  carry += seg;
}
if (samples.length < POINTS) throw new Error(`중심선이 짧아 ${samples.length}점만 나옵니다`);

// mulberry32 고정 시드 지터(동·북 방향 각각 ±3m). 차량 앱은 직전 채택점에서 20m 미만 이동한 점을 버리므로(사양 01),
// 연속 두 점 사이가 MIN_STEP_M 아래가 되면 시드를 하나 올려 다시 뽑는다(결정적: 같은 입력은 항상 같은 결과). 60점이 모두 채택돼야 flow가 '샘플 60'을 기다릴 수 있다.
const MIN_STEP_M = 21;
const mPerLat = R * rad;
const jitter = (seed) => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return samples.map(([lon, lat]) => {
    const dn = (rnd() * 2 - 1) * JITTER_M,
      de = (rnd() * 2 - 1) * JITTER_M;
    return [lat + dn / mPerLat, lon + de / (mPerLat * Math.cos(lat * rad))];
  });
};
const minStep = (p) => Math.min(...p.slice(1).map((c, i) => hav([p[i][1], p[i][0]], [c[1], c[0]])));
let seed = SEED;
let pts = jitter(seed);
while (minStep(pts) < MIN_STEP_M) pts = jitter(++seed);

const total = pts.reduce((sum, p, i) => (i ? sum + hav([pts[i - 1][1], pts[i - 1][0]], [p[1], p[0]]) : 0), 0);
const body = pts.map(([lat, lon]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>30</ele></trkpt>`).join('\n');
writeFileSync(
  out,
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="nubi-e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>e2e-sejong-${Math.round(total)}m</name><trkseg>\n${body}\n</trkseg></trk></gpx>\n`,
);
console.log(`${out}: ${pts.length}점, 시드 ${seed}, 경로 길이 약 ${Math.round(total)}m, way ${[...used].join(',')}`);
