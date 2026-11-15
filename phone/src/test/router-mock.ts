/** expo-router 대체: 화면 테스트가 이동 호출과 쿼리 파라미터를 확인한다. */
export const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
export let params: Record<string, string> = {};
export const setParams = (p: Record<string, string>) => {
  params = p;
};
export const resetRouter = () => {
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  params = {};
};
export const useRouter = () => router;
export const useLocalSearchParams = () => params;
export const Redirect = jest.fn((_: { href: string }) => null);
export const Tabs = Object.assign(() => null, { Screen: () => null });
