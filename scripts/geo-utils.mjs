// 시군구 판정 공용 도구(사양 03). 빌드 스크립트·verify·서버(src/regions)가 모두 이 파일 하나를 import 한다(복사 금지).
// 외부 의존성 없음. DB 핸들은 node:sqlite DatabaseSync 모양(prepare().all/get)이면 된다.

/** 점이 고리 안인가(ray casting). */
export function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i],
      [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** MultiPolygon 좌표(폴리곤 배열) 안 판정: 폴리곤 any, 바깥 고리 안 + 구멍 밖. */
export function pointInMulti(x, y, polys) {
  for (const p of polys) {
    if (!pointInRing(x, y, p[0])) continue;
    let hole = false;
    for (let k = 1; k < p.length; k++)
      if (pointInRing(x, y, p[k])) {
        hole = true;
        break;
      }
    if (!hole) return true;
  }
  return false;
}

const M_PER_DEG = 111_195;

/** 점에서 MultiPolygon 모든 고리(바깥·구멍)의 간선까지 최소 거리(m, 국소 평면 근사). */
export function distanceToMultiM(x, y, polys) {
  const cosLat = Math.cos((y * Math.PI) / 180);
  let best = Infinity;
  for (const p of polys)
    for (const r of p)
      for (let i = 1; i < r.length; i++) {
        const ax = (r[i - 1][0] - x) * cosLat,
          ay = r[i - 1][1] - y;
        const dx = (r[i][0] - r[i - 1][0]) * cosLat,
          dy = r[i][1] - r[i - 1][1];
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        const d = Math.hypot(ax + t * dx, ay + t * dy) * M_PER_DEG;
        if (d < best) best = d;
      }
  return best;
}

/** 경계 틈(단순화로 시군구 사이가 벌어짐)을 메우는 허용 거리(m). */
export const GAP_FIX_M = 50;

/**
 * 시군구 판정기. [db]는 regions·regions_rtree 가 있는 연결, [schema]는 ATTACH 이름(`rg` 등, 없으면 빈 문자열).
 * `locate(lon, lat)`: ① 폴리곤 안(여럿이면 `ORDER BY code` 첫째) ② 없으면 [maxGapM] 이내에서 가장 가까운 시군구(동률은 code 순) ③ 없으면 null.
 * 반환 행: `{ code, name, display_name, sido_code, sido_name }`.
 */
export function makeLocator(db, { schema = '', maxGapM = GAP_FIX_M } = {}) {
  const p = schema ? `${schema}.` : '';
  const cols = 'r.code, r.name, r.display_name, r.sido_code, r.sido_name';
  const rtree = (where) =>
    db.prepare(`SELECT ${cols} FROM ${p}regions_rtree t JOIN ${p}regions r ON r.rowid = t.region_id WHERE ${where} ORDER BY r.code`);
  const exact = rtree('t.minlon <= ? AND t.maxlon >= ? AND t.minlat <= ? AND t.maxlat >= ?');
  const near = rtree('t.minlon <= ? AND t.maxlon >= ? AND t.minlat <= ? AND t.maxlat >= ?');
  const geomOf = db.prepare(`SELECT geom_json FROM ${p}regions WHERE code = ?`);
  const cache = new Map();
  const polygons = (code) => {
    let g = cache.get(code);
    if (g === undefined) {
      const row = geomOf.get(code);
      g = row ? JSON.parse(row.geom_json).coordinates : null;
      cache.set(code, g);
    }
    return g;
  };
  const locate = (lon, lat) => {
    for (const r of exact.all(lon, lon, lat, lat)) {
      const g = polygons(r.code);
      if (g && pointInMulti(lon, lat, g)) return r;
    }
    if (!(maxGapM > 0)) return null;
    const dLat = maxGapM / M_PER_DEG,
      dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
    let best = null,
      bestD = Infinity;
    for (const r of near.all(lon + dLon, lon - dLon, lat + dLat, lat - dLat)) {
      const g = polygons(r.code);
      if (!g) continue;
      const d = distanceToMultiM(lon, lat, g);
      if (d <= maxGapM && d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best;
  };
  return { locate, polygons };
}

/** 시도 코드 → 단축명(사양 03 3장 표시 이름 규칙). 옛 광주(29)·전남(46)·강원(42)·전북(45)도 같이 둔다. */
export const SIDO_SHORT = {
  11: '서울',
  26: '부산',
  27: '대구',
  28: '인천',
  29: '전남광주',
  30: '대전',
  31: '울산',
  36: '세종',
  41: '경기',
  42: '강원',
  51: '강원',
  43: '충북',
  44: '충남',
  45: '전북',
  52: '전북',
  46: '전남광주',
  47: '경북',
  48: '경남',
  50: '제주',
  12: '전남광주',
};

/**
 * 시군구 표시 이름: 이름이 전국에서 유일하지 않거나 `구`로 끝나면 시도 단축명 접두("서울 중구"), 아니면 그대로("홍천군").
 * [all]은 전국 시군구 `{ code, name, sidoCode }[]`(유일성 판단 기준). [region]은 그 중 하나.
 */
export function regionDisplayName(region, all) {
  const dup = all.filter((r) => r.name === region.name).length > 1;
  const short = SIDO_SHORT[region.sidoCode];
  return (dup || region.name.endsWith('구')) && short ? `${short} ${region.name}` : region.name;
}
