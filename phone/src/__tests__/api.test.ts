import { ApiError, createApi, createMockApi, resolveApiConfig } from '../api';
import { createLiveApi } from '../api/live';
import { MOCK_CODE_EXPIRED, MOCK_CODE_UNKNOWN } from '../api/mock';
import { parseQr } from '../features/connect/qr';

const mock = () => createMockApi({ latencyMs: 0 });
const V = 'v1';

describe('resolveApiConfig', () => {
  test('URL이 없으면 mock', () => expect(resolveApiConfig({})).toEqual({ mode: 'mock', baseUrl: '' }));
  test('URL만 있으면 hybrid', () => expect(resolveApiConfig({ EXPO_PUBLIC_NUBI_API_URL: 'http://10.0.2.2:8792/' })).toEqual({ mode: 'hybrid', baseUrl: 'http://10.0.2.2:8792' }));
  test('모드 명시', () => expect(resolveApiConfig({ EXPO_PUBLIC_NUBI_API_URL: 'http://x', EXPO_PUBLIC_NUBI_API_MODE: 'live' }).mode).toBe('live'));
  test('URL 없이 live를 요구해도 mock', () => expect(resolveApiConfig({ EXPO_PUBLIC_NUBI_API_MODE: 'live' }).mode).toBe('mock'));
});

describe('mock API', () => {
  test('시군구 229칸·인구감소지역 92칸·시도별 묶음', async () => {
    const r = await mock().regionsList(V);
    expect(r.items).toHaveLength(229);
    expect(r.items.filter((i) => i.depop92)).toHaveLength(92);
    expect(new Set(r.items.map((i) => i.sidoName)).size).toBe(17);
    expect(r.items.some((i) => i.faded)).toBe(true);
    expect(new Set(r.items.map((i) => i.code)).size).toBe(229);
  });
  test('regionsSummary는 목록과 일치', async () => {
    const api = mock();
    const [s, l] = await Promise.all([api.regionsSummary(V), api.regionsList(V)]);
    expect(s.total).toBe(229);
    expect(s.colored).toBe(l.items.filter((i) => i.level > 0).length);
    expect(s.depop.total).toBe(92);
  });
  test('거의 다 달린 도로는 80% 이상 95% 미만만', async () => {
    const r = await mock().coverageRoads(V, { filter: 'almost' });
    expect(r.items.length).toBeGreaterThan(0);
    for (const i of r.items) expect(i.percent >= 80 && i.percent < 95).toBe(true);
  });
  test('도로 페이지네이션', async () => {
    const api = mock();
    const a = await api.coverageRoads(V, { limit: 5 });
    const b = await api.coverageRoads(V, { limit: 5, offset: 5 });
    expect(a.items).toHaveLength(5);
    expect(a.total).toBe(12);
    expect(b.items[0]?.roadKey).not.toBe(a.items[0]?.roadKey);
  });
  test('연결 코드: 성공·만료·없음·형식 오류', async () => {
    const api = mock();
    await expect(api.pairClaim('123456')).resolves.toMatchObject({ vehicleId: expect.any(String), token: expect.any(String) });
    await expect(api.pairClaim(MOCK_CODE_EXPIRED)).rejects.toMatchObject({ code: 'code_expired' });
    await expect(api.pairClaim(MOCK_CODE_UNKNOWN)).rejects.toMatchObject({ code: 'code_not_found' });
    await expect(api.pairClaim('12')).rejects.toMatchObject({ code: 'invalid_code', status: 400 });
  });
  test('게스트: 동의 없으면 400, 참여·인원·내리기', async () => {
    const api = mock();
    await expect(api.guestClaim({ code: '123456', consent: false as unknown as true })).rejects.toMatchObject({ status: 400, code: 'consent_required' });
    const g = await api.guestClaim({ code: '123456', consent: true, nickname: '민' });
    expect((await api.guestSessions(V)).active).toBe(1);
    await api.guestEnd(g.sessionId, g.token);
    expect((await api.guestSessions(V)).active).toBe(0);
    expect((await api.meSummary(g.token)).regionsTotal).toBe(229);
  });
  test('공유 카드: 종류별 필수 입력', async () => {
    const api = mock();
    await expect(api.shareCreate({ vehicleId: V, kind: 'trip' })).rejects.toMatchObject({ code: 'trip_required' });
    await expect(api.shareCreate({ vehicleId: V, kind: 'road' })).rejects.toMatchObject({ code: 'road_required' });
    const c = await api.shareCreate({ vehicleId: V, kind: 'national' });
    expect(c).toMatchObject({ id: expect.any(String), url: expect.stringContaining('/s/'), imageUrl: 'mock:share-card' });
  });
  test('설정 저장 후 다시 읽으면 반영', async () => {
    const api = mock();
    const s = await api.getSettings(V);
    await api.putSettings(V, { ...s, recordingPaused: true, homeRegion: '11140' });
    expect(await api.getSettings(V)).toMatchObject({ recordingPaused: true, homeRegion: '11140' });
  });
  test('데이터 삭제 뒤에는 기록이 비고 설정이 초기화', async () => {
    const api = mock();
    await api.putSettings(V, { recordingPaused: true, homeRegion: '11140', statsOptIn: false, drivingMap: false });
    await api.deleteData(V);
    expect((await api.trips(V)).trips).toHaveLength(0);
    expect((await api.coverageRoads(V)).items).toHaveLength(0);
    expect((await api.regionsSummary(V)).colored).toBe(0);
    expect(await api.getSettings(V)).toMatchObject({ recordingPaused: false, homeRegion: null, statsOptIn: true });
  });
  test('리포트는 요청한 날짜·월을 돌려준다', async () => {
    const api = mock();
    expect((await api.reportsDaily(V, '2026-11-11')).date).toBe('2026-11-11');
    expect((await api.reportsMonthly(V, '2026-11')).month).toBe('2026-11');
  });
});

describe('live API (가짜 fetch)', () => {
  const recorder = (body: unknown = {}, status = 200) => {
    const calls: { url: string; method: string; auth: string | null; body: string | null }[] = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url: String(url), method: init?.method ?? 'GET', auth: h.get('Authorization'), body: (init?.body as string) ?? null });
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return { f, calls };
  };

  test('기존 API는 RPC 경로로', async () => {
    const { f, calls } = recorder({ trips: [] });
    const api = createLiveApi('http://h', 'live', f);
    await api.trips(V, 5);
    await api.coverageRoads(V, { filter: 'almost' });
    expect(calls[0]!.url).toBe('http://h/trips?vehicleId=v1&limit=5');
    expect(calls[1]!.url).toBe('http://h/coverage/roads?vehicleId=v1&filter=almost');
  });
  test('새 API는 계약서 경로·메서드·Bearer로', async () => {
    const { f, calls } = recorder({});
    const api = createLiveApi('http://h', 'live', f);
    await api.pairClaim('123456');
    await api.pairDelete('tok');
    await api.guestClaim({ code: '123456', consent: true });
    await api.guestEnd('s1', 'gt');
    await api.meSummary('gt');
    await api.shareCreate({ vehicleId: V, kind: 'national' });
    await api.putSettings(V, { recordingPaused: true, homeRegion: null, statsOptIn: true, drivingMap: true });
    await api.deleteData(V);
    await api.reportsDaily(V, '2026-11-11');
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://h', '')}`)).toEqual([
      'POST /pair/claim',
      'DELETE /pair',
      'POST /guest/claim',
      'POST /guest/s1/end',
      'GET /me/summary',
      'POST /share/cards',
      'PUT /vehicles/v1/settings',
      'DELETE /vehicles/v1/data',
      'GET /reports/daily?vehicleId=v1&date=2026-11-11',
    ]);
    expect(calls[1]!.auth).toBe('Bearer tok');
    expect(JSON.parse(calls[2]!.body!)).toEqual({ code: '123456', consent: true });
    expect(calls[4]!.auth).toBe('Bearer gt');
  });
  test('네트워크 실패는 offline, HTTP 오류는 http(code)', async () => {
    const down = createLiveApi('http://h', 'live', (async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch);
    await expect(down.pairClaim('123456')).rejects.toMatchObject({ kind: 'offline' });
    const { f } = recorder({ error: 'code_expired' }, 410);
    const api = createLiveApi('http://h', 'live', f);
    const e = await api.pairClaim('123456').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ kind: 'http', status: 410, code: 'code_expired' });
  });
});

describe('hybrid 조합', () => {
  test('기존 API는 실서버, 새 API는 목', async () => {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ trips: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const api = createApi({ mode: 'hybrid', baseUrl: 'http://h' });
      await api.trips(V);
      expect(calls).toHaveLength(1);
      await api.getSettings(V);
      await api.reportsDaily(V, '2026-11-11');
      expect(calls).toHaveLength(1); // 목이 답했으니 서버로 가지 않았다
      expect(api.mode).toBe('hybrid');
      expect(api.viewerUrl(V)).toBe('http://h/viewer?vehicleId=v1');
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('parseQr', () => {
  test('차주 연결 URL', () => expect(parseQr('https://nubi.example/p/123456')).toEqual({ kind: 'pair', code: '123456' }));
  test('게스트 URL(쿼리 포함)', () => expect(parseQr('https://nubi.example/g/654321?x=1')).toEqual({ kind: 'guest', code: '654321' }));
  test('6자리 숫자', () => expect(parseQr(' 123456 ')).toEqual({ kind: null, code: '123456' }));
  test('모르는 값', () => {
    expect(parseQr('hello')).toBeNull();
    expect(parseQr('https://x/p/12345')).toBeNull();
    expect(parseQr('https://x/p/1234567')).toBeNull();
  });
});
