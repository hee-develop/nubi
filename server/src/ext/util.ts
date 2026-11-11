import type { Context } from 'hono';
import type { z } from 'zod';
import type { Db } from '../db/index.js';
import type { Regions } from '../regions/index.js';
import type { Roads } from '../roads/index.js';

/** 확장 라우트가 함께 쓰는 의존성(app.ts가 만든다). */
export type ExtDeps = {
  db: Db;
  getRoads: () => Roads | null;
  getRegions: () => Regions | null;
  /** 현재 시각(ms). 테스트가 고정·전진시킨다. */
  now: () => number;
  options: ExtOptions;
};

export type AuthMode = 'off' | 'optional' | 'required';

/** `createApp`의 `ext` 옵션. 생략한 값은 환경변수에서 읽는다. */
export type ExtOptions = {
  /** `NUBI_AUTH`(off|optional|required, 기본 off). */
  auth?: AuthMode;
  /** QR·공유 링크의 바탕 주소(`NUBI_PUBLIC_URL`). 없으면 요청 주소를 쓴다. */
  publicUrl?: string;
  /** B2B API 키(`NUBI_B2B_KEY`). 없으면 B2B API는 503. */
  b2bKey?: string;
  /** TourAPI 인증키(`NUBI_TOURAPI_KEY`). 없으면 예시 데이터. */
  tourApiKey?: string;
  /** TourAPI 호출용 fetch(테스트가 가짜를 끼운다). */
  fetchFn?: typeof fetch;
  /** `POST /debug/age` 등록 여부. 생략하면 NODE_ENV가 production이 아닐 때만 등록한다. */
  debug?: boolean;
  /** 공유 카드 PNG 변환에 쓸 글꼴 파일(`NUBI_CARD_FONT`). 생략하면 시스템 글꼴. */
  fontFile?: string;
  /** 요청 횟수 제한 조정(테스트용). */
  rateLimit?: { max: number; windowMs: number };
};

export const parseAuthMode = (v: string | undefined): AuthMode => (v === 'optional' || v === 'required' ? v : 'off');

export const readJson = async (req: Request): Promise<unknown> => {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
};

/** 본문을 zod로 검증한다. 실패하면 입력을 되돌려 주지 않고 `{ error: 'invalid_body' }`만 400으로 낸다. */
export const parseBody = async <T extends z.ZodType>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> => {
  const parsed = schema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return { ok: false, res: c.json({ error: 'invalid_body' }, 400) };
  return { ok: true, data: parsed.data };
};

export const iso = (ms: number) => new Date(ms).toISOString();

/** ISO 시각에서 일수를 뺀다(디버그 시연용 당기기). */
export const SQL_SHIFT_DAYS = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${col}) - ?)`;

export const KST_MS = 9 * 3_600_000;
export const DAY_MS = 24 * 3_600_000;

/** 'YYYY-MM-DD'(KST) 하루의 UTC 구간 [시작, 끝). 달력에 없는 날짜면 null. */
export const kstDayRange = (date: string): [number, number] | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return [t - KST_MS, t - KST_MS + DAY_MS];
};

/** 'YYYY-MM'(KST) 한 달의 UTC 구간 [시작, 끝). 형식이 틀리면 null. */
export const kstMonthRange = (month: string): [number, number] | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12 || y < 2000 || y > 2200) return null;
  return [Date.UTC(y, mo - 1, 1) - KST_MS, Date.UTC(y, mo, 1) - KST_MS];
};
