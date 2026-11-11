import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { iso, parseAuthMode, type ExtDeps } from './util.js';

/** 연결·게스트 코드: 6자리 숫자, 5분. */
export const CODE_TTL_MS = 5 * 60_000;
/** 만료·사용된 코드를 남겨 두는 시간(410과 404를 구분하려는 것). */
const CODE_KEEP_MS = 60 * 60_000;
/** 차량 토큰은 차량당 이만큼만 남긴다(오래된 것부터 지운다). */
const MAX_VEHICLE_TOKENS = 5;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export type TokenInfo =
  | { kind: 'vehicle'; vehicleId: string }
  | { kind: 'account'; accountId: string; role: 'owner' | 'guest'; vehicleId: string | null };

export const issueToken = (db: Db, kind: 'vehicle' | 'account', subject: string, nowMs: number): string => {
  const token = newToken();
  db.prepare('INSERT INTO auth_tokens (token_hash, kind, subject, created_at) VALUES (?, ?, ?, ?)').run(hashToken(token), kind, subject, iso(nowMs));
  if (kind === 'vehicle') {
    db.prepare(
      `DELETE FROM auth_tokens WHERE kind = 'vehicle' AND subject = ? AND token_hash NOT IN
       (SELECT token_hash FROM auth_tokens WHERE kind = 'vehicle' AND subject = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(subject, subject, MAX_VEHICLE_TOKENS);
  }
  return token;
};

export const lookupToken = (db: Db, token: string): TokenInfo | null => {
  const row = db.prepare('SELECT kind, subject FROM auth_tokens WHERE token_hash = ?').get(hashToken(token)) as { kind: string; subject: string } | undefined;
  if (!row) return null;
  if (row.kind === 'vehicle') return { kind: 'vehicle', vehicleId: row.subject };
  const a = db.prepare('SELECT id, kind, vehicle_id FROM accounts WHERE id = ?').get(row.subject) as { id: string; kind: string; vehicle_id: string | null } | undefined;
  if (!a) return null;
  return { kind: 'account', accountId: a.id, role: a.kind === 'owner' ? 'owner' : 'guest', vehicleId: a.vehicle_id };
};

export const bearerOf = (c: Context): string | null => {
  const m = /^Bearer\s+([A-Za-z0-9_\-.~+/=]{16,256})$/.exec(c.req.header('authorization') ?? '');
  return m ? m[1]! : null;
};

/** 요청의 Bearer 토큰으로 주체를 찾는다. 없거나 틀리면 null. */
export const authenticate = (db: Db, c: Context): TokenInfo | null => {
  const t = bearerOf(c);
  return t ? lookupToken(db, t) : null;
};

/** 토큰 주체가 그 차량(정본·alias 모두)에 접근해도 되는가. 게스트 계정은 차량 API에 접근하지 못한다. */
export const canAccessVehicle = (db: Db, info: TokenInfo, vehicleId: string): boolean => {
  const want = canonicalVehicleId(db, vehicleId);
  if (info.kind === 'vehicle') return canonicalVehicleId(db, info.vehicleId) === want;
  return info.role === 'owner' && info.vehicleId !== null && canonicalVehicleId(db, info.vehicleId) === want;
};

/** 간단한 슬라이딩 윈도 횟수 제한(메모리). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  private recent(key: string): number[] {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }
  /** 이미 한도를 넘었는가(기록하지 않는다). */
  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }
  /** 한 번 기록한다. */
  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
  }
}

/** 요청 출처 키. 프록시 헤더는 신뢰하지 않고(`NUBI_TRUST_PROXY=1`일 때만 X-Forwarded-For) 소켓 주소를 쓴다. 알 수 없으면 'local'. */
export const clientKey = (c: Context): string => {
  if (process.env.NUBI_TRUST_PROXY === '1') {
    const f = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (f) return f.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? 'local';
  } catch {
    return 'local';
  }
};

/** 코드 시도 제한: 출처별로 시간 창 안 실패 횟수가 한도를 넘으면 429(맞는 코드도 막는다). 전체 실패 횟수도 별도 한도. */
export class CodeGuard {
  private perClient: RateLimiter;
  private global: RateLimiter;
  constructor(now: () => number, opts: { max: number; windowMs: number } = { max: 10, windowMs: 5 * 60_000 }) {
    this.perClient = new RateLimiter(opts.max, opts.windowMs, now);
    this.global = new RateLimiter(opts.max * 20, opts.windowMs, now);
  }
  blocked(key: string): boolean {
    return this.perClient.blocked(key) || this.global.blocked('*');
  }
  fail(key: string): void {
    this.perClient.record(key);
    this.global.record('*');
  }
}

const guards = new WeakMap<object, CodeGuard>();
/** 연결·게스트 코드 시도 제한은 JSON API와 웹 페이지가 한 카운터를 나눠 쓴다(페이지로 코드 유효성을 캐내지 못하게). */
export const codeGuardOf = (deps: ExtDeps): CodeGuard => {
  let g = guards.get(deps);
  if (!g) {
    g = new CodeGuard(deps.now, deps.options.rateLimit);
    guards.set(deps, g);
  }
  return g;
};

/**
 * 6자리 숫자 코드를 새로 낸다(같은 종류·차량의 안 쓴 이전 코드는 지운다). 만료·사용된 코드는 1시간 남겼다가 지운다.
 * 코드 공간이 작아서(100만) 충돌하면 다시 뽑는다.
 */
export const issueCode = (db: Db, kind: 'pair' | 'guest', vehicleId: string, nowMs: number): { code: string; expiresAt: string } => {
  db.prepare('DELETE FROM link_codes WHERE expires_at <= ?').run(iso(nowMs - CODE_KEEP_MS));
  db.prepare('DELETE FROM link_codes WHERE kind = ? AND vehicle_id = ? AND used_at IS NULL').run(kind, vehicleId);
  const expiresAt = iso(nowMs + CODE_TTL_MS);
  for (let i = 0; i < 30; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const r = db.prepare('INSERT OR IGNORE INTO link_codes (code, kind, vehicle_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(code, kind, vehicleId, iso(nowMs), expiresAt);
    if (Number(r.changes) > 0) return { code, expiresAt };
  }
  throw new Error('코드를 만들 수 없습니다');
};

export type CodeState = { ok: true; vehicleId: string } | { ok: false; status: 404 | 410; error: 'code_not_found' | 'code_expired' | 'code_used' };

/** 코드가 지금 쓸 수 있는지 본다(쓰지는 않는다). */
export const checkCode = (db: Db, kind: 'pair' | 'guest', code: string, nowMs: number): CodeState => {
  const row = db.prepare('SELECT kind, vehicle_id, expires_at, used_at FROM link_codes WHERE code = ?').get(code) as
    | { kind: string; vehicle_id: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row || row.kind !== kind) return { ok: false, status: 404, error: 'code_not_found' };
  if (row.used_at) return { ok: false, status: 410, error: 'code_used' };
  if (Date.parse(row.expires_at) <= nowMs) return { ok: false, status: 410, error: 'code_expired' };
  return { ok: true, vehicleId: row.vehicle_id };
};

export const CODE_RE = /^\d{6}$/;

/** 공개 주소: 설정(`NUBI_PUBLIC_URL`)이 있으면 그것, 없으면 요청 주소의 origin. */
export const publicBase = (deps: ExtDeps, c: Context): string =>
  (deps.options.publicUrl ?? process.env.NUBI_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');

// ---- 토큰 인증 미들웨어(NUBI_AUTH=off|optional|required, 기본 off) ----

const isExempt = (method: string, path: string): boolean =>
  path === '/health' ||
  (method === 'POST' && (path === '/vehicles/register' || path === '/pair/claim' || path === '/guest/claim')) ||
  /^\/(g|p|s|me|b2b|viewer)(\/|$)/.test(path) ||
  (method === 'GET' && path.startsWith('/share/cards/'));

/** 요청이 가리키는 차량 ID(쿼리 → 경로 → 트립 → JSON 본문 순). 알 수 없으면 null(범위 검사를 건너뛴다). */
const requestedVehicle = async (db: Db, c: Context): Promise<string | null> => {
  const q = c.req.query('vehicleId');
  if (q) return q;
  const path = c.req.path;
  const v = /^\/vehicles\/([^/]+)\/(settings|data)$/.exec(path);
  if (v) return decodeURIComponent(v[1]!);
  const t = /^\/trips\/([^/]+)(\/|$)/.exec(path);
  if (t) {
    const row = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(decodeURIComponent(t[1]!)) as { vehicle_id: string } | undefined;
    return row?.vehicle_id ?? null;
  }
  if (['POST', 'PUT', 'DELETE'].includes(c.req.method)) {
    try {
      const text = await c.req.raw.clone().text();
      if (text.length <= 16_384) {
        const b = JSON.parse(text) as { vehicleId?: unknown; toVehicleId?: unknown };
        if (typeof b.vehicleId === 'string') return b.vehicleId;
        if (typeof b.toVehicleId === 'string') return b.toVehicleId;
      }
    } catch {
      // 본문이 없거나 JSON이 아니면 범위 검사를 건너뛴다(라우트가 400을 낸다)
    }
  }
  return null;
};

/**
 * 토큰 인증(사양 05b). `off`면 아무것도 하지 않는다(기존 동작). `optional`이면 토큰이 있을 때만 검증하고, `required`면 모든 API에 Bearer가 필요하다.
 * 토큰이 가리키는 차량과 요청의 차량 ID가 다르면 403이다. 연결·게스트 코드 API, 공개 웹 페이지(`/g`·`/p`·`/me`·`/s`), B2B(자체 키), 공유 이미지는 면제다.
 * `/vehicles/register` 응답에는 `vehicleToken`을 더한다(off에서는 더하지 않아 기존 응답이 그대로다).
 */
export const authMiddleware = (deps: ExtDeps): MiddlewareHandler => {
  const mode = deps.options.auth ?? parseAuthMode(process.env.NUBI_AUTH);
  return async (c, next) => {
    if (mode === 'off') return next();
    const method = c.req.method;
    const path = c.req.path;
    if (method === 'POST' && path === '/vehicles/register') {
      await next();
      if (c.res.status === 200) {
        const body = (await c.res.clone().json()) as { vehicleId?: string };
        if (typeof body.vehicleId === 'string') {
          const vehicleToken = issueToken(deps.db, 'vehicle', body.vehicleId, deps.now());
          c.res = c.json({ ...body, vehicleToken }, 200);
        }
      }
      return;
    }
    if (isExempt(method, path)) return next();
    const token = bearerOf(c);
    if (!token) return mode === 'required' ? c.json({ error: 'unauthorized' }, 401) : next();
    const info = lookupToken(deps.db, token);
    if (!info) return c.json({ error: 'unauthorized' }, 401);
    const vehicleId = await requestedVehicle(deps.db, c);
    if (vehicleId && !canAccessVehicle(deps.db, info, vehicleId)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
};
