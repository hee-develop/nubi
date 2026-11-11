import { Hono } from 'hono';
import { clientKey, RateLimiter } from '../ext/auth.js';
import { fetchTourItems, KINDS, sampleItems, TourApiError, type IntroItem } from '../ext/tourapi.js';
import { KST_MS, type ExtDeps } from '../ext/util.js';
import { RG, REGIONS_ATTRIBUTION } from '../regions/index.js';

const DECIMAL = /^-?\d{1,3}(\.\d{1,10})?$/;
const SOURCE = '한국관광공사';

/** 지역 소개 카드(plan 10-2): TourAPI 결과(하루 캐시)를 관광지·축제·음식점으로 낸다. 키가 없으면 시군구별 고정 예시(sample: true). */
/** 캐시 유효 시간(plan 10-2 하루 한 번). */
export const INTRO_TTL_MS = 24 * 3_600_000;
/** 하루에 TourAPI를 부르는 횟수 상한(키 소진·남용 방지). 캐시 적중은 세지 않는다. */
export const INTRO_DAILY_CALLS = 1_000;
const EARTH_M = 111_195;
const round2 = (n: number) => Math.round(n * 100) / 100;

const distanceM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.round(Math.hypot((b.lat - a.lat) * EARTH_M, (b.lon - a.lon) * EARTH_M * Math.cos((a.lat * Math.PI) / 180)));

/**
 * 지역 소개 카드(plan 10-2): TourAPI 결과를 관광지·축제·음식점으로 낸다. 키가 없으면 시군구별 고정 예시(sample: true).
 * 개인정보: 차량 위치(`lat`·`lon`)는 시군구 bbox 안이어야 하고 외부로 나가지 않는다(외부 호출은 시군구 중심의 0.01도 반올림 좌표).
 * 캐시는 (시군구·종류) 단위 24시간이고, 거리는 캐시와 무관하게 요청마다 정확한 위치에서 다시 계산한다.
 */
export const introRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const key = () => deps.options.tourApiKey ?? process.env.NUBI_TOURAPI_KEY;
  const limiter = new RateLimiter(deps.options.rateLimit?.max ? deps.options.rateLimit.max * 2 : 20, deps.options.rateLimit?.windowMs ?? 5 * 60_000, now);
  return new Hono().get('/regions/:code/intro', async (c) => {
    const regions = deps.getRegions();
    if (!regions) return c.json({ error: 'regions_db_unavailable' }, 503);
    const raw = c.req.param('code');
    if (!/^\d{5}$/.test(raw)) return c.json({ error: 'invalid_code' }, 400);
    const code = regions.canonical(raw);
    const row = db.prepare(`SELECT display_name, minlon, minlat, maxlon, maxlat FROM ${RG}.regions WHERE code = ?`).get(code) as
      | { display_name: string; minlon: number; minlat: number; maxlon: number; maxlat: number }
      | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    const who = clientKey(c);
    if (limiter.blocked(who)) return c.json({ error: 'rate_limited' }, 429);
    limiter.record(who);
    const center = { lat: (row.minlat + row.maxlat) / 2, lon: (row.minlon + row.maxlon) / 2 };
    // 기준 위치(가까운 순 정렬용): 차량 현재 위치(lat·lon)가 오면 그것(그 시군구 bbox 안이어야 한다), 없으면 시군구 중심
    const latRaw = c.req.query('lat');
    const lonRaw = c.req.query('lon');
    let from = center;
    if (latRaw !== undefined || lonRaw !== undefined) {
      if (!DECIMAL.test(latRaw ?? '') || !DECIMAL.test(lonRaw ?? '') || Math.abs(Number(latRaw)) > 90 || Math.abs(Number(lonRaw)) > 180) return c.json({ error: 'invalid_point' }, 400);
      from = { lat: Number(latRaw), lon: Number(lonRaw) };
      if (from.lat < row.minlat || from.lat > row.maxlat || from.lon < row.minlon || from.lon > row.maxlon) return c.json({ error: 'invalid_point' }, 400);
    }
    const base = { code, displayName: row.display_name, source: SOURCE, attribution: REGIONS_ATTRIBUTION };
    const k = key();
    if (!k) return c.json({ ...base, sample: true as const, items: sampleItems(code, row.display_name, center, from) }, 200);

    // 외부 호출·캐시는 **시군구 단위**(좌표와 무관): 시군구 중심을 반올림한 좌표로 부른다. 요청 좌표를 바꿔도 캐시를 피하지 못하고 외부로 나가지 않는다.
    const ref = { lat: round2(center.lat), lon: round2(center.lon) };
    const day = new Date(now() + KST_MS).toISOString().slice(0, 10);
    const items: IntroItem[] = [];
    try {
      for (const kind of KINDS) {
        const cacheKey = `${code}|${kind}`;
        const cached = db.prepare('SELECT fetched_at, body_json FROM intro_cache WHERE cache_key = ?').get(cacheKey) as { fetched_at: number; body_json: string } | undefined;
        let got: IntroItem[];
        if (cached && now() - cached.fetched_at < INTRO_TTL_MS) got = JSON.parse(cached.body_json) as IntroItem[];
        else {
          const used = (db.prepare('SELECT n FROM intro_calls WHERE day = ?').get(day) as { n: number } | undefined)?.n ?? 0;
          if (used >= INTRO_DAILY_CALLS) return c.json({ error: 'rate_limited' }, 429);
          db.prepare('INSERT INTO intro_calls (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1').run(day);
          // 외부에는 반올림한 좌표만 보낸다
          got = (await fetchTourItems(kind, ref.lat, ref.lon, k, deps.options.fetchFn)).map(({ distanceM: _d, ...it }) => it);
          db.prepare('INSERT INTO intro_cache (cache_key, day, body_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (cache_key) DO UPDATE SET day = excluded.day, body_json = excluded.body_json, fetched_at = excluded.fetched_at').run(
            cacheKey,
            day,
            JSON.stringify(got),
            now(),
          );
        }
        // 거리는 정확한 기준 위치에서 요청마다 다시 계산한다
        items.push(...got.map((it) => ({ ...it, distanceM: distanceM(from, it) })).sort((a, b) => a.distanceM - b.distanceM));
      }
    } catch (e) {
      // 키·URL은 메시지에 없다(TourApiError는 분류 코드만). 로그에는 분류만 남긴다.
      console.warn(`TourAPI 호출 실패: ${e instanceof TourApiError ? e.message : 'unknown'}`);
      return c.json({ error: 'tourapi_unavailable' }, 502);
    }
    return c.json({ ...base, sample: false as const, items }, 200);
  });
};
