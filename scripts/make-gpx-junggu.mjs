#!/usr/bin/env node
// 시군구 E2E용 짧은 GPX(사양 03 7장): e2e-sejong.gpx의 중구 구간(시청 앞 → 숭례문 쪽)을 잘라 22m 간격으로 다시 찍은 약 240m, 12점. 간격이 20m 이상이라 점이 모두 채택돼 서버 pointCount가 GPX 점 수와 같다(20점 미만이라 맵매칭은 too_short로 끝나고 시군구 판정만 한다).
// 시작·끝 점이 모두 서울 중구(11140) 안이어야 하며 스크립트가 지역 DB로 확인한다(아니면 실패).
// 사용: node scripts/make-gpx-junggu.mjs [regions.sqlite] [out.gpx]   기본 server/data/regions/regions.sqlite → car/app/src/debug/assets/e2e-junggu.gpx
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointInMulti } from './build-regions.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(resolve(process.argv[2] ?? join(ROOT, 'server/data/regions/regions.sqlite')), { readOnly: true });
const out = resolve(process.argv[3] ?? join(ROOT, 'car/app/src/debug/assets/e2e-junggu.gpx'));
const STEP_M = 22;
const POINTS = 12;
const R = 6371008.8;
const hav = (a, b) => {
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r,
    dLon = (b[0] - a[0]) * r;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2));
};
const src = [...readFileSync(join(ROOT, 'car/app/src/debug/assets/e2e-sejong.gpx'), 'utf8').matchAll(/lat="([\d.]+)" lon="([\d.]+)"/g)].map(
  (m) => [+m[2], +m[1]],
);
// 시청 앞(37.5655)부터 남쪽 끝까지의 중구 구간
const path = src.filter((p) => p[1] <= 37.5655);
const geom = JSON.parse(db.prepare("SELECT geom_json FROM regions WHERE code = '11140'").get().geom_json).coordinates;
const pts = [];
let carried = 0;
let i = 0;
let cur = path[0];
pts.push(cur);
while (pts.length < POINTS && i < path.length - 1) {
  const a = cur,
    b = path[i + 1];
  const d = hav(a, b);
  if (carried + d >= STEP_M) {
    const t = (STEP_M - carried) / d;
    cur = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    pts.push(cur);
    carried = 0;
  } else {
    carried += d;
    cur = b;
    i++;
  }
}
if (pts.length < POINTS) throw new Error(`경로가 짧아 ${pts.length}점뿐입니다`);
let len = 0;
for (let k = 1; k < pts.length; k++) len += hav(pts[k - 1], pts[k]);
for (const p of [pts[0], pts.at(-1)]) if (!pointInMulti(p[0], p[1], geom)) throw new Error(`중구 밖의 점: ${p}`);
const body = pts.map((p) => `<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"><ele>30</ele></trkpt>`).join('\n');
writeFileSync(
  out,
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="nubi-e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>e2e-junggu-${Math.round(len)}m</name><trkseg>\n${body}\n</trkseg></trk></gpx>\n`,
);
console.log(
  `${pts.length}점, 약 ${Math.round(len)}m, 시작 ${pts[0].map((x) => x.toFixed(6))} 끝 ${pts.at(-1).map((x) => x.toFixed(6))} → ${out}`,
);
