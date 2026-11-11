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
  test('6자리가 아니면 연결 버튼이 비활성, 6자리면 claim 후 토큰을 저장하고 홈으로 이동', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'pairClaim');
    await renderApp(<ConnectScreen />, { api, pairing: null });
    const btn = () => screen.getByTestId('code-submit');
    expect(btn().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('code-input'), '12ab34');
    expect(screen.getByTestId('code-input').props.value).toBe('1234'); // 숫자만
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    expect(btn().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(btn());
    await flush();
    expect(spy).toHaveBeenCalledWith('123456');
    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(JSON.parse((await storage.get(KEYS.pairing))!)).toMatchObject({ vehicleId: 'mock-vehicle-0001', token: 'mock-token-123456' });
  });

  test.each([
    ['000000', '코드가 만료되었습니다'],
    ['111111', '없는 코드입니다'],
  ])('코드 %s 오류 문구', async (code, text) => {
    await renderApp(<ConnectScreen />, { pairing: null });
    await fireEvent.changeText(screen.getByTestId('code-input'), code);
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(screen.getByTestId('code-error').props.children).toContain(text);
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('오프라인이면 연결 실패 문구', async () => {
    const api = makeApi({ pairClaim: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<ConnectScreen />, { api, pairing: null });
    await fireEvent.changeText(screen.getByTestId('code-input'), '123456');
    await fireEvent.press(screen.getByTestId('code-submit'));
    await flush();
    expect(screen.getByTestId('code-error').props.children).toContain('서버에 연결하지 못했습니다');
  });

  test('QR 스캔·게스트 버튼은 스캔 화면으로 이동', async () => {
    await renderApp(<ConnectScreen />, { pairing: null });
    await fireEvent.press(screen.getByTestId('connect-scan'));
    expect(router.push).toHaveBeenCalledWith('/scan?mode=pair');
    await fireEvent.press(screen.getByTestId('connect-guest'));
    expect(router.push).toHaveBeenCalledWith('/scan?mode=guest');
  });
});

describe('스캔 화면', () => {
  test('차 연결 QR을 읽으면 claim하고 홈으로', async () => {
    setParams({ mode: 'pair' });
    await renderApp(<ScanScreen />, { pairing: null });
    expect(screen.getByTestId('camera')).toBeTruthy();
    scan('https://nubi.example/p/123456');
    await flush();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
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
    setParams({ mode: 'pair' });
    await renderApp(<ScanScreen />, { pairing: null });
    scan('https://nubi.example/g/654321');
    await flush();
    expect(screen.getByTestId('scan-error').props.children).toContain('게스트용 QR');
    scan('안녕');
    await flush();
    expect(screen.getByTestId('scan-error').props.children).toContain('누비 QR이 아닙니다');
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('카메라 권한 확인 중에는 loading', async () => {
    setPermission(null);
    await renderApp(<ScanScreen />, { pairing: null });
    expect(screen.getByTestId('scan-loading')).toBeTruthy();
  });

  test('권한 거부(다시 물을 수 있음): 허용 버튼 + 코드 직접 입력', async () => {
    setPermission({ granted: false, canAskAgain: true });
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
