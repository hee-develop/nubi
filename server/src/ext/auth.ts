import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { isPlainObject, loadBody } from './body.js';
import { iso, parseAuthMode, DAY_MS, type ExtDeps } from './util.js';

/** 연결·게스트 코드: 6자리 숫자, 5분. */
export const CODE_TTL_MS = 5 * 60_000;
/** 만료·사용된 코드를 남겨 두는 시간(410과 404를 구분하려는 것). */
const CODE_KEEP_MS = 60 * 60_000;
/** 한 코드를 건드릴 수 있는 횟수(페이지 열람·claim 합계). 넘으면 그 코드는 무효가 된다(맞는 코드를 알아내려는 반복 시도 방어). */
export const CODE_MAX_ATTEMPTS = 8;
/** 차량 토큰은 차량당 이만큼만 남긴다(오래된 것부터 지운다). */
const MAX_VEHICLE_TOKENS = 5;
/** 앱 전역 요청 본문 상한(트립 점 업로드 경로의 기존 값과 같다). */
export const GLOBAL_BODY_LIMIT = 1024 * 1024;
/** 토큰 범위 판정을 위해 본문을 읽는 상한. 넘으면 fail-closed(413). */
const SCOPE_BODY_LIMIT = 16 * 1024;

export type TokenScope = 'api' | 'web' | 'view';
/** 종류별 만료. 차량 토큰은 만료 없이 폐기만 한다. */
const TTL: Record<TokenScope, number> = { api: 180 * DAY_MS, web: 7 * DAY_MS, view: DAY_MS };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export type TokenInfo =
  | { kind: 'vehicle'; vehicleId: string; scope: 'api' }
  | { kind: 'account'; accountId: string; role: 'owner' | 'guest'; vehicleId: string | null; scope: TokenScope };

export const issueToken = (db: Db, kind: 'vehicle' | 'account', subject: string, nowMs: number, scope: TokenScope = 'api'): string => {
  const token = newToken();
  const expires = kind === 'vehicle' ? null : iso(nowMs + TTL[scope]);
  db.prepare('INSERT INTO auth_tokens (token_hash, kind, subject, created_at, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    hashToken(token),
    kind,
    subject,
    iso(nowMs),
    kind === 'vehicle' ? 'api' : scope,
    expires,
  );
  if (kind === 'vehicle') {
    db.prepare(
      `DELETE FROM auth_tokens WHERE kind = 'vehicle' AND subject = ? AND token_hash NOT IN
       (SELECT token_hash FROM auth_tokens WHERE kind = 'vehicle' AND subject = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(subject, subject, MAX_VEHICLE_TOKENS);
  }
  return token;
};

/** 계정(또는 차량)의 토큰을 모두 폐기한다(행은 남기고 revoked_at만 채운다). */
export const revokeTokens = (db: Db, kind: 'vehicle' | 'account', subject: string, nowMs: number): void => {
  db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE kind = ? AND subject = ? AND revoked_at IS NULL').run(iso(nowMs), kind, subject);
};

/** 토큰을 찾는다. 폐기·만료된 것과 허용하지 않은 scope는 null. 기본은 API 토큰만. */
export const lookupToken = (db: Db, token: string, nowMs: number, scopes: TokenScope[] = ['api']): TokenInfo | null => {
  const row = db.prepare('SELECT kind, subject, scope, expires_at, revoked_at FROM auth_tokens WHERE token_hash = ?').get(hashToken(token)) as
    | { kind: string; subject: string; scope: string; expires_at: string | null; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= nowMs) || !scopes.includes(row.scope as TokenScope)) return null;
  if (row.kind === 'vehicle') return { kind: 'vehicle', vehicleId: row.subject, scope: 'api' };
  const a = db.prepare('SELECT id, kind, vehicle_id FROM accounts WHERE id = ?').get(row.subject) as { id: string; kind: string; vehicle_id: string | null } | undefined;
  if (!a) return null;
  return { kind: 'account', accountId: a.id, role: a.kind === 'owner' ? 'owner' : 'guest', vehicleId: a.vehicle_id, scope: row.scope as TokenScope };
};

export const bearerOf = (c: Context): string | null => {
  const m = /^Bearer\s+([A-Za-z0-9_\-.~+/=]{16,256})$/.exec(c.req.header('authorization') ?? '');
  return m ? m[1]! : null;
};

/** 요청의 Bearer 토큰으로 주체를 찾는다(API 토큰만). 없거나 틀리면 null. */
export const authenticate = (deps: Pick<ExtDeps, 'db' | 'now'>, c: Context): TokenInfo | null => {
  const t = bearerOf(c);
  return t ? lookupToken(deps.db, t, deps.now()) : null;
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
  /** 지금까지 창 안에 기록된 횟수. */
  count(key: string): number {
    return this.recent(key).length;
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

/** IP를 시도 제한용 키로. IPv6는 /64(앞 4개 그룹) 단위로 묶는다(주소를 바꿔 가며 우회하지 못하게). */
export const ipKey = (addr: string): string => {
  const a = addr.trim().toLowerCase().replace(/^::ffff:/, '');
  if (!a.includes(':')) return a.slice(0, 64);
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].slice(0, 4).map((g) => g.padStart(4, '0'));
  return `${groups.join(':')}::/64`;
};

const peerAddress = (c: Context): string | null => {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
};

/**
 * 신뢰하는 프록시 홉 수(`NUBI_TRUST_PROXY=<n>`, 숫자가 아니거나 0이면 신뢰 안 함. `1`은 한 홉). 공개 배포에서 서버 앞에 프록시가 n개 있을 때
 * X-Forwarded-For의 **오른쪽에서 n번째** 값만 클라이언트 주소로 쓴다(맨 왼쪽은 클라이언트가 마음대로 쓸 수 있어 쓰지 않는다). 미설정이면 소켓 주소.
 */
export const trustedHops = (): number => {
  const n = Number(process.env.NUBI_TRUST_PROXY ?? '0');
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0;
};

/** 클라이언트 주소: 신뢰 홉이 설정되어 있고 XFF가 충분히 길면 오른쪽에서 n번째, 아니면 소켓 주소. 모르면 null. */
export const clientAddress = (c: Context): string | null => {
  const hops = trustedHops();
  if (hops > 0) {
    const xff = (c.req.header('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const v = xff[xff.length - hops];
    if (v) return v.slice(0, 64);
  }
  return peerAddress(c);
};

/** 요청 출처 키(시도 제한용). IPv6는 /64. 알 수 없으면 'local'. */
export const clientKey = (c: Context): string => {
  const a = clientAddress(c);
  return a ? ipKey(a) : 'local';
};

const LOOPBACK = new Set(['127.0.0.1', '::1']);
/**
 * 로컬 접속인가(개발용 off 모드 전용 완화). 차량 에뮬레이터 트래픽도 호스트에서는 127.0.0.1로 보인다(10.0.2.x는 로컬로 보지 않는다).
 * 주소를 모르면 **로컬이 아니다**(fail-closed). 프로세스 안 호출(테스트)은 `inProcessLocal` 옵션으로 명시해야 로컬로 본다.
 * 신뢰 프록시가 없는데 프록시 헤더가 있으면 소켓 주소를 믿을 수 없으므로 로컬이 아니다.
 */
export const isLocalRequest = (c: Context, inProcessLocal = false): boolean => {
  if (trustedHops() === 0 && (c.req.header('x-forwarded-for') || c.req.header('forwarded') || c.req.header('x-real-ip'))) return false;
  const a = clientAddress(c);
  if (a === null) return inProcessLocal;
  return LOOPBACK.has(a.toLowerCase().replace(/^::ffff:/, ''));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 코드 시도 제한: 출처(IPv6는 /64)별로 시간 창 안 실패가 한도를 넘으면 429(맞는 코드도 막는다).
 * 전체 실패가 많으면 잠그지 않고(서비스 거부 방지) 실패 응답에 지연을 건다([penalty]).
 */
export class CodeGuard {
  private perClient: RateLimiter;
  private global: RateLimiter;
  private readonly globalSoft: number;
  constructor(now: () => number, opts: { max: number; windowMs: number } = { max: 10, windowMs: 5 * 60_000 }) {
    this.perClient = new RateLimiter(opts.max, opts.windowMs, now);
    this.global = new RateLimiter(Number.MAX_SAFE_INTEGER, opts.windowMs, now);
    this.globalSoft = opts.max * 20;
  }
  blocked(key: string): boolean {
    return this.perClient.blocked(key);
  }
  fail(key: string): void {
    this.perClient.record(key);
    this.global.record('*');
  }
  /** 실패 응답에 걸 지연(ms). 전체 실패가 많아질수록 늘어난다(최대 2초). */
  penalty(): number {
    const n = this.global.count('*');
    return n <= this.globalSoft ? 0 : Math.min(2000, 100 * Math.ceil((n - this.globalSoft) / 10));
  }
  async delayIfNeeded(): Promise<void> {
    const ms = this.penalty();
    if (ms > 0) await sleep(ms);
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

/**
 * 코드가 지금 쓸 수 있는지 본다(쓰지는 않는다). 존재하는 코드를 건드릴 때마다 시도 횟수를 세고,
 * [CODE_MAX_ATTEMPTS]를 넘으면 그 코드를 무효(사용됨)로 한다.
 */
export const checkCode = (db: Db, kind: 'pair' | 'guest', code: string, nowMs: number): CodeState => {
  const row = db.prepare('SELECT kind, vehicle_id, expires_at, used_at, attempts FROM link_codes WHERE code = ?').get(code) as
    | { kind: string; vehicle_id: string; expires_at: string; used_at: string | null; attempts: number }
    | undefined;
  if (!row || row.kind !== kind) return { ok: false, status: 404, error: 'code_not_found' };
  if (row.used_at) return { ok: false, status: 410, error: 'code_used' };
  if (Date.parse(row.expires_at) <= nowMs) return { ok: false, status: 410, error: 'code_expired' };
  if (row.attempts + 1 > CODE_MAX_ATTEMPTS) {
    db.prepare('UPDATE link_codes SET used_at = ? WHERE code = ?').run(iso(nowMs), code);
    return { ok: false, status: 410, error: 'code_used' };
  }
  db.prepare('UPDATE link_codes SET attempts = attempts + 1 WHERE code = ?').run(code);
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
  /^\/(g|p|s|c|me|b2b|viewer)(\/|$)/.test(path) ||
  (method === 'GET' && (path.startsWith('/share/cards/') || path === '/courses'));

/** 본문이 폼인 웹 페이지 POST(JSON 파싱 대상이 아니다). */
const isFormPage = (path: string): boolean => /^\/(g|p|me)(\/|$)/.test(path);

/**
 * 라우터가 보는 것과 같은 모양으로 정규화한 경로: URL 파서가 점 구간을 접고(`/./`, `/../`), 연속 슬래시를 하나로, 끝 슬래시를 떼고, 각 구간을 디코드한다.
 * 디코드할 수 없는 구간이 있으면 null(요청 거부). 차량 경로 판정은 이 경로로 한다(`/vehicles/V/./data` 같은 우회 방지).
 */
export const normalizedPath = (c: Context): string | null => {
  let p: string;
  try {
    p = new URL(c.req.url).pathname;
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (d === '..') parts.pop();
    else parts.push(d);
  }
  return '/' + parts.join('/');
};

export type RequestedVehicles = { vehicles: string[]; alias: { from?: string } | null };

/**
 * 요청이 가리키는 **모든** 차량 ID: 쿼리 `vehicleId`(반복 키 포함), 경로(`/vehicles/:id/…` 전체, `/trips/:id…`의 트립 소유 차량),
 * 미들웨어가 한 번 파싱한 JSON 본문의 `vehicleId`·`toVehicleId`(alias 외의 `fromVehicleId`). 하나라도 토큰 범위 밖이면 거부하려고 전부 모은다.
 */
export const requestedVehicles = (db: Db, c: Context, path: string, body: unknown): RequestedVehicles => {
  const out = new Set<string>();
  for (const v of c.req.queries('vehicleId') ?? []) if (v) out.add(v);
  // 이름을 퍼센트 인코딩한 키(vehicle%49d)도 URLSearchParams가 디코드해 같은 키로 본다
  for (const [k, v] of new URL(c.req.url).searchParams) if (k === 'vehicleId' && v) out.add(v);
  const v = /^\/vehicles\/([^/]+)\/.+/.exec(path);
  if (v && v[1] !== 'alias' && v[1] !== 'register') out.add(v[1]!);
  const t = /^\/trips\/([^/]+)(\/|$)/.exec(path);
  if (t) {
    const row = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(t[1]) as { vehicle_id: string } | undefined;
    if (row) out.add(row.vehicle_id);
  }
  let alias: RequestedVehicles['alias'] = null;
  if (isPlainObject(body)) {
    // alias의 출발점(from)은 아직 누구의 것도 아닌 임시 ID(UUID)라 토큰 범위로 볼 수 없다. 대신 [aliasSourceIsVehicle]이 '이미 쓰이는 ID'를 거부한다.
    for (const k of ['vehicleId', 'toVehicleId']) if (typeof body[k] === 'string') out.add(body[k] as string);
    if (path === '/vehicles/alias') alias = { from: typeof body.fromVehicleId === 'string' ? body.fromVehicleId : undefined };
    else if (typeof body.fromVehicleId === 'string') out.add(body.fromVehicleId);
  }
  return { vehicles: [...out], alias };
};

/**
 * alias의 출발점이 이미 쓰이는 ID인가(남의 차량 기록을 끌어오는 우회 방지): 차량 토큰·차주 연결·다른 alias의 대상(정본)이면 거부.
 * 인증 모드(optional·required)에서는 **트립·인정 도로·시군구 기록이 있는 ID도 거부**한다(그 ID로 쌓인 기록은 이미 누군가의 것이다).
 * `off`에서는 기존 흐름(차량 앱이 UUID로 올린 트립을 나중에 서버 ID에 잇기)을 위해 데이터 검사를 하지 않는다.
 */
const aliasSourceInUse = (db: Db, from: string, strict: boolean): boolean => {
  if (db.prepare("SELECT 1 AS x FROM auth_tokens WHERE kind = 'vehicle' AND subject = ? LIMIT 1").get(from)) return true;
  if (db.prepare("SELECT 1 AS x FROM accounts WHERE kind = 'owner' AND vehicle_id = ? LIMIT 1").get(from)) return true;
  if (db.prepare('SELECT 1 AS x FROM vehicle_alias WHERE vehicle_id = ? LIMIT 1').get(from)) return true;
  if (!strict) return false;
  for (const sql of [
    'SELECT 1 AS x FROM trips WHERE vehicle_id = ? LIMIT 1',
    'SELECT 1 AS x FROM driven_ways WHERE vehicle_id = ? LIMIT 1',
    'SELECT 1 AS x FROM visited_regions WHERE vehicle_id = ? LIMIT 1',
    'SELECT 1 AS x FROM region_events WHERE vehicle_id = ? LIMIT 1',
  ])
    if (db.prepare(sql).get(from)) return true;
  return false;
};

/** 인증이 off여도 로컬 접속(또는 맞는 토큰)만 허용하는 파괴적·민감 호출. */
const isSensitive = (method: string, path: string): boolean =>
  (method === 'DELETE' && /^\/vehicles\/[^/]+\/data$/.test(path)) ||
  (method === 'PUT' && /^\/vehicles\/[^/]+\/settings$/.test(path)) ||
  (method === 'POST' && (path === '/pair/code' || path === '/guest/code' || path === '/guest/end-all'));

/**
 * 앱 전역 미들웨어. 체인 맨 앞에 `.use('*', …)`로 한 번 등록하면 뒤에 붙는 모든 라우트(T1 `/map`·`/trips/:id/live` 포함)에 적용된다.
 *  1. 본문 크기: 앱 전역 1MB(`content-length`를 먼저 보고, 없으면 스트림을 세다 끊는다).
 *  2. 본문을 **한 번만** 파싱한다(Fetch 표준: UTF-8, BOM 제거). 이 값을 이 미들웨어의 범위 검사와 모든 라우트가 함께 쓴다.
 *     인증 모드에서 본문이 비어 있지 않은데 파싱에 실패하거나 JSON 객체가 아니면 400(fail-closed).
 *  3. alias 출발점 검사(모든 모드).
 *  4. `off`: 민감 호출은 로컬 접속만. 그 밖에는 기존 동작. 공개 배포는 `optional` 이상이 필수이고 `off`는 로컬 개발 전용이다.
 *  5. `optional`/`required`: Bearer 검증, 요청이 가리키는 모든 차량이 토큰 범위 안이어야 한다(아니면 403).
 * `/vehicles/register` 응답에는 `vehicleToken`을 더한다(off에서는 더하지 않아 기존 응답이 그대로다).
 */
export const authMiddleware = (deps: ExtDeps): MiddlewareHandler => {
  const mode = deps.options.auth ?? parseAuthMode(process.env.NUBI_AUTH);
  const inProcessLocal = deps.options.inProcessLocal === true;
  const limit = bodyLimit({ maxSize: GLOBAL_BODY_LIMIT, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });
  const core: MiddlewareHandler = async (c, next) => {
    const method = c.req.method;
    const path = normalizedPath(c);
    if (path === null) return c.json({ error: 'bad_request' }, 400);
    const parseJson = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !isFormPage(path);
    let body: unknown;
    if (parseJson) {
      const p = await loadBody(c);
      if (p.state === 'too_large') return c.json({ error: 'payload_too_large' }, 413);
      if (mode !== 'off' && (p.state === 'invalid' || (p.state === 'ok' && !isPlainObject(p.value)))) return c.json({ error: 'invalid_body' }, 400);
      body = p.state === 'ok' ? p.value : undefined;
    }
    if (method === 'POST' && path === '/vehicles/alias') {
      const from = isPlainObject(body) ? body.fromVehicleId : undefined;
      if (typeof from === 'string' && aliasSourceInUse(deps.db, from, mode !== 'off')) return c.json({ error: 'alias_source_is_vehicle' }, 409);
    }
    if (mode === 'off') {
      if (isSensitive(method, path) && !isLocalRequest(c, inProcessLocal)) return c.json({ error: 'local_only' }, 403);
      return next();
    }
    if (method === 'POST' && path === '/vehicles/register') {
      await next();
      if (c.res.status === 200) {
        const resBody = (await c.res.clone().json()) as { vehicleId?: string };
        if (typeof resBody.vehicleId === 'string') {
          const vehicleToken = issueToken(deps.db, 'vehicle', resBody.vehicleId, deps.now());
          c.res = c.json({ ...resBody, vehicleToken }, 200);
        }
      }
      return;
    }
    if (isExempt(method, path)) return next();
    const token = bearerOf(c);
    if (!token) {
      if (mode === 'required') return c.json({ error: 'unauthorized' }, 401);
      // optional + 토큰 없음: 기존 동작이지만 민감 호출은 로컬만
      if (isSensitive(method, path) && !isLocalRequest(c, inProcessLocal)) return c.json({ error: 'local_only' }, 403);
      return next();
    }
    const info = lookupToken(deps.db, token, deps.now());
    if (!info) return c.json({ error: 'unauthorized' }, 401);
    const { vehicles } = requestedVehicles(deps.db, c, path, body);
    for (const v of vehicles) if (!canAccessVehicle(deps.db, info, v)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
  return (c, next) => limit(c, (() => core(c, next)) as () => Promise<void>) as Promise<Response | void>;
};

/**
 * 경로 파라미터에 차량 ID를 받는 라우트를 등록할 때 쓰는 가드(기본 거부). 예: `.use('/foo/:vehicleId/*', vehicleScoped(deps))`.
 * 인증이 꺼져 있으면(off) 통과시키고, optional·required에서는 토큰이 있고 그 차량이 토큰 범위 안일 때만 통과한다(optional에서도 토큰이 없으면 거부).
 * 전역 미들웨어가 `/vehicles/:id/…`·`/trips/:id…`·쿼리·본문을 이미 검사하지만, 새 경로 모양을 추가할 때 이 가드를 함께 달아 놓치지 않게 한다.
 */
export const vehicleScoped = (deps: ExtDeps, param = 'vehicleId'): MiddlewareHandler => {
  const mode = deps.options.auth ?? parseAuthMode(process.env.NUBI_AUTH);
  return async (c, next) => {
    if (mode === 'off') return next();
    const token = bearerOf(c);
    const info = token ? lookupToken(deps.db, token, deps.now()) : null;
    if (!info) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param(param);
    if (!id || !canAccessVehicle(deps.db, info, id)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
};
