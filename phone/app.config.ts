import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * app.json이 기본이고, 여기서 빌드 환경별 네이티브 설정만 덧붙인다.
 * http(비TLS) 허용(`usesCleartextTraffic`)은 개발 전용이다: `NUBI_ALLOW_CLEARTEXT=1`이거나 EAS `development` 프로필일 때만 켠다.
 * 에뮬레이터에서 호스트 서버(http://10.0.2.2:<포트>)를 쓰려면 `NUBI_ALLOW_CLEARTEXT=1`로 prebuild·빌드한다(Expo Go는 영향 없음).
 * preview·production은 항상 끈다.
 */
export const allowCleartext = (env: Record<string, string | undefined> = process.env) =>
  env.EAS_BUILD_PROFILE === 'production' || env.EAS_BUILD_PROFILE === 'preview' ? false : env.NUBI_ALLOW_CLEARTEXT === '1' || env.EAS_BUILD_PROFILE === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  plugins: [...(config.plugins ?? []), ['expo-build-properties', { android: { usesCleartextTraffic: allowCleartext() } }]],
});
