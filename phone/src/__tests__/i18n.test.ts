import { ko } from '../lib/strings.ko';
import { ja } from '../lib/strings.ja';
import { getLocale, setLocale, t } from '../lib/i18n';
import { fmtKm, fmtPercent, kstDate, kstMonth } from '../lib/format';

afterEach(() => setLocale('ko'));

test('ja 키는 모두 ko에 있다(오타 방지)', () => {
  for (const k of Object.keys(ja)) expect(k in ko).toBe(true);
});
test('ja에 없는 키는 ko로 대체, 치환', () => {
  setLocale('ja');
  expect(getLocale()).toBe('ja');
  expect(t('tab.home')).toBe('ホーム');
  expect(t('home.drivenOf', { driven: 1, total: 2 })).toBe('1km / 2km'); // ko 대체
  expect(t('home.regions', { n: 3, total: 229 })).toBe('市区町村 3/229');
});
test('ja 위치정보 동의 문구는 です・ます체이고 길어도 줄바꿈 가능한 일반 문자열', () => {
  setLocale('ja');
  expect(t('guest.consent.body')).toMatch(/同意します/);
  expect(t('guest.consent.body').length).toBeGreaterThan(60);
});
test('숫자 형식·KST 날짜', () => {
  expect(fmtPercent(0.0012)).toBe('0.0012');
  expect(fmtPercent(12.345)).toBe('12.3');
  expect(fmtKm(18.44)).toBe('18.4');
  expect(kstDate(Date.parse('2026-11-11T16:00:00Z'))).toBe('2026-11-12'); // UTC 16시 = KST 다음날 01시
  expect(kstMonth(Date.parse('2026-11-30T16:00:00Z'))).toBe('2026-12');
});

test('ja 동의 문구(연결·게스트)와 오류 문구가 채워져 있다', () => {
  for (const k of ['connect.consent.title', 'connect.consent.body', 'connect.consent.check', 'guest.consent.retention', 'guest.consent.subtitle', 'guest.consent.nickname', 'guest.consent.body', 'guest.consent.check', 'connect.err.used', 'connect.err.alreadyPaired', 'connect.err.consent'] as const)
    expect(ja[k]).toBeTruthy();
});
