import { fireEvent, screen } from '@testing-library/react-native';
import { ApiError } from '../api';
import { MoreScreen } from '../features/settings/MoreScreen';
import { DELETE_WORD, SettingsScreen } from '../features/settings/SettingsScreen';
import { KEYS, storage } from '../state/storage';
import { resetRouter, router } from '../test/router-mock';
import { flush, GUEST, makeApi, PAIRING, renderApp } from '../test/utils';

beforeEach(() => resetRouter());
const never = () => new Promise<never>(() => undefined);

describe('설정', () => {
  test('현재 값과 게스트 인원을 보여 준다', async () => {
    const api = makeApi();
    await api.guestClaim({ code: '123456', consent: true });
    await renderApp(<SettingsScreen />, { api });
    expect(screen.getByTestId('set-paused').props.value).toBe(false);
    expect(screen.getByTestId('set-stats').props.value).toBe(true);
    expect(screen.getByTestId('set-home-value').props.children).toBe('지정 안 함');
    expect(screen.getByTestId('set-guests').props.children).toBe('지금 타고 있는 게스트 1명');
  });

  test('기록 멈춤·통계 참여를 켜고 끄면 PUT /vehicles/:id/settings(전체 값)', async () => {
    const api = makeApi();
    const put = jest.spyOn(api, 'putSettings');
    await renderApp(<SettingsScreen />, { api });
    await fireEvent(screen.getByTestId('set-paused'), 'valueChange', true);
    await flush();
    expect(put).toHaveBeenLastCalledWith(PAIRING.vehicleId, { recordingPaused: true, homeRegion: null, statsOptIn: true, drivingMap: true });
    await fireEvent(screen.getByTestId('set-stats'), 'valueChange', false);
    await flush();
    expect(put).toHaveBeenLastCalledWith(PAIRING.vehicleId, { recordingPaused: true, homeRegion: null, statsOptIn: false, drivingMap: true });
    expect(screen.getByTestId('set-paused').props.value).toBe(true);
  });

  test('저장 실패하면 값을 되돌리고 오류 문구', async () => {
    const api = makeApi({ putSettings: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<SettingsScreen />, { api });
    await fireEvent(screen.getByTestId('set-paused'), 'valueChange', true);
    await flush();
    expect(screen.getByTestId('set-paused').props.value).toBe(false);
    expect(screen.getByTestId('set-error').props.children).toContain('서버에 연결하지 못해');
  });

  test('내 지역 고르기: 검색 후 선택하면 homeRegion 저장', async () => {
    const api = makeApi();
    const put = jest.spyOn(api, 'putSettings');
    await renderApp(<SettingsScreen />, { api });
    await fireEvent.press(screen.getByTestId('set-home'));
    await flush();
    await fireEvent.changeText(screen.getByTestId('region-filter'), '홍천');
    await fireEvent.press(screen.getByTestId('region-51720'));
    await flush();
    expect(put).toHaveBeenLastCalledWith(PAIRING.vehicleId, expect.objectContaining({ homeRegion: '51720' }));
    expect(screen.getByTestId('set-home-value').props.children).toBe('51720');
  });

  test('데이터 지우기는 2단계: 1단계 확인 → 삭제 단어 입력 전에는 비활성 → 입력 후 DELETE', async () => {
    const api = makeApi();
    const del = jest.spyOn(api, 'deleteData');
    await renderApp(<SettingsScreen />, { api });
    await fireEvent.press(screen.getByTestId('set-delete'));
    await fireEvent.press(screen.getByTestId('delete1-ok'));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete2-ok').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('delete-input'), '삭');
    expect(screen.getByTestId('delete2-ok').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('delete-input'), DELETE_WORD);
    expect(screen.getByTestId('delete2-ok').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('delete2-ok'));
    await flush();
    expect(del).toHaveBeenCalledWith(PAIRING.vehicleId);
    expect(screen.getByTestId('set-delete-done')).toBeTruthy();
  });

  test('1단계에서 취소하면 삭제하지 않는다', async () => {
    const api = makeApi();
    const del = jest.spyOn(api, 'deleteData');
    await renderApp(<SettingsScreen />, { api });
    await fireEvent.press(screen.getByTestId('set-delete'));
    await fireEvent.press(screen.getByTestId('delete1-cancel'));
    await flush();
    expect(del).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delete2')).toBeNull();
  });

  test('삭제 실패 시 오류 문구, 완료 문구 없음', async () => {
    const api = makeApi({ deleteData: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<SettingsScreen />, { api });
    await fireEvent.press(screen.getByTestId('set-delete'));
    await fireEvent.press(screen.getByTestId('delete1-ok'));
    await fireEvent.changeText(screen.getByTestId('delete-input'), DELETE_WORD);
    await fireEvent.press(screen.getByTestId('delete2-ok'));
    await flush();
    expect(screen.getByTestId('delete-error')).toBeTruthy();
    expect(screen.queryByTestId('set-delete-done')).toBeNull();
  });

  test('연결 해제: 확인 → DELETE /pair(Bearer 토큰) → 저장 삭제 → 연결 화면', async () => {
    const api = makeApi();
    const del = jest.spyOn(api, 'pairDelete');
    await renderApp(<SettingsScreen />, { api });
    await fireEvent.press(screen.getByTestId('set-disconnect'));
    expect(del).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('disconnect-ok'));
    await flush();
    expect(del).toHaveBeenCalledWith('tok');
    expect(await storage.get(KEYS.pairing)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/connect');
  });

  test('서버가 닿지 않으면 이 폰에서만 해제할 수 있다', async () => {
    const api = makeApi({ pairDelete: async () => { throw new ApiError('offline', 0, 'network'); } });
    await renderApp(<SettingsScreen />, { api });
    await fireEvent.press(screen.getByTestId('set-disconnect'));
    await fireEvent.press(screen.getByTestId('disconnect-ok'));
    await flush();
    expect(screen.getByTestId('disconnect-error')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('disconnect-local'));
    await flush();
    expect(await storage.get(KEYS.pairing)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/connect');
  });

  test('loading / error / offline', async () => {
    await renderApp(<SettingsScreen />, { api: makeApi({ getSettings: never }) });
    expect(screen.getByTestId('settings-loading')).toBeTruthy();
    await renderApp(<SettingsScreen />, { api: makeApi({ getSettings: async () => { throw new ApiError('http', 404, 'not_found'); } }) });
    expect(screen.getByTestId('settings-error')).toBeTruthy();
    await renderApp(<SettingsScreen />, { api: makeApi({ getSettings: async () => { throw new ApiError('offline', 0, 'network'); } }) });
    expect(screen.getByTestId('settings-offline')).toBeTruthy();
  });
});

describe('더보기', () => {
  test('공유·게스트·설정으로 이동', async () => {
    await renderApp(<MoreScreen />);
    await fireEvent.press(screen.getByTestId('more-share'));
    expect(router.push).toHaveBeenLastCalledWith('/share');
    await fireEvent.press(screen.getByTestId('more-guest'));
    expect(router.push).toHaveBeenLastCalledWith('/scan?mode=guest');
    await fireEvent.press(screen.getByTestId('more-settings'));
    expect(router.push).toHaveBeenLastCalledWith('/settings');
  });
  test('게스트 세션이 있으면 세션 화면으로', async () => {
    await renderApp(<MoreScreen />, { guest: GUEST });
    await flush();
    await fireEvent.press(screen.getByTestId('more-guest'));
    expect(router.push).toHaveBeenLastCalledWith('/guest');
  });
});
