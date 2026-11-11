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
  });

  test('summary 오류·오프라인 상태', async () => {
    await renderApp(<GuestSessionScreen />, { api: makeApi({ meSummary: async () => { throw new ApiError('offline', 0, 'network'); } }), pairing: null, guest: GUEST });
    expect(screen.getByTestId('guest-summary-offline')).toBeTruthy();
    await renderApp(<GuestSessionScreen />, { api: makeApi({ meSummary: async () => { throw new ApiError('http', 401, 'unauthorized'); } }), pairing: null, guest: GUEST });
    expect(screen.getByTestId('guest-summary-error')).toBeTruthy();
  });

  test('내리기: 확인 후 세션 종료·저장 삭제·연결 화면으로', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'guestEnd');
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    await fireEvent.press(screen.getByTestId('guest-leave'));
    expect(spy).not.toHaveBeenCalled(); // 확인 전
    await fireEvent.press(screen.getByTestId('guest-confirm-ok'));
    await flush();
    expect(spy).toHaveBeenCalledWith('mock-guest-1', 'gt');
    expect(await storage.get(KEYS.guest)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/connect');
  });

  test('내리기 실패하면 세션을 지우지 않고 오류를 보인다', async () => {
    const api = makeApi({ guestEnd: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<GuestSessionScreen />, { api, pairing: null, guest: GUEST });
    await fireEvent.press(screen.getByTestId('guest-leave'));
    await fireEvent.press(screen.getByTestId('guest-confirm-ok'));
    await flush();
    expect(screen.getByTestId('guest-leave-error')).toBeTruthy();
    expect(await storage.get(KEYS.guest)).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
