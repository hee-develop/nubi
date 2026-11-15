/** 한국관광공사 TourAPI 4.0(KorService2) 어댑터. 키는 요청 URL에만 쓰고 로그·응답·오류 메시지에 남기지 않는다. */
export type IntroKind = 'attraction' | 'festival' | 'food';
export type IntroItem = { kind: IntroKind; title: string; lat: number; lon: number; addr?: string; distanceM?: number };

/** contentTypeId: 12 관광지, 15 축제공연행사, 39 음식점. */
export const CONTENT_TYPE: Record<IntroKind, number> = { attraction: 12, festival: 15, food: 39 };
export const KINDS: IntroKind[] = ['attraction', 'festival', 'food'];
const ENDPOINT = 'https://apis.data.go.kr/B551011/KorService2/locationBasedList2';
const TIMEOUT_MS = 5_000;
export const ITEMS_PER_KIND = 3;
/** 기준 위치 반경(m). */
const RADIUS_M = 20_000;

export class TourApiError extends Error {}

type RawItem = { title?: unknown; addr1?: unknown; mapx?: unknown; mapy?: unknown; dist?: unknown };

/** 한 종류의 가까운 순 목록을 받는다. 응답 형식이 틀리거나 HTTP 오류면 TourApiError(키·URL을 담지 않는다). */
export const fetchTourItems = async (kind: IntroKind, lat: number, lon: number, key: string, fetchFn: typeof fetch = fetch): Promise<IntroItem[]> => {
  const url = new URL(ENDPOINT);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('MobileOS', 'ETC');
  url.searchParams.set('MobileApp', 'Nubi');
  url.searchParams.set('_type', 'json');
  url.searchParams.set('mapX', String(lon));
  url.searchParams.set('mapY', String(lat));
  url.searchParams.set('radius', String(RADIUS_M));
  url.searchParams.set('contentTypeId', String(CONTENT_TYPE[kind]));
  url.searchParams.set('numOfRows', String(ITEMS_PER_KIND));
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('arrange', 'E');
  let json: unknown;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) throw new TourApiError(`http_${res.status}`);
    json = await res.json();
  } catch (e) {
    throw e instanceof TourApiError ? e : new TourApiError('network');
  }
  const body = (json as { response?: { header?: { resultCode?: unknown }; body?: { items?: unknown } } } | null)?.response;
  if (!body || (body.header?.resultCode !== undefined && String(body.header.resultCode) !== '0000')) throw new TourApiError('bad_response');
  const raw = (body.body?.items as { item?: unknown } | '' | undefined) && (body.body!.items as { item?: unknown }).item;
  const list = Array.isArray(raw) ? (raw as RawItem[]) : raw && typeof raw === 'object' ? [raw as RawItem] : [];
  const out: IntroItem[] = [];
  for (const it of list) {
    const x = Number(it.mapx);
    const y = Number(it.mapy);
    if (typeof it.title !== 'string' || it.title.trim() === '' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(y) > 90 || Math.abs(x) > 180) continue;
    const d = Number(it.dist);
    out.push({
      kind,
      title: it.title.trim().slice(0, 100),
      lat: Math.round(y * 1e5) / 1e5,
      lon: Math.round(x * 1e5) / 1e5,
      ...(typeof it.addr1 === 'string' && it.addr1.trim() ? { addr: it.addr1.trim().slice(0, 200) } : {}),
      ...(Number.isFinite(d) ? { distanceM: Math.round(d) } : {}),
    });
  }
  return out;
};

const hash = (s: string) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
};

/** 키가 없을 때 쓰는 시군구별 고정 예시. 실제 장소가 아님을 제목에 '(예시)'로 밝히고 위치는 시군구 중심 주변의 고정 오프셋이다. */
export const sampleItems = (code: string, displayName: string, center: { lat: number; lon: number }, from: { lat: number; lon: number }): IntroItem[] => {
  const titles: Record<IntroKind, string[]> = {
    attraction: ['전망 좋은 쉼터', '옛길 산책로', '마을 공원'],
    festival: ['지역 봄 축제', '가을 문화 행사', '야시장 나들이'],
    food: ['향토 음식점', '손칼국수 맛집', '시장 먹거리'],
  };
  const out: IntroItem[] = [];
  for (const kind of KINDS) {
    const items = titles[kind].map((t, i) => {
      const h = hash(`${code}:${kind}:${i}`);
      const lat = center.lat + (((h % 2001) - 1000) / 1000) * 0.02;
      const lon = center.lon + ((((h >>> 11) % 2001) - 1000) / 1000) * 0.02;
      const dLat = (lat - from.lat) * 111_195;
      const dLon = (lon - from.lon) * 111_195 * Math.cos((from.lat * Math.PI) / 180);
      return {
        kind,
        title: `${displayName} ${t} (예시)`,
        lat: Math.round(lat * 1e5) / 1e5,
        lon: Math.round(lon * 1e5) / 1e5,
        addr: `${displayName} (예시 주소)`,
        distanceM: Math.round(Math.hypot(dLat, dLon)),
      } satisfies IntroItem;
    });
    out.push(...items.sort((a, b) => a.distanceM - b.distanceM));
  }
  return out;
};
