import { fireEvent, screen } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import { ApiError, createApi } from '../api';
import { MapScreen } from '../features/map/MapScreen';
import { ShareScreen } from '../features/share/ShareScreen';
import * as wv from '../test/webview-mock';
import { flush, makeApi, PAIRING, renderApp } from '../test/utils';
import { cardFileName } from '../features/share/shareFile';

describe('공유', () => {
  test('전국 카드: 만들기 → 미리보기 → 공유 시트', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'shareCreate');
    await renderApp(<ShareScreen />, { api });
    expect(screen.queryByTestId('share-preview')).toBeNull();
    await fireEvent.press(screen.getByTestId('share-create'));
    await flush();
    expect(spy).toHaveBeenCalledWith({ vehicleId: PAIRING.vehicleId, kind: 'national' });
    expect(screen.getByTestId('share-preview')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('share-send'));
    await flush();
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/share.png', expect.objectContaining({ mimeType: 'image/png' }));
  });

  test('여행 카드는 트립을 고르기 전에는 만들 수 없고, 고르면 tripIds로 요청', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'shareCreate');
    await renderApp(<ShareScreen />, { api });
    await fireEvent.press(screen.getByTestId('share-kind-trip'));
    await flush();
    expect(screen.getByTestId('share-create').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('share-trip-mock-trip-2'));
    await fireEvent.press(screen.getByTestId('share-create'));
    await flush();
    expect(spy).toHaveBeenCalledWith({ vehicleId: PAIRING.vehicleId, kind: 'trip', tripIds: ['mock-trip-2'] });
  });

  test('도로 카드는 roadKey로 요청', async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'shareCreate');
    await renderApp(<ShareScreen />, { api });
    await fireEvent.press(screen.getByTestId('share-kind-road'));
    await flush();
    await fireEvent.press(screen.getByTestId('share-road-mock-road-7'));
    await fireEvent.press(screen.getByTestId('share-create'));
    await flush();
    expect(spy).toHaveBeenCalledWith({ vehicleId: PAIRING.vehicleId, kind: 'road', roadKey: 'mock-road-7' });
  });

  test('비식별 안내 문구가 항상 보인다', async () => {
    await renderApp(<ShareScreen />);
    expect(screen.getByText(/출발·도착 1km 안, 내 지역, 정확한 좌표/)).toBeTruthy();
  });

  test('만들기 실패(오프라인·서버 오류)와 공유 불가', async () => {
    await renderApp(<ShareScreen />, { api: makeApi({ shareCreate: async () => { throw new ApiError('offline', 0, 'network'); } }) });
    await fireEvent.press(screen.getByTestId('share-create'));
    await flush();
    expect(screen.getByTestId('share-error').props.children).toContain('서버에 연결하지 못했습니다');

    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    await renderApp(<ShareScreen />);
    await fireEvent.press(screen.getByTestId('share-create'));
    await flush();
    await fireEvent.press(screen.getByTestId('share-send'));
    await flush();
    expect(screen.getByTestId('share-notice').props.children).toContain('공유 창을 쓸 수 없습니다');
  });

  test('여행 카드 선택용 트립 목록이 비면 empty', async () => {
    await renderApp(<ShareScreen />, { api: makeApi({ trips: async () => ({ trips: [] }) }) });
    await fireEvent.press(screen.getByTestId('share-kind-trip'));
    await flush();
    expect(screen.getByTestId('share-trips-empty')).toBeTruthy();
  });
});

describe('지도 탭', () => {
  test('hybrid: 서버 /viewer?vehicleId= 를 WebView로, 저작자 표시', async () => {
    await renderApp(<MapScreen />, { api: createApi({ mode: 'hybrid', baseUrl: 'http://10.0.2.2:8792' }) });
    expect(wv.last.props?.source.uri).toBe('http://10.0.2.2:8792/viewer?vehicleId=mock-vehicle-0001');
    expect(screen.getByText('© OpenStreetMap contributors')).toBeTruthy();
    expect(screen.getByTestId('map-loading')).toBeTruthy(); // 로드 끝나기 전
  });
  test('로드 끝나면 오버레이가 사라지고, 오류면 다시 시도', async () => {
    await renderApp(<MapScreen />, { api: createApi({ mode: 'hybrid', baseUrl: 'http://h' }) });
    const { act } = jest.requireActual('@testing-library/react-native');
    await act(async () => wv.last.props?.onLoadEnd?.());
    expect(screen.queryByTestId('map-loading')).toBeNull();
    await act(async () => wv.last.props?.onError?.());
    expect(screen.getByTestId('map-offline')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('state-retry'));
    expect(screen.getByTestId('map-loading')).toBeTruthy();
  });
  test('서버 origin만 허용하고 밖으로 나가는 이동은 막는다', async () => {
    await renderApp(<MapScreen />, { api: createApi({ mode: 'hybrid', baseUrl: 'http://10.0.2.2:8792/' }) });
    expect(wv.last.props?.originWhitelist).toEqual(['http://10.0.2.2:8792']);
    expect(wv.last.props?.onShouldStartLoadWithRequest?.({ url: 'http://10.0.2.2:8792/viewer?vehicleId=v' })).toBe(true);
    expect(wv.last.props?.onShouldStartLoadWithRequest?.({ url: 'https://evil.example/' })).toBe(false);
    expect(wv.last.props?.onShouldStartLoadWithRequest?.({ url: 'http://10.0.2.2:8792.evil.example/' })).toBe(false);
  });
  test('HTTP 오류는 불러오지 못했습니다, 연결 실패는 연결되지 않았습니다로 구분', async () => {
    await renderApp(<MapScreen />, { api: createApi({ mode: 'hybrid', baseUrl: 'http://h' }) });
    const { act } = jest.requireActual('@testing-library/react-native');
    await act(async () => wv.last.props?.onHttpError?.());
    expect(screen.getByTestId('map-error')).toBeTruthy();
    expect(screen.getByText('불러오지 못했습니다')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('state-retry'));
    await act(async () => wv.last.props?.onError?.());
    expect(screen.getByTestId('map-offline')).toBeTruthy();
  });
  test('mock 모드는 서버 지도 대신 안내(empty)', async () => {
    await renderApp(<MapScreen />);
    expect(screen.getByTestId('map-mock-empty')).toBeTruthy();
  });
  test('연결된 차가 없으면 안내', async () => {
    await renderApp(<MapScreen />, { pairing: null });
    expect(screen.getByTestId('state-empty')).toBeTruthy();
  });
});

test('공유 캐시 파일 이름에는 안전한 문자만', () => {
  expect(cardFileName({ id: '../../etc/pass wd', url: '', imageUrl: '' }, 'png')).toBe('nubi-card-______etc_pass_wd.png');
  expect(cardFileName({ id: 'abc-123_X', url: '', imageUrl: '' }, 'svg')).toBe('nubi-card-abc-123_X.svg');
});
