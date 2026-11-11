import { ApiError } from './types';

export type FetchLike = typeof fetch;

/** 네트워크 실패는 offline, HTTP 오류는 http로 분류해 던진다. 화면은 이 분류로 상태(offline/error)를 고른다. */
export const makeApiFetch =
  (baseFetch: FetchLike = fetch): FetchLike =>
  async (input, init) => {
    let res: Response;
    try {
      res = await baseFetch(input, init);
    } catch {
      throw new ApiError('offline', 0, 'network');
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const b = (await res.clone().json()) as { error?: string };
        if (typeof b.error === 'string') code = b.error;
      } catch {
        /* 본문이 JSON이 아니면 상태 코드만 쓴다 */
      }
      throw new ApiError('http', res.status, code);
    }
    return res;
  };

export const qs = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
