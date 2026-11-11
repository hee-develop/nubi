import { isInsecureLive, resolveApiConfig, type ApiConfig } from './config';
import { createLiveApi, type TokenProvider } from './live';
import { createMockApi } from './mock';
import type { NubiApi } from './types';

export * from './types';
export { isInsecureLive, resolveApiConfig } from './config';
export { createMockApi, MOCK_VEHICLE_ID } from './mock';

/**
 * 모드별 조합. hybrid(기본, URL만 주면)는 도감·도로·트립 조회만 실서버로 보내고 나머지는 목이 답한다(기본 동작 유지).
 * T2를 합친 뒤에는 `live`가 전부 실서버이므로 새 API(연결·게스트·공유·설정·리포트·인증서)는 `EXPO_PUBLIC_NUBI_API_MODE=live`로 실서버에 붙인다.
 */
export const createApi = (cfg: ApiConfig = resolveApiConfig(), getToken?: TokenProvider, onUnauthorized?: () => void): NubiApi => {
  if (cfg.mode === 'mock') return createMockApi({ baseUrl: cfg.baseUrl });
  if (isInsecureLive(cfg)) console.warn('누비: live 모드에서 http(비TLS) 주소를 쓰고 있습니다. 개발용으로만 쓰세요.');
  const live = createLiveApi(cfg.baseUrl, cfg.mode, undefined, getToken, onUnauthorized);
  if (cfg.mode === 'live') return live;
  const mock = createMockApi({ baseUrl: cfg.baseUrl, mode: 'hybrid' });
  return {
    ...mock,
    mode: 'hybrid',
    baseUrl: cfg.baseUrl,
    viewerUrl: live.viewerUrl,
    coverageSummary: live.coverageSummary,
    coverageRoads: live.coverageRoads,
    regionsSummary: live.regionsSummary,
    regionsList: live.regionsList,
    trips: live.trips,
  };
};
