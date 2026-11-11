/**
 * 요청 본문을 **한 번만** 파싱해 미들웨어·라우트가 같은 값을 쓰게 한다(C1: 미들웨어와 라우트가 다르게 읽어 범위 검사를 우회하던 문제).
 * 파싱은 Fetch 표준 `Request.json()`과 같다: 바이트를 UTF-8로 해석(앞의 BOM은 제거)해 JSON.parse. UTF-16 등 다른 인코딩은 파싱 실패다.
 * 결과는 Hono 컨텍스트에 한 번 저장한다(하위 라우트의 `bodyLimit`이 `c.req.raw`를 바꿔도 같은 값을 쓴다).
 */
import type { Context } from 'hono';

export type ParsedBody =
  | { state: 'empty' }
  | { state: 'ok'; value: unknown }
  | { state: 'invalid' }
  | { state: 'too_large' };

const KEY = 'nubi.body';

/** 스트림을 [max]바이트까지만 읽는다. 넘으면 null. */
const readCapped = async (req: Request, max: number): Promise<Uint8Array | null> => {
  const body = req.clone().body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/** Fetch 표준과 같은 방식으로 바이트를 JSON으로(BOM 제거). */
export const parseJsonBytes = (bytes: Uint8Array): ParsedBody => {
  if (bytes.byteLength === 0) return { state: 'empty' };
  try {
    return { state: 'ok', value: JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown };
  } catch {
    return { state: 'invalid' };
  }
};

/** 이 요청의 본문(한 번만 읽고 컨텍스트에 보관). 본문이 있을 수 없는 메서드는 empty. */
export const loadBody = async (c: Context, max = 1024 * 1024): Promise<ParsedBody> => {
  const cached = c.get(KEY as never) as ParsedBody | undefined;
  if (cached) return cached;
  let parsed: ParsedBody = { state: 'empty' };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    const bytes = await readCapped(c.req.raw, max);
    parsed = bytes === null ? { state: 'too_large' } : parseJsonBytes(bytes);
  }
  c.set(KEY as never, parsed as never);
  return parsed;
};

/** 라우트가 쓰는 본문 값. 비었거나 파싱에 실패했으면 undefined(라우트가 400을 낸다). 직접 `c.req.json()`을 부르지 않는다. */
export const bodyOf = async (c: Context): Promise<unknown> => {
  const p = await loadBody(c);
  return p.state === 'ok' ? p.value : undefined;
};

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
