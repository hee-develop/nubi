import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authenticate, checkCode, clientKey, CODE_RE, codeGuardOf, issueCode, issueToken, publicBase, RateLimiter, revokeTokens } from '../ext/auth.js';
import { iso, parseBody, type ExtDeps } from '../ext/util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';

const id = z.string().min(1).max(128);
const gear = z.enum(['P', 'R', 'N', 'D']);
const codeBody = z.object({ vehicleId: id, gear });
const claimBody = z.object({ code: z.string().regex(CODE_RE), consent: z.boolean().optional() });

/** 차주 연결 pair 로직(웹 페이지 `/p/:code`도 같이 쓴다). 성공하면 계정·토큰을 만든다. */
export const claimPair = (deps: ExtDeps, vehicleId: string, nowMs: number, consentAt: string | null, opts: { apiToken?: boolean } = {}) => {
  const { db } = deps;
  const accountId = randomUUID();
  db.exec('BEGIN');
  try {
    const taken = db.prepare("SELECT 1 AS x FROM accounts WHERE kind = 'owner' AND vehicle_id = ?").get(vehicleId);
    if (taken) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare("INSERT INTO accounts (id, kind, vehicle_id, created_at, consent_at) VALUES (?, 'owner', ?, ?, ?)").run(accountId, vehicleId, iso(nowMs), consentAt);
    const token = opts.apiToken === false ? null : issueToken(db, 'account', accountId, nowMs);
    db.exec('COMMIT');
    return { accountId, token, vehicleId };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

/** 차주 연결 해제: 계정과 토큰, 안 쓴 코드를 지우고 그 계정이 연 게스트 세션을 끝낸다. */
export const unpair = (deps: ExtDeps, vehicleId: string, nowMs: number): boolean => {
  const { db } = deps;
  const acc = db.prepare("SELECT id FROM accounts WHERE kind = 'owner' AND vehicle_id = ?").get(vehicleId) as { id: string } | undefined;
  if (!acc) return false;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE guest_sessions SET ended_at = ?, end_reason = 'unpaired' WHERE account_id = ? AND ended_at IS NULL").run(iso(nowMs), acc.id);
    revokeTokens(db, 'account', acc.id, nowMs);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
    db.prepare("DELETE FROM link_codes WHERE kind = 'pair' AND vehicle_id = ?").run(vehicleId);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

/** 차주 연결(plan 9-1): 차가 P에서 6자리 코드(5분)를 내고, 폰이 코드로 계정을 만들어 연결한다. 차 1대에 차주 1명. */
export const pairRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const guard = codeGuardOf(deps);
  const issueLimit = new RateLimiter(deps.options.rateLimit?.max ? deps.options.rateLimit.max * 3 : 30, deps.options.rateLimit?.windowMs ?? 5 * 60_000, now);
  return new Hono()
    .use('/pair/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }))
    .post('/pair/code', async (c) => {
      const p = await parseBody(c, codeBody);
      if (!p.ok) return p.res;
      // 주행 중 QR·코드 금지(plan 9-3): 차가 보낸 기어가 P일 때만 낸다.
      if (p.data.gear !== 'P') return c.json({ error: 'not_parked' }, 403);
      const vehicleId = canonicalVehicleId(db, p.data.vehicleId);
      if (issueLimit.blocked(`pair:${vehicleId}`)) return c.json({ error: 'too_many_requests' }, 429);
      issueLimit.record(`pair:${vehicleId}`);
      if (db.prepare("SELECT 1 AS x FROM accounts WHERE kind = 'owner' AND vehicle_id = ?").get(vehicleId)) return c.json({ error: 'already_paired' }, 409);
      const { code, expiresAt } = issueCode(db, 'pair', vehicleId, now());
      return c.json({ code, url: `${publicBase(deps, c)}/p/${code}`, expiresAt }, 200);
    })
    .post('/pair/claim', async (c) => {
      const key = clientKey(c);
      if (guard.blocked(key)) return c.json({ error: 'too_many_requests' }, 429);
      const p = await parseBody(c, claimBody);
      if (!p.ok) return p.res;
      // 위치정보 이용 동의는 폰이 받아 consent: true로 보낸다. 없거나 false면 연결하지 않는다(동의 시각을 기록한다).
      if (p.data.consent !== true) return c.json({ error: 'consent_required' }, 400);
      const state = checkCode(db, 'pair', p.data.code, now());
      if (!state.ok) {
        guard.fail(key);
        await guard.delayIfNeeded();
        return c.json({ error: state.error }, state.status);
      }
      const made = claimPair(deps, state.vehicleId, now(), iso(now()));
      if (!made) return c.json({ error: 'already_paired' }, 409);
      db.prepare('UPDATE link_codes SET used_at = ? WHERE code = ?').run(iso(now()), p.data.code);
      return c.json({ ...made, token: made.token as string /* API 경로는 apiToken을 끄지 않아 항상 문자열 */ }, 200);
    })
    .get('/pair', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' }, 400);
      const row = db.prepare("SELECT created_at FROM accounts WHERE kind = 'owner' AND vehicle_id = ?").get(canonicalVehicleId(db, vehicleId)) as { created_at: string } | undefined;
      return c.json(row ? { paired: true as const, pairedAt: row.created_at } : { paired: false as const }, 200);
    })
    .delete('/pair', (c) => {
      // 폰(차주 계정 토큰)과 차(차량 토큰) 모두 해제할 수 있다. 토큰이 없으면 401.
      const info = authenticate(deps, c);
      if (!info) return c.json({ error: 'unauthorized' }, 401);
      const vehicleId = info.kind === 'vehicle' ? canonicalVehicleId(db, info.vehicleId) : info.role === 'owner' ? info.vehicleId : null;
      if (!vehicleId) return c.json({ error: 'forbidden' }, 403);
      if (!unpair(deps, vehicleId, now())) return c.json({ error: 'not_paired' }, 404);
      return c.json({ ok: true as const, vehicleId }, 200);
    });
};
