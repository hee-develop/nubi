import Index from '../app/index';
import TabsLayout from '../app/(tabs)/_layout';
import { Redirect } from '../test/router-mock';
import { GUEST, renderApp } from '../test/utils';

const redirect = Redirect as jest.Mock;
beforeEach(() => redirect.mockClear());
const lastHref = () => redirect.mock.calls.at(-1)?.[0].href;

describe('시작 라우팅', () => {
  test('연결된 차가 있으면 탭', async () => {
    await renderApp(<Index />);
    expect(lastHref()).toBe('/(tabs)');
  });
  test('게스트 세션만 있으면 게스트 화면', async () => {
    await renderApp(<Index />, { pairing: null, guest: GUEST });
    expect(lastHref()).toBe('/guest');
  });
  test('아무것도 없으면 연결 화면', async () => {
    await renderApp(<Index />, { pairing: null });
    expect(lastHref()).toBe('/connect');
  });
  test('연결 없이 탭에 들어오면 연결 화면으로 돌려보낸다', async () => {
    await renderApp(<TabsLayout />, { pairing: null });
    expect(lastHref()).toBe('/connect');
  });
});
