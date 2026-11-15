import { ApiError, createApi, createMockApi, resolveApiConfig } from '../api';
import { createLiveApi } from '../api/live';
import { MOCK_CODE_ALREADY_PAIRED, MOCK_CODE_EXPIRED, MOCK_CODE_GUEST_LIMIT, MOCK_CODE_IN_SESSION, MOCK_CODE_OWN_VEHICLE, MOCK_CODE_RATE, MOCK_CODE_UNKNOWN, MOCK_CODE_USED } from '../api/mock';
import { makeApiFetch } from '../api/http';
import { claimErrorKey, settingsErrorKey, shareErrorKey } from '../lib/errors';
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
  test('연결 코드: 성공과 T2 오류 코드(만료·없음·사용됨·이미 연결·시도 제한·형식)', async () => {
    const api = mock();
    await expect(api.pairClaim('123456', true)).resolves.toMatchObject({ vehicleId: expect.any(String), token: expect.any(String) });
    await expect(api.pairClaim(MOCK_CODE_EXPIRED, true)).rejects.toMatchObject({ status: 410, code: 'code_expired' });
    await expect(api.pairClaim(MOCK_CODE_UNKNOWN, true)).rejects.toMatchObject({ status: 404, code: 'code_not_found' });
    await expect(api.pairClaim(MOCK_CODE_USED, true)).rejects.toMatchObject({ status: 410, code: 'code_used' });
    await expect(api.pairClaim(MOCK_CODE_ALREADY_PAIRED, true)).rejects.toMatchObject({ status: 409, code: 'already_paired' });
    await expect(api.pairClaim(MOCK_CODE_RATE, true)).rejects.toMatchObject({ status: 429, code: 'too_many_requests' });
    await expect(api.pairClaim('12', true)).rejects.toMatchObject({ status: 400, code: 'invalid_body' });
  });
  test('차주 연결은 동의(consent:false)면 400 consent_required', async () => {
    await expect(mock().pairClaim('123456', false as unknown as true)).rejects.toMatchObject({ status: 400, code: 'consent_required' });
  });
  test('게스트: 동의 없으면 400, 참여·인원·내리기(재호출은 alreadyEnded)·요약(T2 형태)', async () => {
    const api = mock();
    await expect(api.guestClaim({ code: '123456', consent: false as unknown as true })).rejects.toMatchObject({ status: 400, code: 'consent_required' });
    const g = await api.guestClaim({ code: '123456', consent: true, nickname: '민' });
    expect((await api.guestSessions(V)).active).toBe(1);
    const me = await api.meSummary(g.token);
    expect(me).toMatchObject({ role: 'guest', activeSessionId: g.sessionId, regions: { total: 229, depop: { total: 92 } }, coverage: { roadsStarted: expect.any(Number) }, snapshotMonth: '2026-11' });
    expect(await api.guestEnd(g.sessionId, g.token)).toMatchObject({ ok: true, alreadyEnded: false });
    expect(await api.guestEnd(g.sessionId, g.token)).toMatchObject({ alreadyEnded: true });
    expect((await api.guestSessions(V)).active).toBe(0);
    expect((await api.meSummary(g.token)).activeSessionId).toBeNull();
  });
  test('게스트 오류 코드(가득·이미 세션·내 차)와 없는 세션 404, 기록 삭제', async () => {
    const api = mock();
    await expect(api.guestClaim({ code: MOCK_CODE_GUEST_LIMIT, consent: true })).rejects.toMatchObject({ status: 409, code: 'guest_limit' });
    await expect(api.guestClaim({ code: MOCK_CODE_IN_SESSION, consent: true })).rejects.toMatchObject({ code: 'already_in_session' });
    await expect(api.guestClaim({ code: MOCK_CODE_OWN_VEHICLE, consent: true })).rejects.toMatchObject({ code: 'own_vehicle' });
    await expect(api.guestEnd('nope', 't')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(api.guestDeleteData('nope', 't')).rejects.toMatchObject({ status: 404 });
    const g = await api.guestClaim({ code: '123456', consent: true });
    await api.guestDeleteData(g.sessionId, g.token);
    expect((await api.meSummary(g.token)).regions?.colored).toBe(0);
  });
  test('공유 카드: 종류별 필수 입력', async () => {
    const api = mock();
    await expect(api.shareCreate({ vehicleId: V, kind: 'trip' })).rejects.toMatchObject({ code: 'trip_required' });
    await expect(api.shareCreate({ vehicleId: V, kind: 'road' })).rejects.toMatchObject({ code: 'road_required' });
    const c = await api.shareCreate({ vehicleId: V, kind: 'national' });
    expect(c).toMatchObject({ id: expect.any(String), url: expect.stringContaining('/s/'), imageUrl: 'mock:share-card.png' });
  });
  test('설정 저장 후 다시 읽으면 반영', async () => {
    const api = mock();
    expect(await api.getSettings(V)).toMatchObject({ hideHomeInCards: true, consentWithdrawnAt: null });
    await api.putSettings(V, { recordingPaused: true, homeRegion: '11140' }); // 부분 갱신
    expect(await api.getSettings(V)).toMatchObject({ recordingPaused: true, homeRegion: '11140', statsOptIn: true });
    await expect(api.putSettings(V, { homeRegion: '99999' })).rejects.toMatchObject({ status: 400, code: 'invalid_region' });
  });
  test('데이터 삭제 뒤에는 기록이 비고 설정이 초기화', async () => {
    const api = mock();
    await api.putSettings(V, { recordingPaused: true, homeRegion: '11140', statsOptIn: false, drivingMap: false });
    expect(await api.deleteData(V)).toMatchObject({ ok: true, deleted: { trips: expect.any(Number) } });
    expect((await api.trips(V)).trips).toHaveLength(0);
    expect((await api.coverageRoads(V)).items).toHaveLength(0);
    expect((await api.regionsSummary(V)).colored).toBe(0);
    expect(await api.getSettings(V)).toMatchObject({ recordingPaused: true, homeRegion: null, statsOptIn: true, consentWithdrawnAt: expect.any(String) }); // 삭제는 기록 멈춤·동의 철회 표시를 남긴다
  });
  test('리포트는 요청한 날짜·월을 돌려준다', async () => {
    const api = mock();
    const d = await api.reportsDaily(V, '2026-11-11');
    expect(d).toMatchObject({ date: '2026-11-11', newWays: expect.any(Number), revivedKm: expect.any(Number), newStays: [] });
    expect(d.newRegions[0]).toMatchObject({ code: expect.any(String), sidoName: expect.any(String) });
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
    await api.pairClaim('123456', true);
    await api.pairDelete('tok');
    await api.guestClaim({ code: '123456', consent: true });
    await api.guestEnd('s1', 'gt');
    await api.guestDeleteData('s1', 'gt');
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
      'DELETE /guest/s1/data',
      'GET /me/summary',
      'POST /share/cards',
      'PUT /vehicles/v1/settings',
      'DELETE /vehicles/v1/data',
      'GET /reports/daily?vehicleId=v1&date=2026-11-11',
    ]);
    expect(calls[1]!.auth).toBe('Bearer tok');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ code: '123456', consent: true });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ code: '123456', consent: true });
    expect(calls[3]!.auth).toBe('Bearer gt');
    expect(calls[4]!.auth).toBe('Bearer gt');
    expect(calls[5]!.auth).toBe('Bearer gt');
  });
  test('차주 토큰은 차량 API(RPC 포함)에 Bearer로 붙고, claim에는 붙지 않으며, 명시한 게스트 토큰이 우선', async () => {
    const { f, calls } = recorder({ trips: [] });
    let token: string | null = 'owner-tok';
    const api = createLiveApi('http://h', 'live', f, () => token);
    await api.trips(V); // RPC
    await api.coverageSummary(V);
    await api.regionsList(V);
    await api.reportsDaily(V, '2026-11-11');
    await api.getSettings(V);
    await api.putSettings(V, { recordingPaused: true });
    await api.shareCreate({ vehicleId: V, kind: 'national' });
    await api.deleteData(V);
    await api.guestSessions(V);
    for (const c of calls) expect(c.auth).toBe('Bearer owner-tok');
    calls.length = 0;
    await api.pairClaim('123456', true);
    await api.guestClaim({ code: '123456', consent: true });
    for (const c of calls) expect(c.auth).toBeNull();
    calls.length = 0;
    await api.guestEnd('s1', 'guest-tok');
    expect(calls[0]!.auth).toBe('Bearer guest-tok');
    token = null; // 연결 해제 뒤에는 헤더 없음
    calls.length = 0;
    await api.trips(V);
    expect(calls[0]!.auth).toBeNull();
  });
  test('T2 변경 이력: me/link·DELETE /me·인증서·courses 경로, consent는 항상 true로 전송', async () => {
    const { f, calls } = recorder({});
    const api = createLiveApi('http://h', 'live', f);
    await api.meLink('gt');
    await api.meDelete('gt');
    await api.courses();
    await api.courseCertificate('c 1', V);
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://h', '')}`)).toEqual(['POST /me/link', 'DELETE /me', 'GET /courses', 'POST /courses/c%201/certificate']);
    expect(calls[0]!.auth).toBe('Bearer gt');
    expect(JSON.parse(calls[3]!.body!)).toEqual({ vehicleId: V });
    calls.length = 0;
    await api.pairClaim('123456', true);
    expect(JSON.parse(calls[0]!.body!).consent).toBe(true);
  });
  test('차주 토큰이 401이면 onUnauthorized(연결 해제 유도), 명시한 게스트 토큰의 401은 아님', async () => {
    const { f } = recorder({ error: 'unauthorized' }, 401);
    let n = 0;
    const api = createLiveApi('http://h', 'live', f, () => 'owner', () => n++);
    await expect(api.trips(V)).rejects.toMatchObject({ status: 401 });
    expect(n).toBe(1);
    await expect(api.meSummary('guest-tok')).rejects.toMatchObject({ status: 401 });
    expect(n).toBe(1);
  });
  test('오류 코드 → 문구 키(T2 변경 이력)', () => {
    const h = (status: number, code: string) => new ApiError('http', status, code);
    expect(shareErrorKey(h(503, 'png_unavailable'))).toBe('share.err.png');
    expect(shareErrorKey(h(409, 'trip_not_eligible'))).toBe('share.err.notEligible');
    expect(shareErrorKey(h(429, 'too_many_requests'))).toBe('share.err.rate');
    expect(settingsErrorKey(h(403, 'local_only'))).toBe('settings.err.localOnly');
    expect(settingsErrorKey(h(401, 'unauthorized'))).toBe('settings.err.auth');
    expect(claimErrorKey(h(429, 'rate_limited'))).toBe('connect.err.rate');
    expect(claimErrorKey(h(400, 'invalid_body'))).toBe('connect.err.invalid');
    expect(claimErrorKey(h(409, 'alias_source_is_vehicle'))).toBe('connect.err.unknown');
  });
  test('mock: 공유 카드는 png, 차주 summary 형태·인증서·탈퇴', async () => {
    const api = mock();
    expect((await api.shareCreate({ vehicleId: V, kind: 'national' })).imageUrl.endsWith('.png')).toBe(true);
    await expect(api.courseCertificate('nope', V)).rejects.toMatchObject({ status: 404 });
    await expect(api.meDelete('mock-token-123456')).rejects.toMatchObject({ status: 403 });
  });
  test('PUT settings는 부분 본문만 보낸다', async () => {
    const { f, calls } = recorder({});
    await createLiveApi('http://h', 'live', f).putSettings(V, { statsOptIn: false });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ statsOptIn: false });
  });
  test('네트워크 실패는 offline, HTTP 오류는 http(code)', async () => {
    const down = createLiveApi('http://h', 'live', (async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch);
    await expect(down.pairClaim('123456', true)).rejects.toMatchObject({ kind: 'offline' });
    const { f } = recorder({ error: 'code_expired' }, 410);
    const api = createLiveApi('http://h', 'live', f);
    const e = await api.pairClaim('123456', true).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ kind: 'http', status: 410, code: 'code_expired' });
  });
});

describe('타임아웃', () => {
  afterEach(() => jest.useRealTimers());
  test('응답이 없으면 12초 뒤 offline(timeout)', async () => {
    jest.useFakeTimers();
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const p = makeApiFetch(hang)('http://h/x').catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(11_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(await p).toMatchObject({ kind: 'offline', code: 'timeout' });
  });
  test('빠른 응답은 타이머를 정리한다', async () => {
    jest.useFakeTimers();
    const ok = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await makeApiFetch(ok)('http://h/x');
    expect(jest.getTimerCount()).toBe(0);
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
