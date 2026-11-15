import appConfig, { allowCleartext } from '../../app.config';
import { isInsecureLive } from '../api';

describe('cleartext(http) 허용은 개발 전용', () => {
  test('기본(프로필 없음)은 꺼짐', () => expect(allowCleartext({})).toBe(false));
  test('NUBI_ALLOW_CLEARTEXT=1 또는 development 프로필이면 켜짐', () => {
    expect(allowCleartext({ NUBI_ALLOW_CLEARTEXT: '1' })).toBe(true);
    expect(allowCleartext({ EAS_BUILD_PROFILE: 'development' })).toBe(true);
  });
  test('preview·production은 환경 변수가 있어도 꺼짐', () => {
    expect(allowCleartext({ EAS_BUILD_PROFILE: 'production', NUBI_ALLOW_CLEARTEXT: '1' })).toBe(false);
    expect(allowCleartext({ EAS_BUILD_PROFILE: 'preview', NUBI_ALLOW_CLEARTEXT: '1' })).toBe(false);
  });
  test('app.config가 app.json 위에 build-properties 플러그인을 덧붙인다(기본 꺼짐)', () => {
    const cfg = appConfig({ config: { name: 'n', slug: 's', plugins: ['expo-router'] }, projectRoot: '', staticConfigPath: null, packageJsonPath: null, hasUnusedStaticConfig: false } as never);
    expect(cfg.plugins).toContainEqual(['expo-build-properties', { android: { usesCleartextTraffic: false } }]);
    expect(cfg.plugins).toContain('expo-router');
  });
});

test('live 모드의 http 주소만 경고 대상', () => {
  expect(isInsecureLive({ mode: 'live', baseUrl: 'http://10.0.2.2:8792' })).toBe(true);
  expect(isInsecureLive({ mode: 'live', baseUrl: 'https://api.nubi.example' })).toBe(false);
  expect(isInsecureLive({ mode: 'hybrid', baseUrl: 'http://10.0.2.2:8792' })).toBe(false);
  expect(isInsecureLive({ mode: 'mock', baseUrl: '' })).toBe(false);
});
