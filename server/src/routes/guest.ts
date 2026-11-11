import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authenticate, bearerOf, checkCode, clientKey, CODE_RE, codeGuardOf, issueCode, issueToken, publicBase, RateLimiter, type CodeGuard, type TokenInfo } from '../ext/auth.js';
import { activeCount, endSession, expireIdle, MAX_GUESTS, onTripStarted } from '../ext/sessions.js';
import { guestCoverage, guestRegionLevels, ownerCoverage, ownerRegionLevels, regionItems, regionSummary, type RegionLevels } from '../ext/stats.js';
import { iso, parseBody, readJson, type ExtDeps } from '../ext/util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { ATTRIBUTION } from '../roads/index.js';
import { REGIONS_ATTRIBUTION } from '../regions/index.js';

const id = z.string().min(1).max(128);
const gear = z.enum(['P', 'R', 'N', 'D']);
const codeBody = z.object({ vehicleId: id, gear });
const claimBody = z.object({ code: z.string().regex(CODE_RE), consent: z.boolean(), nickname: z.string().trim().min(1).max(20).optional() });
const vehicleBody = z.object({ vehicleId: id });

export type JoinResult =
  | { ok: true; sessionId: string; token: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 410 | 429; error: string };

/**
 * 게스트 세션 열기(JSON API와 웹 페이지 `/g/:code`가 함께 쓴다). 동의 전에는 세션이 열리지 않는다.
 * [existing]이 있으면(차주·기존 게스트의 Bearer) 그 계정으로 앉는다. 없으면 익명 게스트 계정을 새로 만든다.
 */
export const joinGuest = (
  deps: ExtDeps,
  guard: CodeGuard,
  key: string,
  input: { code: string; consent: boolean; nickname?: string },
  existing: { info: TokenInfo; token: string } | null,
): JoinResult => {
  const { db, now } = deps;
  if (guard.blocked(key)) return { ok: false, status: 429, error: 'too_many_requests' };
  if (!input.consent) return { ok: false, status: 400, error: 'consent_required' };
  const state = checkCode(db, 'guest', input.code, now());
  if (!state.ok) {
    guard.fail(key);
    return { ok: false, status: state.status, error: state.error };
  }
  const vehicleId = state.vehicleId;
  if (existing && existing.info.kind === 'account' && existing.info.vehicleId && canonicalVehicleId(db, existing.info.vehicleId) === vehicleId)
    return { ok: false, status: 409, error: 'own_vehicle' };
  if (existing && existing.info.kind === 'vehicle') return { ok: false, status: 403, error: 'forbidden' };
  if (activeCount(db, vehicleId, now()) >= MAX_GUESTS) return { ok: false, status: 409, error: 'guest_limit' };
  const accountId = existing && existing.info.kind === 'account' ? existing.info.accountId : null;
  // 같은 사람이 같은 시각 두 차량에 있을 수 없다: 이미 열린 세션이 있으면 먼저 시작한 세션만 인정한다(plan 9-3).
  if (accountId) {
    for (const s of db.prepare('SELECT vehicle_id FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL').all(accountId) as { vehicle_id: string }[])
      expireIdle(db, now(), s.vehicle_id);
    if (db.prepare('SELECT 1 AS x FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL').get(accountId)) return { ok: false, status: 409, error: 'already_in_session' };
  }
  const sessionId = randomUUID();
  db.exec('BEGIN');
  try {
    let account = accountId;
    let token = existing?.token ?? '';
    if (!account) {
      account = randomUUID();
      db.prepare("INSERT INTO accounts (id, kind, nickname, created_at, consent_at) VALUES (?, 'guest', ?, ?, ?)").run(account, input.nickname ?? null, iso(now()), iso(now()));
      token = issueToken(db, 'account', account, now());
    }
    db.prepare('INSERT INTO guest_sessions (id, vehicle_id, account_id, nickname, consent_at, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      sessionId,
      vehicleId,
      account,
      input.nickname ?? null,
      iso(now()),
      iso(now()),
    );
    db.prepare('UPDATE link_codes SET used_at = ? WHERE code = ?').run(iso(now()), input.code);
    db.exec('COMMIT');
    return { ok: true, sessionId, token };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

/** 그 차량 쪽 주체인가: 차량 토큰 또는 그 차의 차주 계정 토큰. */
const isCarOf = (db: ExtDeps['db'], info: TokenInfo, vehicleId: string): boolean => {
  const mine = info.kind === 'vehicle' ? info.vehicleId : info.role === 'owner' ? info.vehicleId : null;
  return mine !== null && canonicalVehicleId(db, mine) === vehicleId;
};

/** 세션을 끝낼 권한: 그 세션의 계정(게스트 본인) · 그 차량 쪽 주체 · (인증 off일 때) 본문의 차량 ID가 세션 차량과 같은 차. */
const canEnd = (db: ExtDeps['db'], info: TokenInfo | null, session: { vehicle_id: string; account_id: string }, bodyVehicle: string | null, authMode: boolean) => {
  if (info) return (info.kind === 'account' && info.accountId === session.account_id) || isCarOf(db, info, session.vehicle_id);
  return !authMode && bodyVehicle !== null && canonicalVehicleId(db, bodyVehicle) === session.vehicle_id;
};

/** 게스트 탑승(plan 9장): 코드 발급 → 동의 → 세션 → 인정 → 종료, 차주는 인원만 본다. */
export const guestRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const guard = codeGuardOf(deps);
  const issueLimit = new RateLimiter(deps.options.rateLimit?.max ? deps.options.rateLimit.max * 3 : 30, deps.options.rateLimit?.windowMs ?? 5 * 60_000, now);

  /** 현재 Bearer가 있으면 주체를 찾는다(잘못된 토큰이면 'invalid'). */
  const who = (c: Context): { info: TokenInfo; token: string } | null | 'invalid' => {
    const token = bearerOf(c);
    if (!token) return hasAuthHeader(c) ? 'invalid' : null;
    const info = authenticate(db, c);
    return info ? { info, token } : 'invalid';
  };
  const hasAuthHeader = (c: Context) => (c.req.header('authorization') ?? '') !== '';

  const myLevels = (info: TokenInfo): { levels: RegionLevels; owner: boolean } | null => {
    if (info.kind !== 'account') return null;
    if (info.role === 'owner' && info.vehicleId) return { levels: ownerRegionLevels(db, canonicalVehicleId(db, info.vehicleId)), owner: true };
    return { levels: guestRegionLevels(db, deps.getRegions(), info.accountId), owner: false };
  };

  return new Hono()
    // 게스트가 자기 차에서 트립을 시작하면 세션을 끝낸다. 트립 라우트는 건드리지 않고 시작 요청의 성공 응답을 본다.
    .use('/trips', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      let body: { vehicleId?: unknown; startedAt?: unknown } | undefined;
      try {
        body = (await c.req.raw.clone().json()) as typeof body;
      } catch {
        body = undefined;
      }
      await next();
      if (c.res.status !== 200 && c.res.status !== 201) return;
      const startedAt = typeof body?.startedAt === 'string' ? Date.parse(body.startedAt) : NaN;
      if (typeof body?.vehicleId === 'string' && Number.isFinite(startedAt)) onTripStarted(db, body.vehicleId, startedAt);
    })
    .use('/guest/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }))
    .post('/guest/code', async (c) => {
      const p = await parseBody(c, codeBody);
      if (!p.ok) return p.res;
      if (p.data.gear !== 'P') return c.json({ error: 'not_parked' }, 403);
      const vehicleId = canonicalVehicleId(db, p.data.vehicleId);
      if (issueLimit.blocked(`guest:${vehicleId}`)) return c.json({ error: 'too_many_requests' }, 429);
      issueLimit.record(`guest:${vehicleId}`);
      if (activeCount(db, vehicleId, now()) >= MAX_GUESTS) return c.json({ error: 'guest_limit' }, 409);
      const { code, expiresAt } = issueCode(db, 'guest', vehicleId, now());
      return c.json({ code, url: `${publicBase(deps, c)}/g/${code}`, expiresAt }, 200);
    })
    .post('/guest/claim', async (c) => {
      const w = who(c);
      if (w === 'invalid') return c.json({ error: 'unauthorized' }, 401);
      const raw = await readJson(c.req.raw);
      const parsed = claimBody.safeParse(raw);
      // consent가 false(동의 안 함)면 이유를 따로 알린다. 그 밖의 형식 오류는 invalid_body.
      if (!parsed.success) return c.json({ error: (raw as { consent?: unknown } | undefined)?.consent === false ? 'consent_required' : 'invalid_body' }, 400);
      const r = joinGuest(deps, guard, clientKey(c), parsed.data, w);
      return r.ok ? c.json({ sessionId: r.sessionId, token: r.token }, 200) : c.json({ error: r.error }, r.status);
    })
    .post('/guest/end-all', async (c) => {
      const p = await parseBody(c, vehicleBody);
      if (!p.ok) return p.res;
      const vehicleId = canonicalVehicleId(db, p.data.vehicleId);
      const w = who(c);
      if (w === 'invalid') return c.json({ error: 'unauthorized' }, 401);
      const authMode = (deps.options.auth ?? 'off') !== 'off';
      const ok = w ? isCarOf(db, w.info, vehicleId) : !authMode;
      if (!ok) return c.json({ error: w ? 'forbidden' : 'unauthorized' }, w ? 403 : 401);
      expireIdle(db, now(), vehicleId);
      const ids = db.prepare('SELECT id FROM guest_sessions WHERE vehicle_id = ? AND ended_at IS NULL').all(vehicleId) as { id: string }[];
      for (const s of ids) endSession(db, s.id, now(), 'owner');
      return c.json({ ok: true as const, ended: ids.length }, 200);
    })
    .get('/guest/sessions', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' }, 400);
      // 차주는 인원만 본다(plan 9-3). 게스트의 이름·기록은 내보내지 않는다.
      return c.json({ active: activeCount(db, vehicleId, now()) }, 200);
    })
    .post('/guest/:id/end', async (c) => {
      const session = db.prepare('SELECT id, vehicle_id, account_id, ended_at FROM guest_sessions WHERE id = ? AND deleted_at IS NULL').get(c.req.param('id')) as
        | { id: string; vehicle_id: string; account_id: string; ended_at: string | null }
        | undefined;
      const w = who(c);
      if (w === 'invalid') return c.json({ error: 'unauthorized' }, 401);
      if (!session) return c.json({ error: 'not_found' }, 404);
      const raw = (await readJson(c.req.raw)) as { vehicleId?: unknown } | undefined;
      const bodyVehicle = typeof raw?.vehicleId === 'string' ? raw.vehicleId : null;
      const authMode = (deps.options.auth ?? 'off') !== 'off';
      if (!canEnd(db, w ? w.info : null, session, bodyVehicle, authMode)) return c.json({ error: w || bodyVehicle ? 'forbidden' : 'unauthorized' }, w || bodyVehicle ? 403 : 401);
      expireIdle(db, now(), session.vehicle_id);
      const fresh = db.prepare('SELECT ended_at FROM guest_sessions WHERE id = ?').get(session.id) as { ended_at: string | null };
      if (fresh.ended_at) return c.json({ ok: true as const, endedAt: fresh.ended_at, alreadyEnded: true as const }, 200);
      const endedBy = w && w.info.kind === 'account' && w.info.accountId === session.account_id ? 'guest' : 'owner';
      endSession(db, session.id, now(), endedBy);
      return c.json({ ok: true as const, endedAt: iso(now()), alreadyEnded: false as const }, 200);
    })
    // 게스트는 세션 단위로 자기 기록을 지울 수 있다(plan 9-3). 열려 있으면 끝내고 그 세션의 도로 기록을 지운다.
    .delete('/guest/:id/data', (c) => {
      const w = who(c);
      if (!w || w === 'invalid') return c.json({ error: 'unauthorized' }, 401);
      const s = db.prepare('SELECT id, account_id FROM guest_sessions WHERE id = ? AND deleted_at IS NULL').get(c.req.param('id')) as { id: string; account_id: string } | undefined;
      if (!s) return c.json({ error: 'not_found' }, 404);
      if (w.info.kind !== 'account' || w.info.accountId !== s.account_id) return c.json({ error: 'forbidden' }, 403);
      db.exec('BEGIN');
      try {
        endSession(db, s.id, now(), 'deleted');
        db.prepare('DELETE FROM guest_ways WHERE session_id = ?').run(s.id);
        db.prepare('UPDATE guest_sessions SET deleted_at = ? WHERE id = ?').run(iso(now()), s.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return c.json({ ok: true as const }, 200);
    })
    // 내 기록 요약. 차주 토큰이면 내 차량, 게스트 토큰이면 내가 앉았던 세션의 기록만.
    .get('/me/summary', (c) => {
      const w = who(c);
      if (!w || w === 'invalid' || w.info.kind !== 'account') return c.json({ error: 'unauthorized' }, 401);
      const info = w.info;
      const mine = myLevels(info)!;
      const regions = deps.getRegions();
      const roads = deps.getRoads();
      const items = regions ? regionItems(db, regions, mine.levels) : null;
      const coverage = roads ? (mine.owner ? ownerCoverage(db, roads, canonicalVehicleId(db, info.vehicleId!)) : guestCoverage(db, roads, info.accountId)) : null;
      const active = mine.owner
        ? undefined
        : (() => {
            for (const s of db.prepare('SELECT vehicle_id FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL').all(info.accountId) as { vehicle_id: string }[]) expireIdle(db, now(), s.vehicle_id);
            return db.prepare('SELECT id FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL AND deleted_at IS NULL').get(info.accountId) as { id: string } | undefined;
          })();
      return c.json(
        {
          role: mine.owner ? ('owner' as const) : ('guest' as const),
          ...(mine.owner ? { vehicleId: info.vehicleId } : { activeSessionId: active?.id ?? null }),
          regions: items ? regionSummary(items) : null,
          coverage,
          snapshotMonth: roads?.month ?? null,
          attribution: ATTRIBUTION,
          regionsAttribution: REGIONS_ATTRIBUTION,
        },
        200,
      );
    })
    .get('/me/regions', (c) => {
      const w = who(c);
      if (!w || w === 'invalid' || w.info.kind !== 'account') return c.json({ error: 'unauthorized' }, 401);
      const regions = deps.getRegions();
      if (!regions) return c.json({ error: 'regions_db_unavailable' }, 503);
      const mine = myLevels(w.info)!;
      return c.json({ items: regionItems(db, regions, mine.levels), attribution: REGIONS_ATTRIBUTION }, 200);
    });
};
