import { getLocale } from './i18n';

export const fmtKm = (km: number) => (km >= 100 ? Math.round(km).toLocaleString(getLocale()) : km.toFixed(1));
export const fmtMeters = (m: number) => fmtKm(m / 1000);
export const fmtPercent = (p: number) => (p === 0 ? '0' : p < 0.01 ? p.toFixed(4) : p < 1 ? p.toFixed(3) : p.toFixed(1));

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const fmtDuration = (s: number | null) => {
  if (s === null) return '';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** KST 기준 YYYY-MM-DD / YYYY-MM. 리포트 API가 KST 기준이다. */
export const kstDate = (now = Date.now()) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
export const kstMonth = (now = Date.now()) => kstDate(now).slice(0, 7);
