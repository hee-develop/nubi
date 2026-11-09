#!/usr/bin/env node
// 시군구 DB 판정 확인: node scripts/verify-regions.mjs [regions.sqlite] — 세종대로 GPX 첫·끝 점과 시도 도청 좌표를 판정해 표로 출력한다.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLocator } from '../server/src/shared/geo-utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(resolve(process.argv[2] ?? join(ROOT, 'server/data/regions/regions.sqlite')), { readOnly: true });
const loc = makeLocator(db); // 폴리곤 안(code 순) → 없으면 50m 이내 가장 가까운 시군구(서버와 같은 규칙)
export const locate = (lon, lat) => {
  const r = loc.locate(lon, lat);
  return r ? `${r.sido_name} ${r.display_name} (${r.code})` : null;
};
const gpx = [
  ...readFileSync(join(ROOT, 'car/app/src/debug/assets/e2e-sejong.gpx'), 'utf8').matchAll(/<trkpt lat="([\d.]+)" lon="([\d.]+)"/g),
];
const pts = [
  ['GPX 첫 점', +gpx[0][2], +gpx[0][1]],
  ['GPX 끝 점', +gpx.at(-1)[2], +gpx.at(-1)[1]],
  ['서울시청', 126.97797, 37.56654],
  ['부산시청', 129.07564, 35.17987],
  ['대구시청', 128.60145, 35.87139],
  ['인천시청', 126.70529, 37.45629],
  ['광주시청(옛)', 126.85154, 35.16012],
  ['전남도청(무안)', 126.46826, 34.81594],
  ['대전시청', 127.38492, 36.3504],
  ['울산시청', 129.31138, 35.53838],
  ['세종시청', 127.28917, 36.48004],
  ['경기도청(수원)', 127.00949, 37.28931],
  ['강원도청(춘천)', 127.72983, 37.88531],
  ['충북도청(청주)', 127.48911, 36.63571],
  ['충남도청(홍성)', 126.67279, 36.65884],
  ['전북도청(전주)', 127.10891, 35.82036],
  ['경북도청(안동)', 128.5041, 36.57621],
  ['경남도청(창원)', 128.68112, 35.23836],
  ['제주도청', 126.53154, 33.49938],
  ['동해 한가운데', 131.5, 37.5],
];
console.log('| 지점 | lon | lat | 판정 |\n|---|---|---|---|');
for (const [n, x, y] of pts) console.log(`| ${n} | ${x} | ${y} | ${locate(x, y) ?? '(없음)'} |`);
