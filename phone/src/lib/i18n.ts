import { ja } from './strings.ja';
import { ko } from './strings.ko';

export type TKey = keyof typeof ko;
export type Locale = 'ko' | 'ja';

const detect = (): Locale => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('ja') ? 'ja' : 'ko';
  } catch {
    return 'ko';
  }
};

let current: Locale = detect();
export const getLocale = (): Locale => current;
export const setLocale = (l: Locale) => {
  current = l;
};

/** ko가 기준이고 ja에 없는 키는 ko로 대체한다. en은 같은 구조로 확장한다. */
export const t = (key: TKey, params?: Record<string, string | number>): string => {
  const dict: Partial<Record<TKey, string>> = current === 'ja' ? ja : ko;
  let s = dict[key] ?? ko[key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
};
