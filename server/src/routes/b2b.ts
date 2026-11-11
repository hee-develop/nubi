import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { clientKey, RateLimiter } from '../ext/auth.js';
import { esc, htmlResponse, page } from '../ext/html.js';
import { DAY_MS, iso, kstMonthRange, KST_MS, parseBody, type ExtDeps } from '../ext/util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { RG, type Regions } from '../regions/index.js';
import { RD } from '../roads/index.js';
import { COMPLETE_PERCENT } from './coverage.js';

/** k-익명성 하한(plan 7-4, 가안): 5대 미만인 칸은 숨긴다. */
export const K_MIN = 5;
/** 체류 기준: 그 시군구에서 하루 정차 합계 3시간 이상(정부 체류인구 정의, plan 7-4). */
export const DWELL_MS = 3 * 3_600_000;
/** 정차 간격이 이보다 길면 장기 주차로 보고 체류로 세지 않는다. */
const MAX_PARK_MS = 7 * DAY_MS;

const roadKeys = z.array(z.string().min(1).max(200)).min(1).max(100);
const courseBody = z.object({ name: z.string().trim().min(1).max(60), regionCode: z.string().regex(/^\d{5}$/), roadKeys });

const eqKey = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** 도로 묶음 규칙(사양 02)으로 차량별 도로 완주를 센다. `r(vid, road_key, total, driven, last)`. 바인딩: road_key 목록. */
const COURSE_SQL = (n: number) => `
  WITH d AS (
    SELECT COALESCE(a.vehicle_id, dw.vehicle_id) AS vid, dw.way_id, MAX(dw.coverage) AS cov, MAX(dw.last_driven_at) AS last
    FROM driven_ways dw LEFT JOIN vehicle_alias a ON a.alias_id = dw.vehicle_id
    WHERE dw.way_id IN (SELECT way_id FROM ${RD}.ways WHERE road_key IN (${Array(n).fill('?').join(',')})) GROUP BY vid, dw.way_id
  ), r AS (
    SELECT d.vid, w.road_key, ro.total_length_m AS total,
      MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN d.cov * w.length_m ELSE 0 END), ro.split_length_m)
      + MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN 0 ELSE d.cov * w.length_m END), ro.total_length_m - ro.split_length_m) AS driven,
      MAX(d.last) AS last
    FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id JOIN ${RD}.roads ro ON ro.road_key = w.road_key GROUP BY d.vid, w.road_key
  )`;

type Course = { id: string; name: string; region_code: string; road_keys: string[] };

const loadCourse = (deps: ExtDeps, id: string): Course | undefined => {
  const r = deps.db.prepare('SELECT id, name, region_code, road_keys_json FROM courses WHERE id = ?').get(id) as
    | { id: string; name: string; region_code: string; road_keys_json: string }
    | undefined;
  return r ? { id: r.id, name: r.name, region_code: r.region_code, road_keys: JSON.parse(r.road_keys_json) as string[] } : undefined;
};

/** 코스를 완주한 차량(정본 ID)과 완주 시각(코스 도로 중 가장 늦은 마지막 인정, 근사). */
const completers = (deps: ExtDeps, course: Course, onlyVehicle?: string): { vid: string; last: string }[] =>
  deps.db
    .prepare(
      `${COURSE_SQL(course.road_keys.length)}
       SELECT vid, MAX(last) AS last FROM r WHERE driven >= total * ? ${onlyVehicle ? 'AND vid = ?' : ''} GROUP BY vid HAVING COUNT(*) = ?`,
    )
    .all(...course.road_keys, COMPLETE_PERCENT / 100, ...(onlyVehicle ? [onlyVehicle] : []), course.road_keys.length) as { vid: string; last: string }[];

/** 통계에서 빠지는 차량: 익명 통계 참여를 끈 차량, '내 지역'이 그 시군구인 차량(plan 7-4, 11-2). */
const excluded = (deps: ExtDeps, regions: Regions | null, regionCode: string): Set<string> => {
  const out = new Set<string>();
  for (const r of deps.db.prepare('SELECT vehicle_id, home_region, stats_opt_in FROM vehicle_settings').all() as { vehicle_id: string; home_region: string | null; stats_opt_in: number }[]) {
    const home = r.home_region ? (regions ? regions.canonical(r.home_region) : r.home_region) : null;
    if (r.stats_opt_in === 0 || home === regionCode) out.add(r.vehicle_id);
  }
  return out;
};

const cell = (n: number) => (n >= K_MIN ? { vehicles: n } : { vehicles: null, suppressed: true as const });

/** 시군구 월간 집계(plan 7-4): 통과·방문·숙박 차량 수, 체류 3시간 차량 수. 차량 단위·월 단위, 5대 미만 칸은 숨기고 개인 식별 정보는 없다. */
export const regionMonthly = (deps: ExtDeps, regions: Regions, code: string, month: string) => {
  const { db } = deps;
  const range = kstMonthRange(month)!;
  const [from, to] = range;
  const canon = (v: string) => canonicalVehicleId(db, v);
  const skip = excluded(deps, regions, code);
  const codes = [code, ...[...regions.alias].filter(([, nw]) => nw === code).map(([old]) => old)];
  const inCodes = `(${codes.map(() => '?').join(',')})`;
  const vehicles = (rows: { vehicle_id: string }[]) => new Set(rows.map((r) => canon(r.vehicle_id)).filter((v) => !skip.has(v)));

  const pass = vehicles(
    db
      .prepare(
        `SELECT DISTINCT t.vehicle_id FROM trips t JOIN trip_matching m ON m.trip_id = t.id, json_each(m.result_json, '$.regions.passed') j
         WHERE m.status = 'done' AND t.started_at >= ? AND t.started_at < ? AND j.value IN ${inCodes}`,
      )
      .all(iso(from), iso(to), ...codes) as { vehicle_id: string }[],
  );
  const byKind = (kind: 'visit' | 'stay') =>
    vehicles(
      db
        .prepare(`SELECT DISTINCT vehicle_id FROM region_events WHERE kind = ? AND at >= ? AND at < ? AND code IN ${inCodes}`)
        .all(kind, iso(from), iso(to), ...codes) as { vehicle_id: string }[],
    );
  const visit = byKind('visit');
  const stay = byKind('stay');
  const dwell = dwellVehicles(deps, regions, code, from, to, skip);
  return {
    code,
    displayName: regions.names().get(code)?.displayName ?? code,
    month,
    k: K_MIN,
    pass: cell(pass.size),
    visit: cell(visit.size),
    stay: cell(stay.size),
    dwell3h: cell(dwell.size),
  };
};

/** 그 시군구에서 하루(KST) 정차 합계가 3시간 이상인 날이 있는 차량. 정차 = 트립 종료~다음 트립 시작(종료 지점이 그 시군구), 7일 넘는 간격은 제외. */
const dwellVehicles = (deps: ExtDeps, regions: Regions, code: string, from: number, to: number, skip: Set<string>): Set<string> => {
  const { db } = deps;
  const box = db.prepare(`SELECT minlon, minlat, maxlon, maxlat FROM ${RG}.regions WHERE code = ?`).get(code) as { minlon: number; minlat: number; maxlon: number; maxlat: number } | undefined;
  const out = new Set<string>();
  if (!box) return out;
  const trips = db
    .prepare('SELECT id, vehicle_id, started_at, ended_at FROM trips WHERE started_at >= ? ORDER BY started_at')
    .all(iso(from - MAX_PARK_MS)) as { id: string; vehicle_id: string; started_at: string; ended_at: string | null }[];
  const byVehicle = new Map<string, typeof trips>();
  for (const t of trips) {
    const v = canonicalVehicleId(db, t.vehicle_id);
    byVehicle.set(v, [...(byVehicle.get(v) ?? []), t]);
  }
  const lastPoint = db.prepare('SELECT lat, lon FROM trip_points WHERE trip_id = ? ORDER BY seq DESC LIMIT 1');
  const capEnd = Math.min(deps.now(), to);
  for (const [v, list] of byVehicle) {
    if (skip.has(v) || out.has(v)) continue;
    const perDay = new Map<number, number>();
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (!t.ended_at) continue;
      const endMs = Date.parse(t.ended_at);
      const nextStart = list[i + 1] ? Date.parse(list[i + 1]!.started_at) : null;
      const gapEnd = nextStart ?? capEnd;
      if (gapEnd <= endMs || gapEnd - endMs > MAX_PARK_MS) continue;
      const lo = Math.max(endMs, from);
      const hi = Math.min(gapEnd, to);
      if (hi <= lo) continue;
      const p = lastPoint.get(t.id) as { lat: number; lon: number } | undefined;
      if (!p || p.lon < box.minlon || p.lon > box.maxlon || p.lat < box.minlat || p.lat > box.maxlat) continue;
      const loc = regions.locate(p.lon, p.lat);
      if (!loc || regions.canonical(loc) !== code) continue;
      for (let t0 = lo; t0 < hi; ) {
        const day = Math.floor((t0 + KST_MS) / DAY_MS);
        const dayEnd = (day + 1) * DAY_MS - KST_MS;
        const seg = Math.min(hi, dayEnd) - t0;
        perDay.set(day, (perDay.get(day) ?? 0) + seg);
        t0 += seg;
      }
    }
    if ([...perDay.values()].some((ms) => ms >= DWELL_MS)) out.add(v);
  }
  return out;
};

/** 인증 번호: 코스·차량의 해시(차량 ID는 되돌릴 수 없고 날짜는 없다). */
const certNo = (courseId: string, vehicleId: string) => `NB-${createHash('sha256').update(`${courseId}:${vehicleId}:nubi-cert`).digest('hex').slice(0, 10).toUpperCase()}`;

/** B2B(지자체) API와 코스 완주 인증서. B2B는 `Authorization: Bearer <NUBI_B2B_KEY>` 필수(없으면 503). */
export const b2bRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const fails = new RateLimiter(20, 5 * 60_000, now);
  const key = () => deps.options.b2bKey ?? process.env.NUBI_B2B_KEY;
  /** 통과하면 null, 아니면 응답. */
  const guard = (c: Context): Response | null => {
    const k = key();
    if (!k) return c.json({ error: 'b2b_not_configured' }, 503);
    const who = clientKey(c);
    if (fails.blocked(who)) return c.json({ error: 'too_many_requests' }, 429);
    const m = /^Bearer\s+(\S{1,256})$/.exec(c.req.header('authorization') ?? '');
    if (!m || !eqKey(m[1]!, k)) {
      fails.record(who);
      return c.json({ error: 'unauthorized' }, 401);
    }
    return null;
  };
  const lengthKm = (keys: string[]) =>
    deps.getRoads() ? Math.round(((db.prepare(`SELECT COALESCE(SUM(total_length_m), 0) AS m FROM ${RD}.roads WHERE road_key IN (${keys.map(() => '?').join(',')})`).get(...keys) as { m: number }).m / 1000) * 10) / 10 : null;
  const courseJson = (c: Course) => ({ id: c.id, name: c.name, regionCode: c.region_code, roadKeys: c.road_keys, lengthKm: lengthKm(c.road_keys) });

  return new Hono()
    .get('/b2b/regions/:code/monthly', (c) => {
      const denied = guard(c);
      if (denied) return denied;
      const regions = deps.getRegions();
      if (!regions) return c.json({ error: 'regions_db_unavailable' }, 503);
      if (!/^\d{5}$/.test(c.req.param('code'))) return c.json({ error: 'invalid_code' }, 400);
      const code = regions.canonical(c.req.param('code'));
      if (!regions.names().has(code)) return c.json({ error: 'not_found' }, 404);
      const month = c.req.query('month') ?? '';
      if (!kstMonthRange(month)) return c.json({ error: 'invalid_month' }, 400);
      return c.json(regionMonthly(deps, regions, code, month), 200);
    })
    .post('/b2b/courses', async (c) => {
      const denied = guard(c);
      if (denied) return denied;
      const p = await parseBody(c, courseBody);
      if (!p.ok) return p.res;
      const regions = deps.getRegions();
      const code = regions ? regions.canonical(p.data.regionCode) : p.data.regionCode;
      if (regions && !regions.names().has(code)) return c.json({ error: 'invalid_region' }, 400);
      const keys = [...new Set(p.data.roadKeys)];
      if (deps.getRoads()) {
        const found = (db.prepare(`SELECT COUNT(*) AS n FROM ${RD}.roads WHERE road_key IN (${keys.map(() => '?').join(',')})`).get(...keys) as { n: number }).n;
        if (found !== keys.length) return c.json({ error: 'unknown_road' }, 400);
      }
      const id = randomBytes(8).toString('base64url');
      db.prepare('INSERT INTO courses (id, name, region_code, road_keys_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, p.data.name, code, JSON.stringify(keys), iso(now()));
      return c.json(courseJson({ id, name: p.data.name, region_code: code, road_keys: keys }), 201);
    })
    .get('/b2b/courses', (c) => {
      const denied = guard(c);
      if (denied) return denied;
      const ids = db.prepare('SELECT id FROM courses ORDER BY created_at, id').all() as { id: string }[];
      return c.json({ items: ids.map((r) => courseJson(loadCourse(deps, r.id)!)) }, 200);
    })
    .get('/b2b/courses/:id/completions', (c) => {
      const denied = guard(c);
      if (denied) return denied;
      const course = loadCourse(deps, c.req.param('id'));
      if (!course) return c.json({ error: 'not_found' }, 404);
      const month = c.req.query('month') ?? '';
      const range = kstMonthRange(month);
      if (!range) return c.json({ error: 'invalid_month' }, 400);
      if (!deps.getRoads()) return c.json({ error: 'roads_db_unavailable' }, 503);
      const skip = excluded(deps, deps.getRegions(), course.region_code);
      const n = completers(deps, course).filter((r) => !skip.has(r.vid) && Date.parse(r.last) >= range[0] && Date.parse(r.last) < range[1]).length;
      return c.json({ courseId: course.id, name: course.name, month, k: K_MIN, ...cell(n) }, 200);
    })
    // 공개 코스 목록(폰·차량이 보여 줄 이름과 시군구만, 도로 키는 내보내지 않는다)
    .get('/courses', (c) => {
      const items = (db.prepare('SELECT id FROM courses ORDER BY created_at, id').all() as { id: string }[]).map((r) => {
        const x = loadCourse(deps, r.id)!;
        return { id: x.id, name: x.name, regionCode: x.region_code, lengthKm: lengthKm(x.road_keys) };
      });
      return c.json({ items }, 200);
    })
    // 코스 완주 인증서(HTML, plan 13-7 시안 05). 차량 ID·운전자·날짜는 싣지 않는다.
    .get('/courses/:id/certificate', (c) => {
      const raw = c.req.query('vehicleId');
      if (!raw) return htmlResponse(c, page({ title: '인증서', body: `<div class="logo">누비</div><div class="card err"><p>차량 정보가 필요합니다.</p></div>` }), 400);
      const course = loadCourse(deps, c.req.param('id'));
      if (!course) return htmlResponse(c, page({ title: '인증서', body: `<div class="logo">누비</div><div class="card err"><p>코스를 찾을 수 없습니다.</p></div>` }), 404);
      if (!deps.getRoads()) return htmlResponse(c, page({ title: '인증서', body: `<div class="logo">누비</div><div class="card err"><p>도로 데이터를 아직 쓸 수 없습니다.</p></div>` }), 503);
      const vehicleId = canonicalVehicleId(db, raw);
      if (completers(deps, course, vehicleId).length === 0)
        return htmlResponse(c, page({ title: '코스 완주 인증서', body: `<div class="logo">누비</div><div class="card err"><p>아직 이 코스를 완주하지 않았습니다.</p></div>` }), 409);
      const regions = deps.getRegions();
      const km = lengthKm(course.road_keys);
      const rn = regions?.names().get(course.region_code)?.displayName ?? course.region_code;
      const body = `<div class="logo">누비</div>
<p class="muted">차량 검증 코스 완주 인증</p>
<h1>코스 완주 인증서</h1>
<div class="card"><p style="color:var(--amber);font-size:22px;font-weight:800;margin:0">${esc(course.name)}${km !== null ? ` (차량 ${km}km)` : ''}</p></div>
<div class="card">
<p class="muted">인증 번호</p><p><b>${esc(certNo(course.id, vehicleId))}</b></p>
<p class="muted">완주 구간</p><p><b style="font-size:28px;color:var(--fresh)">100%</b> <span class="muted">(코스 도로 ${course.road_keys.length}개 모두 완주)</span></p>
<p class="muted">판정 근거</p><p><b>차량 위치·기어·오도미터로 검증</b></p>
<p class="muted">제휴 지자체</p><p><b>${esc(rn)}</b></p>
<p class="muted">표시 안 함</p><p><b>차량 ID · 운전자 · 날짜</b></p>
</div>
<div class="card" style="text-align:center"><div style="border:3px dashed #5b6b80;border-radius:14px;padding:36px 8px"><b>지자체 혜택 QR</b><br><span class="muted">(자리)</span></div></div>
<p class="foot">© OpenStreetMap contributors · 누비</p>`;
      return htmlResponse(c, page({ title: '코스 완주 인증서', body, description: `${course.name} 코스 완주 인증` }));
    });
};
