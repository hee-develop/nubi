/**
 * API 모드 한 곳 설정.
 *  - mock   : 모든 API를 앱 안의 목으로 처리(서버 불필요)
 *  - hybrid : 서버에 이미 있는 API(/coverage·/regions·/trips)는 실서버, 아직 없는 새 API는 목
 *  - live   : 전부 실서버(T2 합친 뒤)
 * `EXPO_PUBLIC_NUBI_API_MODE`, `EXPO_PUBLIC_NUBI_API_URL`로 바꾼다. URL이 없으면 mock.
 */
export type ApiMode = 'mock' | 'hybrid' | 'live';

export type ApiConfig = { mode: ApiMode; baseUrl: string };

export const resolveApiConfig = (env: Record<string, string | undefined> = process.env): ApiConfig => {
  const baseUrl = (env.EXPO_PUBLIC_NUBI_API_URL ?? '').replace(/\/+$/, '');
  const raw = env.EXPO_PUBLIC_NUBI_API_MODE;
  const mode: ApiMode = raw === 'mock' || raw === 'hybrid' || raw === 'live' ? raw : baseUrl ? 'hybrid' : 'mock';
  return { mode: baseUrl ? mode : 'mock', baseUrl };
};
