import { fireEvent, screen, within } from '@testing-library/react-native';
import { ApiError } from '../api';
import { HomeScreen } from '../features/home/HomeScreen';
import { flush, makeApi, renderApp } from '../test/utils';

const never = () => new Promise<never>(() => undefined);

test('ready: 전국 완료율·시군구 n/229·인구감소지역 n/92·오늘/이번 달·최근 트립', async () => {
  await renderApp(<HomeScreen />);
  expect(screen.getByTestId('home-percent').props.children.join('')).toContain('0.0012');
  expect(screen.getByTestId('home-regions').props.children).toBe('시군구 5/229');
  expect(screen.getByTestId('home-depop').props.children).toMatch(/인구감소지역 \d+\/92/);
  expect(screen.getByTestId('home-today')).toBeTruthy();
  expect(screen.getByTestId('home-month')).toBeTruthy();
  expect(screen.getAllByTestId('home-trip-row')).toHaveLength(5);
});

test('오늘 리포트 요청은 KST 날짜, 이번 달은 KST 월', async () => {
  const api = makeApi();
  const d = jest.spyOn(api, 'reportsDaily');
  const m = jest.spyOn(api, 'reportsMonthly');
  await renderApp(<HomeScreen />, { api });
  expect(d.mock.calls[0]![1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(m.mock.calls[0]![1]).toMatch(/^\d{4}-\d{2}$/);
});

test('loading: 세 구역 모두 불러오는 중', async () => {
  const api = makeApi({ coverageSummary: never, reportsDaily: never, trips: never });
  await renderApp(<HomeScreen />, { api });
  expect(screen.getByTestId('home-national-loading')).toBeTruthy();
  expect(screen.getByTestId('home-reports-loading')).toBeTruthy();
  expect(screen.getByTestId('home-trips-loading')).toBeTruthy();
});

test('empty: 트립이 없으면 안내 문구', async () => {
  const api = makeApi({ trips: async () => ({ trips: [] }) });
  await renderApp(<HomeScreen />, { api });
  expect(screen.getByTestId('home-trips-empty')).toBeTruthy();
  expect(screen.getByText(/아직 기록된 트립이 없습니다/)).toBeTruthy();
});

test('error: 한 구역이 실패해도 다른 구역은 보이고, 다시 시도하면 복구', async () => {
  let fail = true;
  const base = makeApi();
  const api = makeApi({ reportsDaily: async (v, d) => { if (fail) throw new ApiError('http', 404, 'not_found'); return base.reportsDaily(v, d); } });
  await renderApp(<HomeScreen />, { api });
  expect(screen.getByTestId('home-reports-error')).toBeTruthy();
  expect(screen.getByTestId('home-percent')).toBeTruthy();
  fail = false;
  await fireEvent.press(within(screen.getByTestId('home-reports-error')).getByTestId('state-retry'));
  await flush();
  expect(screen.getByTestId('home-today')).toBeTruthy();
});

test('offline: 네트워크 실패는 연결 안내와 다시 시도', async () => {
  const off = async () => { throw new ApiError('offline', 0, 'network'); };
  await renderApp(<HomeScreen />, { api: makeApi({ coverageSummary: off, trips: off }) });
  expect(screen.getByTestId('home-national-offline')).toBeTruthy();
  expect(screen.getByTestId('home-trips-offline')).toBeTruthy();
  expect(screen.getAllByText('연결되지 않았습니다').length).toBeGreaterThan(0);
});
