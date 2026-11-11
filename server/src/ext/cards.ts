import type { LonLat, Poly, Seg } from './render.js';
import { cardSvg, fit, KOREA_BBOX, mapContent, type CardText } from './render.js';
import { readSettings } from './settings.js';
import { ownerRegionLevels, ownerWays, regionItems, regionSummary, ownerCoverage, type DrawnWay, type RegionLevels } from './stats.js';
import { KST_MS, type ExtDeps } from './util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { RG } from '../regions/index.js';
import { RD, VEHICLE_SET_SQL, DRIVEN_CTE } from '../roads/index.js';
import { COMPLETE_PERCENT } from '../routes/coverage.js';
import { isFaded } from '../shared/fade.js';
import { haversineM } from '../routes/trips.js';

export type CardMeta = { kind: 'national' | 'trip' | 'road'; label: string; lines: string[]; aria: string };
export type CardResult = { ok: true; svg: string; meta: CardMeta } | { ok: false; status: 404 | 409 | 503; error: string };

/** 여행 카드에서 출발·도착 지점 주변을 지우는 반경(m, plan 10-1 가안). */
export const TRIP_CUT_RADIUS_M = 1_000;
const MAX_TRIP_IDS = 20;

const km1 = (m: number) => Math.round(m / 100) / 10;
const toLonLat = (c: number[][]): LonLat[] => c.map((p) => [p[0]!, p[1]!]);

/** 월 단위 표기(날짜·시각 없음, KST). */
export const monthLabel = (iso: string | number): string => {
  const d = new Date((typeof iso === 'number' ? iso : Date.parse(iso)) + KST_MS);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월`;
};

/** '내 지역' 시군구(공유 카드에서 숨기기 켜짐일 때만). */
const hiddenHome = (deps: ExtDeps, vehicleId: string): string | null => {
  const s = readSettings(deps.db, vehicleId);
  const regions = deps.getRegions();
  return s.hideHomeInCards && s.homeRegion ? (regions ? regions.canonical(s.homeRegion) : s.homeRegion) : null;
};

/** 시군구 면(단계·바램·인구감소지역)을 그릴 도형으로. */
export const regionPolys = (deps: ExtDeps, levels: RegionLevels): Poly[] => {
  const regions = deps.getRegions();
  if (!regions) return [];
  const out: Poly[] = [];
  for (const it of regionItems(deps.db, regions, levels)) {
    const polys = regions.polygons(it.code);
    if (!polys) continue;
    out.push({
      rings: polys.flatMap((p) => p.map((ring) => toLonLat(ring))),
      level: it.level as 0 | 1 | 2 | 3,
      faded: it.level > 0 && isFaded(levels.get(it.code)?.lastAt, deps.now()),
      depop: it.depop92,
    });
  }
  return out;
};

/** 전국 지도 안쪽(720x540). 전국 축척 고정이라 좌표 정보는 해상도 이하로만 남는다. */
export const nationalMapInner = (deps: ExtDeps, levels: RegionLevels, ways: DrawnWay[]): string => {
  const project = fit(KOREA_BBOX, 720, 540, 0.03);
  const segs: Seg[] = ways.map((w) => ({ pts: toLonLat(w.coords), style: isFaded(w.last, deps.now()) ? 'faded' : 'driven' }));
  return mapContent({ project, polys: regionPolys(deps, levels), segs, w: 720, h: 540, lineWidth: 1.5, thin: 0.7 });
};

export const nationalCard = (deps: ExtDeps, rawVehicleId: string): CardResult => {
  const roads = deps.getRoads();
  if (!roads) return { ok: false, status: 503, error: 'roads_db_unavailable' };
  const vehicleId = canonicalVehicleId(deps.db, rawVehicleId);
  const levels = ownerRegionLevels(deps.db, vehicleId);
  const cov = ownerCoverage(deps.db, roads, vehicleId);
  const regions = deps.getRegions();
  const sum = regions ? regionSummary(regionItems(deps.db, regions, levels)) : null;
  const revived = (
    deps.db
      .prepare(`SELECT COALESCE(SUM(w.eff_length_m), 0) AS m FROM way_revived r JOIN ${RD}.ways w ON w.way_id = r.way_id WHERE r.vehicle_id IN ${VEHICLE_SET_SQL}`)
      .get(vehicleId, vehicleId) as { m: number }
  ).m;
  const lines: string[] = [
    `전국 완료율 ${cov.nationalPercent}%`,
    sum ? `완주 도로 ${cov.roadsCompleted}개 · 시군구 ${sum.colored}/${sum.total}` : `완주 도로 ${cov.roadsCompleted}개`,
    sum ? `숙박 시군구 ${sum.byLevel['3']}곳` : '',
    revived > 0 ? `되살린 거리 ${km1(revived)}km` : '',
  ];
  const text: CardText = { label: '전국', lines: lines as CardText['lines'], aria: '전국 지도에 색칠한 도로와 시군구' };
  return { ok: true, svg: cardSvg(nationalMapInner(deps, levels, ownerWays(deps.db, vehicleId)), text), meta: { kind: 'national', label: '전국', lines: lines.filter(Boolean), aria: text.aria } };
};

/**
 * 여행 카드: 고른 트립의 궤적에서 출발·도착 반경 1km를 지우고(트립마다) '내 지역'을 숨긴 뒤 그 조각만 확대해 그린다.
 * 날짜는 월 단위, 좌표·way id는 SVG에 없다.
 */
export const tripCard = (deps: ExtDeps, rawVehicleId: string, tripIds: string[]): CardResult => {
  const { db } = deps;
  const vehicleId = canonicalVehicleId(db, rawVehicleId);
  const ids = [...new Set(tripIds)].slice(0, MAX_TRIP_IDS);
  const rows = db
    .prepare(
      `SELECT id, started_at FROM trips WHERE id IN (${ids.map(() => '?').join(',')}) AND vehicle_id IN ${VEHICLE_SET_SQL} ORDER BY started_at`,
    )
    .all(...ids, vehicleId, vehicleId) as { id: string; started_at: string }[];
  if (rows.length !== ids.length) return { ok: false, status: 404, error: 'trip_not_found' };
  const home = hiddenHome(deps, vehicleId);
  const regions = deps.getRegions();
  const runs: LonLat[][] = [];
  for (const t of rows) {
    const pts = db.prepare('SELECT lat, lon FROM trip_points WHERE trip_id = ? ORDER BY seq').all(t.id) as { lat: number; lon: number }[];
    if (pts.length < 2) continue;
    const a = pts[0]!;
    const b = pts.at(-1)!;
    let run: LonLat[] = [];
    let lastKept: { lat: number; lon: number } | null = null;
    for (const p of pts) {
      const cut = haversineM(a.lat, a.lon, p.lat, p.lon) <= TRIP_CUT_RADIUS_M || haversineM(b.lat, b.lon, p.lat, p.lon) <= TRIP_CUT_RADIUS_M;
      const inHome = !cut && home !== null && regions !== null && (() => { const c = regions.locate(p.lon, p.lat); return c !== null && regions.canonical(c) === home; })();
      if (cut || inHome) {
        if (run.length >= 2) runs.push(run);
        run = [];
        lastKept = null;
        continue;
      }
      // 30m 간격으로 솎는다
      if (lastKept === null || haversineM(lastKept.lat, lastKept.lon, p.lat, p.lon) >= 30) {
        run.push([p.lon, p.lat]);
        lastKept = p;
      }
    }
    if (run.length >= 2) runs.push(run);
  }
  if (runs.length === 0) return { ok: false, status: 409, error: 'too_short' };
  // 확대 범위: 남은 조각의 bbox(너무 좁으면 최소 약 11km로 넓힌다)
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const r of runs) for (const [lo, la] of r) {
    minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
  }
  const midLat = (minLat + maxLat) / 2;
  const minSpanLat = 0.1;
  const minSpanLon = 0.1 / Math.cos((midLat * Math.PI) / 180);
  const cx = (minLon + maxLon) / 2;
  const cy = midLat;
  const halfLon = Math.max((maxLon - minLon) / 2, minSpanLon / 2);
  const halfLat = Math.max((maxLat - minLat) / 2, minSpanLat / 2);
  const project = fit([cx - halfLon, cy - halfLat, cx + halfLon, cy + halfLat], 720, 540, 0.08);
  const inner = mapContent({ project, segs: runs.map((r) => ({ pts: r, style: 'trip' as const })), w: 720, h: 540, lineWidth: 8, thin: 1.5 });
  // 글줄: 새 도로 km, 지난 도로, 처음 지난 시군구
  const idList = `(${ids.map(() => '?').join(',')})`;
  const matched = db
    .prepare(`SELECT COALESCE(SUM(json_extract(result_json, '$.newKm')), 0) AS km FROM trip_matching WHERE status = 'done' AND result_json IS NOT NULL AND trip_id IN ${idList}`)
    .get(...ids) as { km: number };
  const touched = new Set<string>();
  for (const m of db.prepare(`SELECT result_json FROM trip_matching WHERE status = 'done' AND result_json IS NOT NULL AND trip_id IN ${idList}`).all(...ids) as { result_json: string }[]) {
    try {
      for (const k of (JSON.parse(m.result_json) as { roadsTouched?: string[] }).roadsTouched ?? []) touched.add(k);
    } catch {
      // 깨진 결과는 건너뛴다
    }
  }
  let roadNames: string[] = [];
  if (touched.size > 0 && deps.getRoads()) {
    const keys = [...touched];
    roadNames = (db.prepare(`SELECT display_name FROM ${RD}.roads WHERE road_key IN (${keys.map(() => '?').join(',')}) ORDER BY total_length_m DESC, road_key`).all(...keys) as { display_name: string }[]).map((r) => r.display_name);
  }
  const first = regions
    ? (db
        .prepare(
          `SELECT r.display_name AS n, r.code AS code FROM region_events e JOIN ${RG}.regions r ON r.code = e.code WHERE e.kind = 'pass' AND e.trip_id IN ${idList} GROUP BY r.code ORDER BY MIN(e.at)`,
        )
        .all(...ids) as { n: string; code: string }[]).filter((r) => r.code !== home)
    : [];
  const lines = [
    `새 도로 ${Math.round(matched.km * 10) / 10}km`,
    roadNames.length > 0 ? (roadNames.length > 1 ? `${roadNames[0]} 외 ${roadNames.length - 1}` : roadNames[0]!) : `${rows.length}번의 주행`,
    first.length > 0 ? `${first[0]!.n}${first.length > 1 ? ` 외 ${first.length - 1}곳` : ''} 첫 방문` : '',
  ];
  const label = monthLabel(rows[0]!.started_at);
  const text: CardText = { label, lines: lines as CardText['lines'], aria: '출발·도착을 지운 주행 경로 조각' };
  return { ok: true, svg: cardSvg(inner, text, { fade: true }), meta: { kind: 'trip', label, lines: lines.filter(Boolean), aria: text.aria } };
};

/** 도로 완주 카드: 완주(95% 이상)한 도로 전체만 그린다. 날짜는 월 단위. */
export const roadCard = (deps: ExtDeps, rawVehicleId: string, roadKey: string): CardResult => {
  const { db } = deps;
  const roads = deps.getRoads();
  if (!roads) return { ok: false, status: 503, error: 'roads_db_unavailable' };
  const vehicleId = canonicalVehicleId(db, rawVehicleId);
  const road = db.prepare(`SELECT road_key, display_name, total_length_m FROM ${RD}.roads WHERE road_key = ?`).get(roadKey) as
    | { road_key: string; display_name: string; total_length_m: number }
    | undefined;
  if (!road) return { ok: false, status: 404, error: 'road_not_found' };
  const ways = db
    .prepare(`WITH ${DRIVEN_CTE} SELECT w.geom_json, w.length_m, w.eff_length_m, d.cov, d.last FROM ${RD}.ways w LEFT JOIN d ON d.way_id = w.way_id WHERE w.road_key = ? ORDER BY w.way_id`)
    .all(vehicleId, vehicleId, roadKey) as { geom_json: string; length_m: number; eff_length_m: number; cov: number | null; last: string | null }[];
  // 완주 판정은 /coverage/roads와 같은 묶음 규칙(도로 DB 분리 구간 상한)을 따르도록 서버 집계 SQL을 그대로 쓴다.
  const pct = (
    db
      .prepare(
        `WITH ${DRIVEN_CTE}, r AS (
           SELECT MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN d.cov * w.length_m ELSE 0 END), ro.split_length_m)
             + MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN 0 ELSE d.cov * w.length_m END), ro.total_length_m - ro.split_length_m) AS driven, ro.total_length_m AS total
           FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id JOIN ${RD}.roads ro ON ro.road_key = w.road_key WHERE w.road_key = ? GROUP BY w.road_key
         ) SELECT driven / total AS p FROM r`,
      )
      .get(vehicleId, vehicleId, roadKey) as { p: number } | undefined
  )?.p;
  if (pct === undefined || pct * 100 < COMPLETE_PERCENT) return { ok: false, status: 409, error: 'not_completed' };
  const home = hiddenHome(deps, vehicleId);
  const regions = deps.getRegions();
  const segs: Seg[] = [];
  let lastMs = 0;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const w of ways) {
    const pts = toLonLat(JSON.parse(w.geom_json) as number[][]);
    if (pts.length < 2) continue;
    if (home && regions) {
      const mid = pts[Math.floor(pts.length / 2)]!;
      const c = regions.locate(mid[0], mid[1]);
      if (c && regions.canonical(c) === home) continue;
    }
    for (const [lo, la] of pts) { minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); }
    segs.push({ pts, style: w.cov && w.cov > 0 ? (isFaded(w.last, deps.now()) ? 'faded' : 'driven') : 'dim' });
    if (w.last) lastMs = Math.max(lastMs, Date.parse(w.last));
  }
  if (segs.length === 0) return { ok: false, status: 409, error: 'too_short' };
  const project = fit([minLon, minLat, maxLon, maxLat], 720, 540, 0.08);
  const inner = mapContent({ project, segs, w: 720, h: 540, lineWidth: 5, thin: 1.2 });
  const lines = [`${road.display_name} 완주`, `${Math.round(road.total_length_m / 100) / 10}km`, ''];
  const label = lastMs > 0 ? monthLabel(lastMs) : '';
  const text: CardText = { label, lines: lines as CardText['lines'], aria: '완주한 도로 전체' };
  return { ok: true, svg: cardSvg(inner, text), meta: { kind: 'road', label, lines: lines.filter(Boolean), aria: text.aria } };
};
