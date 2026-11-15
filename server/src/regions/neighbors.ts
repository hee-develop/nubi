import type { Db } from '../db/index.js';
import { RG, type Regions } from './index.js';

/** 경계를 공유한다고 보는 최소 거리(m). 시군구마다 따로 단순화(30m)돼 경계가 약간 벌어지므로 근사한다(가안). */
export const NEIGHBOR_MAX_DISTANCE_M = 50;
const M_PER_DEG = 111_195;

type Pt = [number, number];
type Bbox = [number, number, number, number];

const bboxOf = (polys: number[][][][]): Bbox => {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const p of polys)
    for (const [x, y] of p[0]!) {
      if (x! < a) a = x!;
      if (x! > c) c = x!;
      if (y! < b) b = y!;
      if (y! > d) d = y!;
    }
  return [a, b, c, d];
};

const within = (x: number, y: number, bb: Bbox, m: number) => x >= bb[0] - m && x <= bb[2] + m && y >= bb[1] - m && y <= bb[3] + m;

/** 점-선분 거리(m, 국소 평면 근사). */
const pointSegM = (p: Pt, a: Pt, b: Pt, cosLat: number) => {
  const px = (p[0] - a[0]) * cosLat,
    py = p[1] - a[1];
  const dx = (b[0] - a[0]) * cosLat,
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
  return Math.hypot(px - t * dx, py - t * dy) * M_PER_DEG;
};

/** 두 시군구 폴리곤 사이의 최소 거리(m, [limitM]를 넘으면 Infinity). bbox가 가까운 정점·간선만 비교한다. */
export const polygonDistanceM = (A: number[][][][], B: number[][][][], limitM = NEIGHBOR_MAX_DISTANCE_M): number => {
  const bbA = bboxOf(A),
    bbB = bboxOf(B);
  const margin = limitM / M_PER_DEG;
  const cosLat = Math.cos((((bbA[1] + bbA[3]) / 2) * Math.PI) / 180);
  const ring = (polys: number[][][][], other: Bbox) => {
    const verts: Pt[] = [];
    const segs: [Pt, Pt][] = [];
    for (const p of polys)
      for (const r of p) {
        for (let i = 0; i < r.length; i++) {
          const v = r[i] as Pt;
          if (within(v[0], v[1], other, margin)) {
            verts.push(v);
            // 정점에 붙은 두 간선을 함께 담아야 정점이 간선 중간에 닿는 경우를 잡는다.
            if (i > 0) segs.push([r[i - 1] as Pt, v]);
            if (i + 1 < r.length) segs.push([v, r[i + 1] as Pt]);
          }
        }
      }
    return { verts, segs };
  };
  const a = ring(A, bbB);
  const b = ring(B, bbA);
  let best = Infinity;
  for (const v of a.verts) for (const [s, e] of b.segs) best = Math.min(best, pointSegM(v, s, e, cosLat));
  if (best > limitM) for (const v of b.verts) for (const [s, e] of a.segs) best = Math.min(best, pointSegM(v, s, e, cosLat));
  return best <= limitM ? best : Infinity;
};

const cache = new WeakMap<Regions, Map<string, { code: string; distanceM: number }[]>>();

/** 경계를 공유하는 시군구(bbox 교차 후보 → 폴리곤 최소 거리 < 50m). 경계 데이터는 고정이라 결과를 캐시한다. */
export const neighborsOf = (db: Db, regions: Regions, code: string): { code: string; distanceM: number }[] | null => {
  const target = regions.polygons(code);
  if (!target) return null;
  let perRegions = cache.get(regions);
  if (!perRegions) cache.set(regions, (perRegions = new Map()));
  const hit = perRegions.get(code);
  if (hit) return hit;
  const bb = bboxOf(target);
  const m = NEIGHBOR_MAX_DISTANCE_M / M_PER_DEG;
  const cands = db
    .prepare(
      `SELECT r.code FROM ${RG}.regions_rtree t JOIN ${RG}.regions r ON r.rowid = t.region_id
              WHERE t.minlon <= ? AND t.maxlon >= ? AND t.minlat <= ? AND t.maxlat >= ? AND r.code != ?`,
    )
    .all(bb[2] + m, bb[0] - m, bb[3] + m, bb[1] - m, code) as { code: string }[];
  const out: { code: string; distanceM: number }[] = [];
  for (const c of cands) {
    const poly = regions.polygons(c.code);
    if (!poly) continue;
    const d = polygonDistanceM(target, poly);
    if (d < NEIGHBOR_MAX_DISTANCE_M) out.push({ code: c.code, distanceM: Math.round(d) });
  }
  perRegions.set(code, out);
  return out;
};

/**
 * 이웃이 하나도 없는 시군구(섬 등)의 대체: 중심점(bbox 중심) 거리순 가장 가까운 [count]곳. 응답에서 `nearest: true`로 표시한다.
 */
export const nearestRegions = (db: Db, code: string, count = 3): { code: string; distanceM: number }[] => {
  const rows = db.prepare(`SELECT code, minlon, minlat, maxlon, maxlat FROM ${RG}.regions`).all() as {
    code: string;
    minlon: number;
    minlat: number;
    maxlon: number;
    maxlat: number;
  }[];
  const me = rows.find((r) => r.code === code);
  if (!me) return [];
  const cx = (me.minlon + me.maxlon) / 2,
    cy = (me.minlat + me.maxlat) / 2;
  const cos = Math.cos((cy * Math.PI) / 180);
  return rows
    .filter((r) => r.code !== code)
    .map((r) => ({
      code: r.code,
      distanceM: Math.round(Math.hypot(((r.minlon + r.maxlon) / 2 - cx) * cos, (r.minlat + r.maxlat) / 2 - cy) * M_PER_DEG),
    }))
    .sort((a, b) => a.distanceM - b.distanceM || (a.code < b.code ? -1 : 1))
    .slice(0, count);
};
