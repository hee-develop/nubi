/** 바램 규칙(plan 8장): 마지막 인정(통과 이상 판정) 시각에서 365일이 지나면 한 번 채도를 낮춘다. 저장하는 것은 마지막 시각뿐이고 바램은 그릴 때 계산한다. */
export const FADE_DAYS = 365;
const DAY_MS = 24 * 3_600_000;

/** [lastAt](ISO)에서 [days]일(기본 365)이 **지났으면** true. 시각을 읽을 수 없으면 false(바랜 것으로 보지 않는다). 완료율·등급은 바래도 그대로다. */
export const isFaded = (lastAt: string | null | undefined, now: number, days: number = FADE_DAYS): boolean => {
  if (!lastAt) return false;
  const t = Date.parse(lastAt);
  return Number.isFinite(t) && now - t > days * DAY_MS;
};
