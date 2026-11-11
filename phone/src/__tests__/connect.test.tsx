import { fireEvent, screen } from '@testing-library/react-native';
import { ApiError } from '../api';
import { ConnectScreen } from '../features/connect/ConnectScreen';
import { ScanScreen } from '../features/connect/ScanScreen';
import { Linking } from 'react-native';
import { router, resetRouter, setParams } from '../test/router-mock';
import { requestPermission, scan, setPermission } from '../test/camera-mock';
import { flush, makeApi, renderApp } from '../test/utils';
import { storage, KEYS } from '../state/storage';

beforeEach(() => {
  resetRouter();
  setPermission({ granted: true, canAskAgain: true });
  requestPermission.mockReset();
});

describe('연결 화면', () => {
  test('위치정보 이용 동의 문구가 보이고, 동의 전에는 스캔·코드 연결이 모두 비활성', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'pairClaim');
    await renderApp(<ConnectScreen />, { api, pairing: null });
    expect(screen.getByTestId('connect-consent-text').props.children).toContain('위치정보');
    expect(screen.getByTestId('connect-scan').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    expect(screen.getByTestId('code-submit').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('connect-consent'));
    expect(screen.getByTestId('connect-scan').props.accessibilityState.disabled).toBe(false);
  });

  test('동의 후 6자리 코드면 consent:true로 claim하고 토큰을 저장해 홈으로 이동', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'pairClaim');
    await renderApp(<ConnectScreen />, { api, pairing: null });
    await fireEvent.press(screen.getByTestId('connect-consent'));
    const btn = () => screen.getByTestId('code-submit');
    expect(btn().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('code-input'), '12ab34');
    expect(screen.getByTestId('code-input').props.value).toBe('1234'); // 숫자만
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    expect(btn().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(btn());
    await flush();
    expect(spy).toHaveBeenCalledWith('123456', true);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(JSON.parse((await storage.get(KEYS.pairing))!)).toMatchObject({ vehicleId: 'mock-vehicle-0001', token: 'mock-token-123456' });
  });

  test.each([
    ['000000', '코드가 만료되었습니다'],
    ['111111', '없는 코드입니다'],
    ['222222', '이미 사용한 코드'],
    ['333333', '이미 다른 폰에 연결'],
    ['444444', '시도가 너무 많습니다'],
  ])('코드 %s 오류 문구(T2 오류 코드)', async (code, text) => {
    await renderApp(<ConnectScreen />, { pairing: null });
    await fireEvent.press(screen.getByTestId('connect-consent'));
    await fireEvent.changeText(screen.getByTestId('code-input'), code);
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(screen.getByTestId('code-error').props.children).toContain(text);
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('오프라인이면 연결 실패 문구', async () => {
    const api = makeApi({ pairClaim: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<ConnectScreen />, { api, pairing: null });
    await fireEvent.press(screen.getByTestId('connect-consent'));
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(screen.getByTestId('code-error').props.children).toContain('서버에 연결하지 못했습니다');
  });

  test('타임아웃은 응답이 늦다는 문구', async () => {
    const api = makeApi({ pairClaim: async () => { throw new ApiError('offline', 0, 'timeout'); } });
    await renderApp(<ConnectScreen />, { api, pairing: null });
    await fireEvent.press(screen.getByTestId('connect-consent'));
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(screen.getByTestId('code-error').props.children).toContain('응답이 늦습니다');
  });

  test('QR 스캔·게스트 버튼은 스캔 화면으로 이동', async () => {
    await renderApp(<ConnectScreen />, { pairing: null });
    await fireEvent.press(screen.getByTestId('connect-consent'));
    await fireEvent.press(screen.getByTestId('connect-scan'));
    expect(router.push).toHaveBeenCalledWith('/scan?mode=pair&consent=1');
    await fireEvent.press(screen.getByTestId('connect-guest'));
    expect(router.push).toHaveBeenCalledWith('/scan?mode=guest');
  });
});

describe('스캔 화면', () => {
  test('차 연결 QR을 읽으면 consent:true로 claim하고 홈으로', async () => {
    setParams({ mode: 'pair', consent: '1' });
    const api = makeApi();
    const spy = jest.spyOn(api, 'pairClaim');
    await renderApp(<ScanScreen />, { api, pairing: null });
    expect(screen.getByTestId('camera')).toBeTruthy();
    scan('https://nubi.example/p/123456');
    await flush();
    expect(spy).toHaveBeenCalledWith('123456', true);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
  });

  test('동의 없이(consent 파라미터 없음) 들어온 차 연결 스캔은 claim하지 않는다', async () => {
    setParams({ mode: 'pair' });
    const api = makeApi();
    const spy = jest.spyOn(api, 'pairClaim');
    await renderApp(<ScanScreen />, { api, pairing: null });
    scan('https://nubi.example/p/123456');
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-error').props.children).toContain('동의');
  });

  test('잘못된 QR 오류는 1.5초 쿨다운 동안 다시 처리하지 않는다', async () => {
    setParams({ mode: 'pair', consent: '1' });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await renderApp(<ScanScreen />, { pairing: null });
    scan('안녕');
    await flush();
    const first = screen.getByTestId('scan-error').props.children;
    now.mockReturnValue(1_000_500);
    scan('https://nubi.example/g/654321'); // 쿨다운 안: 무시(문구가 바뀌지 않는다)
    await flush();
    expect(screen.getByTestId('scan-error').props.children).toBe(first);
    now.mockReturnValue(1_002_000);
    scan('https://nubi.example/g/654321');
    await flush();
    expect(screen.getByTestId('scan-error').props.children).toContain('게스트용 QR');
    now.mockRestore();
  });

  test('게스트 QR이면 동의 화면으로 코드를 넘긴다(claim은 아직 안 함)', async () => {
    setParams({ mode: 'guest' });
    const api = makeApi();
    const spy = jest.spyOn(api, 'guestClaim');
    await renderApp(<ScanScreen />, { api, pairing: null });
    scan('https://nubi.example/g/654321');
    await flush();
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/guest/consent', params: { code: '654321' } });
    expect(spy).not.toHaveBeenCalled();
  });

  test('종류가 맞지 않는 QR·모르는 QR은 안내', async () => {
    setParams({ mode: 'pair', consent: '1' });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(2_000_000);
    await renderApp(<ScanScreen />, { pairing: null });
    scan('https://nubi.example/g/654321');
    await flush();
    expect(screen.getByTestId('scan-error').props.children).toContain('게스트용 QR');
    now.mockReturnValue(2_005_000);
    scan('안녕');
    await flush();
    expect(screen.getByTestId('scan-error').props.children).toContain('누비 QR이 아닙니다');
    expect(router.replace).not.toHaveBeenCalled();
    now.mockRestore();
  });

  test('카메라 권한 확인 중에는 loading', async () => {
    setPermission(null);
    await renderApp(<ScanScreen />, { pairing: null });
    expect(screen.getByTestId('scan-loading')).toBeTruthy();
  });

  test('권한 거부(다시 물을 수 있음): 허용 버튼 + 코드 직접 입력', async () => {
    setPermission({ granted: false, canAskAgain: true });
    setParams({ mode: 'pair', consent: '1' });
    await renderApp(<ScanScreen />, { pairing: null });
    expect(screen.getByTestId('scan-denied')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('scan-allow'));
    expect(requestPermission).toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
  });

  test('권한 영구 거부: 설정 열기', async () => {
    setPermission({ granted: false, canAskAgain: false });
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await renderApp(<ScanScreen />, { pairing: null });
    await fireEvent.press(screen.getByTestId('scan-settings'));
    expect(open).toHaveBeenCalled();
    expect(screen.queryByTestId('scan-allow')).toBeNull();
  });
});
