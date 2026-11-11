import { isInsecureLive, resolveApiConfig, type ApiConfig } from './config';
import { createLiveApi, type TokenProvider } from './live';
import { createMockApi } from './mock';
import type { NubiApi } from './types';

export * from './types';
export { isInsecureLive, resolveApiConfig } from './config';
export { createMockApi, MOCK_VEHICLE_ID } from './mock';

/**
 * 모드별 조합. hybrid는 서버에 이미 있는 API만 실서버로 보내고 나머지는 목이 답한다(T2 서버 합치기 전).
 * live는 전부 실서버.
 */
export const createApi = (cfg: ApiConfig = resolveApiConfig(), getToken?: TokenProvider): NubiApi => {
  if (cfg.mode === 'mock') return createMockApi({ baseUrl: cfg.baseUrl });
  if (isInsecureLive(cfg)) console.warn('누비: live 모드에서 http(비TLS) 주소를 쓰고 있습니다. 개발용으로만 쓰세요.');
  const live = createLiveApi(cfg.baseUrl, cfg.mode, undefined, getToken);
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
