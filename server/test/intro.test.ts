import { describe, expect, it, vi } from 'vitest';
import { call, DAY, extApp } from './ext-helpers.js';

const item = (title: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ title, addr1: '서울 중구 어딘가', mapx: String(x), mapy: String(y), dist: '120', ...extra });
const ok = (items: unknown[]) => new Response(JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: items.length ? { item: items } : '' } } }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('지역 소개', () => {
  it('키가 없으면 시군구별 고정 예시(sample: true), 제목에 예시 표기, 같은 입력은 같은 결과', async () => {
    const e = extApp();
    const a = await call(e, '/regions/11140/intro');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ sample: true, source: '한국관광공사', code: '11140', displayName: '서울 중구' });
    expect(a.body.items).toHaveLength(9);
    expect(new Set(a.body.items.map((i: any) => i.kind))).toEqual(new Set(['attraction', 'festival', 'food']));
    for (const i of a.body.items) {
      expect(i.title).toContain('(예시)');
      expect(Number.isFinite(i.lat) && Number.isFinite(i.lon)).toBe(true);
    }
    expect((await call(e, '/regions/11140/intro')).body).toEqual(a.body);
    // 다른 시군구는 다른 예시
    expect((await call(e, '/regions/11110/intro')).body.items[0].title).not.toBe(a.body.items[0].title);
    // 기준 위치를 주면 그 위치에서 가까운 순
    const near = (await call(e, '/regions/11140/intro?lat=37.56&lon=126.98')).body.items.filter((i: any) => i.kind === 'food') as any[];
    expect(near.map((i) => i.distanceM)).toEqual([...near.map((i) => i.distanceM)].sort((x, y) => x - y));
  });

  it('입력 검증: 형식 오류 400, 없는 시군구 404, 위치 오류 400(입력 미반사), 지역 DB 없으면 503', async () => {
    const e = extApp();
    for (const code of ['abc', '1114', '111400', '1114a']) expect((await call(e, `/regions/${code}/intro`)).status).toBe(400);
    expect((await call(e, '/regions/99999/intro')).body).toEqual({ error: 'not_found' });
    for (const q of ['lat=37.5', 'lon=127', 'lat=abc&lon=127', 'lat=91&lon=127', 'lat=1e2&lon=1']) {
      const r = await call(e, `/regions/11140/intro?${q}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid_point' });
    }
    expect((await call(extApp({ regionsPath: null }), '/regions/11140/intro')).status).toBe(503);
  });

  it('키가 있으면 TourAPI 4.0을 종류별로 호출하고(가까운 순·contentTypeId), 하루 캐시한다. 키는 응답에 없다', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      urls.push(u.toString());
      const t = u.searchParams.get('contentTypeId');
      return ok([item(`제목-${t}-A`, 126.98, 37.56), item(`제목-${t}-B`, 126.99, 37.57, { addr1: undefined })]);
    });
    const e = extApp({ ext: { tourApiKey: 'SECRET-KEY-123', fetchFn: fetchFn as unknown as typeof fetch } });
    const r = await call(e, '/regions/11140/intro?lat=37.56&lon=126.98');
    expect(r.status).toBe(200);
    expect(r.body.sample).toBe(false);
    expect(r.body.items).toHaveLength(6);
    expect(r.body.items[0]).toMatchObject({ kind: 'attraction', title: '제목-12-A', lat: 37.56, lon: 126.98, addr: '서울 중구 어딘가', distanceM: 0 }); // 거리는 API 값이 아니라 요청 위치에서 다시 계산
    expect(r.body.items[1].addr).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain('SECRET-KEY-123');
    expect(urls.map((u) => new URL(u).searchParams.get('contentTypeId'))).toEqual(['12', '15', '39']);
    const u0 = new URL(urls[0]!);
    expect(u0.origin + u0.pathname).toBe('https://apis.data.go.kr/B551011/KorService2/locationBasedList2');
    expect(u0.searchParams.get('mapX')).toBe('126.98');
    expect(u0.searchParams.get('mapY')).toBe('37.56');
    expect(u0.searchParams.get('arrange')).toBe('E');
    // 같은 날 같은 위치(0.01도)는 캐시
    await call(e, '/regions/11140/intro?lat=37.5601&lon=126.9801');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // 다음 날은 다시 받는다
    e.clock.t += DAY;
    await call(e, '/regions/11140/intro?lat=37.56&lon=126.98');
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('외부 호출에는 반올림한 좌표(0.01도)만 보내고, 거리는 정확한 위치에서 요청마다 다시 계산하며, 시군구 밖 좌표는 400', async () => {
    const urls: URL[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return ok([item('가까운곳', 126.98, 37.56), item('먼곳', 127.02, 37.56)]);
    });
    const e = extApp({ ext: { tourApiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch } });
    const r1 = await call(e, '/regions/11140/intro?lat=37.5649&lon=126.9751');
    expect(r1.status).toBe(200);
    expect(urls[0]!.searchParams.get('mapY')).toBe('37.56');
    expect(urls[0]!.searchParams.get('mapX')).toBe('126.98');
    expect(urls.every((u) => !u.toString().includes('37.5649') && !u.toString().includes('126.9751'))).toBe(true);
    // 같은 칸(반올림 좌표가 같음)의 다른 위치: 호출은 캐시, 거리는 다시 계산
    const r2 = await call(e, '/regions/11140/intro?lat=37.5551&lon=126.9840');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const d = (r: any) => r.body.items.filter((i: any) => i.kind === 'attraction').map((i: any) => i.distanceM);
    expect(d(r1)[0]).not.toBe(d(r2)[0]);
    expect(d(r1)).toEqual([...d(r1)].sort((a: number, b: number) => a - b));
    // 시군구 bbox 밖 위치
    for (const q of ['lat=35.1&lon=129.0', 'lat=37.9&lon=126.98', 'lat=37.56&lon=128.5']) expect((await call(e, `/regions/11140/intro?${q}`)).body).toEqual({ error: 'invalid_point' });
  });

  it('요청 횟수 제한(출처별)과 TourAPI 일일 호출 상한을 넘으면 429(rate_limited), 캐시 적중은 상한에 세지 않는다', async () => {
    const fetchFn = vi.fn(async () => ok([item('a', 126.98, 37.56)]));
    const e = extApp({ ext: { tourApiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch, rateLimit: { max: 1, windowMs: 60_000 } } });
    // max=1 → 출처별 6회/창
    for (let i = 0; i < 6; i++) expect((await call(e, '/regions/11140/intro')).status).toBe(200);
    expect((await call(e, '/regions/11140/intro')).body).toEqual({ error: 'rate_limited' });
    expect(fetchFn).toHaveBeenCalledTimes(3); // 캐시: 종류별 1회씩
    const e2 = extApp({ ext: { tourApiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch } });
    e2.db.prepare("INSERT INTO intro_calls (day, n) VALUES ('2026-11-12', 1000)").run();
    expect((await call(e2, '/regions/11140/intro')).body).toEqual({ error: 'rate_limited' });
  });

  it('TourAPI 오류(HTTP·네트워크·형식)는 502이고 키·URL을 로그·응답에 남기지 않으며, 잘못된 항목은 건너뛴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = [
      async () => new Response('x', { status: 500 }),
      async () => {
        throw new Error('boom SECRET-KEY-123 https://apis.data.go.kr/?serviceKey=SECRET-KEY-123');
      },
      async () => new Response(JSON.stringify({ response: { header: { resultCode: '0030', resultMsg: 'SERVICE KEY IS NOT REGISTERED' } } }), { status: 200 }),
      async () => new Response('<html>', { status: 200 }),
    ];
    for (const f of bad) {
      const e = extApp({ ext: { tourApiKey: 'SECRET-KEY-123', fetchFn: f as unknown as typeof fetch } });
      const r = await call(e, '/regions/11140/intro');
      expect(r.status).toBe(502);
      expect(r.body).toEqual({ error: 'tourapi_unavailable' });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-KEY-123');
    warn.mockRestore();
    const dirty = vi.fn(async () => ok([item('', 127, 37), item('좌표없음', NaN, 37), item('범위밖', 999, 37), item('정상', 127.01, 37.5)]));
    const e = extApp({ ext: { tourApiKey: 'k', fetchFn: dirty as unknown as typeof fetch } });
    const r = await call(e, '/regions/11140/intro');
    expect(r.body.items.map((i: any) => i.title)).toEqual(['정상', '정상', '정상']);
    // 결과가 비어 있어도(items: '') 200
    const empty = extApp({ ext: { tourApiKey: 'k', fetchFn: (async () => ok([])) as unknown as typeof fetch } });
    expect((await call(empty, '/regions/11140/intro')).body.items).toEqual([]);
  });
});
