/** 브랜드 00 시안 색·타이포. 색만으로 상태를 전달하지 않으므로 레벨·바램은 항상 글자와 함께 쓴다. */
export const colors = {
  bg: '#0f141b',
  panel: '#171e27',
  panel2: '#1d2631',
  line: '#2a3544',
  text: '#eef2f7',
  muted: '#a9b6c6',
  accent: '#f59e0b',
  accentText: '#1a1204',
  depop: '#2dd4bf',
  noneDepop: '#1c323a',
  road: '#fbbf24',
  none: '#1a222d',
  lv1: 'rgba(245,158,11,0.28)',
  lv2: 'rgba(245,158,11,0.6)',
  lv3: '#f59e0b',
  lv3Faded: '#c79a4c',
  danger: '#ef4444',
} as const;

export const font = { regular: undefined, bold: '700' as const, heavy: '800' as const };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
/** 터치 타깃: Android 48dp 이상. */
export const MIN_TOUCH = 48;
