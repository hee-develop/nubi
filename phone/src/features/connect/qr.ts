export type QrKind = 'pair' | 'guest';
export type ParsedQr = { kind: QrKind | null; code: string };

/**
 * 차 QR/입력값에서 6자리 코드를 뽑는다. QR은 `.../p/<코드>`(차주 연결) 또는 `.../g/<코드>`(게스트) URL이다(계약서 T2 QR 랜딩).
 * 6자리 숫자만 오면 종류 없음(null)으로 돌려주고 호출한 화면의 모드를 따른다.
 */
export const parseQr = (raw: string): ParsedQr | null => {
  const s = raw.trim();
  if (/^\d{6}$/.test(s)) return { kind: null, code: s };
  const m = /\/(p|g)\/(\d{6})(?:[/?#]|$)/.exec(s);
  if (!m) return null;
  return { kind: m[1] === 'p' ? 'pair' : 'guest', code: m[2]! };
};
