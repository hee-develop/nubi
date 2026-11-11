import { fireEvent, screen } from '@testing-library/react-native';
import { ApiError } from '../api';
import { GuestConsentScreen } from '../features/guest/GuestConsentScreen';
import { GuestSessionScreen } from '../features/guest/GuestSessionScreen';
import { KEYS, storage } from '../state/storage';
import { resetRouter, router, setParams } from '../test/router-mock';
import { flush, GUEST, makeApi, renderApp } from '../test/utils';

beforeEach(() => resetRouter());

describe('게스트 동의 화면', () => {
  test('위치정보 이용 동의 문구가 보이고, 체크 전에는 참여 버튼이 비활성', async () => {
    setParams({ code: '123456' });
    await renderApp(<GuestConsentScreen />, { pairing: null });
    expect(screen.getByTestId('consent-text').props.children).toContain('위치정보');
    expect(screen.getByTestId('consent-join').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('consent-check'));
    expect(screen.getByTestId('consent-join').props.accessibilityState.disabled).toBe(false);
  });

  test('동의 체크 없이는 참여 버튼을 눌러도 claim하지 않는다', async () => {
    setParams({ code: '123456' });
    const api = makeApi();
    const spy = jest.spyOn(api, 'guestClaim');
    await renderApp(<GuestConsentScreen />, { api, pairing: null });
    await fireEvent.press(screen.getByTestId('consent-join'));
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  test.each([['555555', '자리가 가득'], ['666666', '이미 다른 게스트 세션'], ['777777', '내 차의 게스트 QR'], ['444444', '시도가 너무 많습니다']])('코드 %s 오류 문구', async (code, text) => {
    setParams({ code });
    await renderApp(<GuestConsentScreen />, { pairing: null });
    await fireEvent.press(screen.getByTestId('consent-check'));
    await fireEvent.press(screen.getByTestId('consent-join'));
    await flush();
    expect(screen.getByTestId('consent-error').props.children).toContain(text);
  });

  test('동의 후 참여하면 consent:true로 claim하고 세션을 저장해 세션 화면으로', async () => {
    setParams({ code: '123456' });
    const api = makeApi();
    const spy = jest.spyOn(api, 'guestClaim');
    await renderApp(<GuestConsentScreen />, { api, pairing: null });
    await fireEvent.changeText(screen.getByTestId('consent-nickname'), '민');
    await fireEvent.press(screen.getByTestId('consent-check'));
    await fireEvent.press(screen.getByTestId('consent-join'));
    await flush();
    expect(spy).toHaveBeenCalledWith({ code: '123456', consent: true, nickname: '민' });
    expect(router.replace).toHaveBeenCalledWith('/guest');
    expect(JSON.parse((await storage.get(KEYS.guest))!)).toMatchObject({ sessionId: 'mock-guest-1', nickname: '민' });
  });

  test('닉네임을 비우면 보내지 않는다', async () => {
    setParams({ code: '123456' });
    const api = makeApi();
    const spy = jest.spyOn(api, 'guestClaim');
    await renderApp(<GuestConsentScreen />, { api, pairing: null });
    await fireEvent.press(screen.getByTestId('consent-check'));
    await fireEvent.press(screen.getByTestId('consent-join'));
    await flush();
    expect(spy).toHaveBeenCalledWith({ code: '123456', consent: true });
  });

  test('서버가 동의 필요(400)·만료·오프라인을 돌려주면 각 문구', async () => {
    setParams({ code: '000000' });
    await renderApp(<GuestConsentScreen />, { pairing: null });
    await fireEvent.press(screen.getByTestId('consent-check'));
    await fireEvent.press(screen.getByTestId('consent-join'));
    await flush();
    expect(screen.getByTestId('consent-error').props.children).toContain('만료');
    expect(router.replace).not.toHaveBeenCalled();

    const api = makeApi({ guestClaim: async () => { throw new ApiError('http', 400, 'consent_required'); } });
    await renderApp(<GuestConsentScreen />, { api, pairing: null });
    await fireEvent.press(screen.getByTestId('consent-check'));
    await fireEvent.press(screen.getByTestId('consent-join'));
    await flush();
    expect(screen.getByTestId('consent-error').props.children).toContain('동의해야');
  });
});

describe('게스트 세션 화면', () => {
  test('세션 없음 → empty와 스캔 버튼', async () => {
    await renderApp(<GuestSessionScreen />, { pairing: null });
    expect(screen.getByTestId('guest-empty')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('guest-scan'));
    expect(router.push).toHaveBeenCalledWith('/scan?mode=guest');
  });

  test('세션 중: /me/summary 표시(Bearer 게스트 토큰), loading → ready', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'meSummary');
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    expect(screen.getByTestId('guest-active')).toBeTruthy();
    expect(spy).toHaveBeenCalledWith('gt');
    expect(screen.getByTestId('guest-regions').props.children).toBe('시군구 3/229');
    expect(screen.getByText(/인정된 도로 14\.2km · 시작한 도로 4개/)).toBeTruthy();
  });

  test('summary 오류·오프라인 상태', async () => {
    await renderApp(<GuestSessionScreen />, { api: makeApi({ meSummary: async () => { throw new ApiError('offline', 0, 'network'); } }), pairing: null, guest: GUEST });
    expect(screen.getByTestId('guest-summary-offline')).toBeTruthy();
    await renderApp(<GuestSessionScreen />, { api: makeApi({ meSummary: async () => { throw new ApiError('http', 401, 'unauthorized'); } }), pairing: null, guest: GUEST });
    expect(screen.getByTestId('guest-summary-error')).toBeTruthy();
  });

  const joined = async () => {
    const api = makeApi();
    const r = await api.guestClaim({ code: '123456', consent: true, nickname: '민' });
    return { api, guest: { sessionId: r.sessionId, token: r.token, nickname: '민' } };
  };

  test('내리기: 확인 → 서버에 Bearer 토큰으로 종료 → 세션 종료 상태(기록 열람·삭제 유지)', async () => {
    const { api, guest } = await joined();
    const spy = jest.spyOn(api, 'guestEnd');
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest });
    await fireEvent.press(screen.getByTestId('guest-leave'));
    expect(spy).not.toHaveBeenCalled(); // 확인 전
    await fireEvent.press(screen.getByTestId('guest-confirm-ok'));
    await flush();
    expect(spy).toHaveBeenCalledWith(guest.sessionId, guest.token);
    expect(screen.getByTestId('guest-ended')).toBeTruthy();
    expect(screen.queryByTestId('guest-leave')).toBeNull();
    expect(JSON.parse((await storage.get(KEYS.guest))!)).toMatchObject({ ended: true, token: guest.token });
    expect(screen.getByTestId('guest-delete')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('guest-forget'));
    await flush();
    expect(await storage.get(KEYS.guest)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/connect');
  });

  test.each([[404, 'not_found'], [401, 'unauthorized']])('서버에 세션이 없거나 토큰이 무효(%i)면 로컬 세션을 지우고 연결 화면으로', async (status, code) => {
    const api = makeApi({ guestEnd: async () => { throw new ApiError('http', status, code); } });
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    await fireEvent.press(screen.getByTestId('guest-leave'));
    await fireEvent.press(screen.getByTestId('guest-confirm-ok'));
    await flush();
    expect(await storage.get(KEYS.guest)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/connect');
  });

  test('offline이면 세션을 지우지 않고 서버 미반영 안내 + 이 폰에서만 끝내기', async () => {
    const api = makeApi({ guestEnd: async () => { throw new ApiError('offline', 0, 'timeout'); } });
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    await fireEvent.press(screen.getByTestId('guest-leave'));
    await fireEvent.press(screen.getByTestId('guest-confirm-ok'));
    await flush();
    expect(screen.getByTestId('guest-leave-error').props.children).toContain('서버에는 아직 탑승 중');
    expect(await storage.get(KEYS.guest)).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('guest-leave-local'));
    await flush();
    expect(await storage.get(KEYS.guest)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/connect');
  });

  test('서버 오류(500)면 재시도 문구만, 탈출 버튼은 없다', async () => {
    const api = makeApi({ guestEnd: async () => { throw new ApiError('http', 500, 'x'); } });
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    await fireEvent.press(screen.getByTestId('guest-leave'));
    await fireEvent.press(screen.getByTestId('guest-confirm-ok'));
    await flush();
    expect(screen.getByTestId('guest-leave-error')).toBeTruthy();
    expect(screen.queryByTestId('guest-leave-local')).toBeNull();
  });

  test('내 기록 삭제: 2단계(삭제 입력 전 비활성) → DELETE /guest/:id/data(Bearer) → 요약 갱신', async () => {
    const { api, guest } = await joined();
    const del = jest.spyOn(api, 'guestDeleteData');
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest });
    expect(screen.getByTestId('guest-regions').props.children).toBe('시군구 3/229');
    await fireEvent.press(screen.getByTestId('guest-delete'));
    await fireEvent.press(screen.getByTestId('gdelete1-ok'));
    expect(screen.getByTestId('gdelete2-ok').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('gdelete-input'), '삭제');
    await fireEvent.press(screen.getByTestId('gdelete2-ok'));
    await flush();
    expect(del).toHaveBeenCalledWith(guest.sessionId, guest.token);
    expect(screen.getByTestId('guest-delete-done')).toBeTruthy();
    expect(screen.getByTestId('guest-regions').props.children).toBe('시군구 0/229');
  });

  test('기록 삭제 실패하면 오류 문구, 완료 문구 없음', async () => {
    const api = makeApi({ guestDeleteData: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    await fireEvent.press(screen.getByTestId('guest-delete'));
    await fireEvent.press(screen.getByTestId('gdelete1-ok'));
    await fireEvent.changeText(screen.getByTestId('gdelete-input'), '삭제');
    await fireEvent.press(screen.getByTestId('gdelete2-ok'));
    await flush();
    expect(screen.getByTestId('gdelete-error')).toBeTruthy();
    expect(screen.queryByTestId('guest-delete-done')).toBeNull();
  });

  test('요약 필드가 비어(null) 와도 0으로 표시한다', async () => {
    const api = makeApi({ meSummary: async () => ({ role: 'guest' as const, activeSessionId: null, regions: null, coverage: null, snapshotMonth: null }) });
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    expect(screen.getByTestId('guest-regions').props.children).toBe('시군구 0/0');
  });
});
