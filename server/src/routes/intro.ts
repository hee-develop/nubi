import { Hono } from 'hono';
import { fetchTourItems, KINDS, sampleItems, TourApiError, type IntroItem } from '../ext/tourapi.js';
import { KST_MS, type ExtDeps } from '../ext/util.js';
import { RG, REGIONS_ATTRIBUTION } from '../regions/index.js';

const DECIMAL = /^-?\d{1,3}(\.\d{1,10})?$/;
const SOURCE = '한국관광공사';

/** 지역 소개 카드(plan 10-2): TourAPI 결과(하루 캐시)를 관광지·축제·음식점으로 낸다. 키가 없으면 시군구별 고정 예시(sample: true). */
export const introRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const key = () => deps.options.tourApiKey ?? process.env.NUBI_TOURAPI_KEY;
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
    const center = { lat: (row.minlat + row.maxlat) / 2, lon: (row.minlon + row.maxlon) / 2 };
    // 기준 위치(가까운 순 정렬용): 차량 현재 위치(lat·lon)가 오면 그것, 없으면 시군구 중심
    const latRaw = c.req.query('lat');
    const lonRaw = c.req.query('lon');
    let from = center;
    if (latRaw !== undefined || lonRaw !== undefined) {
      if (!DECIMAL.test(latRaw ?? '') || !DECIMAL.test(lonRaw ?? '') || Math.abs(Number(latRaw)) > 90 || Math.abs(Number(lonRaw)) > 180) return c.json({ error: 'invalid_point' }, 400);
      from = { lat: Number(latRaw), lon: Number(lonRaw) };
    }
    const base = { code, displayName: row.display_name, source: SOURCE, attribution: REGIONS_ATTRIBUTION };
    const k = key();
    if (!k) return c.json({ ...base, sample: true as const, items: sampleItems(code, row.display_name, center, from) }, 200);

    const day = new Date(now() + KST_MS).toISOString().slice(0, 10);
    const ref = `${Math.round(from.lat * 100) / 100},${Math.round(from.lon * 100) / 100}`;
    const items: IntroItem[] = [];
    try {
      for (const kind of KINDS) {
        const cacheKey = `${code}|${ref}|${kind}`;
        const cached = db.prepare('SELECT day, body_json FROM intro_cache WHERE cache_key = ?').get(cacheKey) as { day: string; body_json: string } | undefined;
        if (cached && cached.day === day) {
          items.push(...(JSON.parse(cached.body_json) as IntroItem[]));
          continue;
        }
        const got = await fetchTourItems(kind, from.lat, from.lon, k, deps.options.fetchFn);
        db.prepare('INSERT INTO intro_cache (cache_key, day, body_json) VALUES (?, ?, ?) ON CONFLICT (cache_key) DO UPDATE SET day = excluded.day, body_json = excluded.body_json').run(
          cacheKey,
          day,
          JSON.stringify(got),
        );
        items.push(...got);
      }
    } catch (e) {
      // 키·URL은 메시지에 없다(TourApiError는 분류 코드만). 로그에는 분류만 남긴다.
      console.warn(`TourAPI 호출 실패: ${e instanceof TourApiError ? e.message : 'unknown'}`);
      return c.json({ error: 'tourapi_unavailable' }, 502);
    }
    return c.json({ ...base, sample: false as const, items }, 200);
  });
};
