import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { nationalCard, roadCard, tripCard, type CardMeta } from '../ext/cards.js';
import { publicBase, RateLimiter } from '../ext/auth.js';
import { pngAvailable, svgToPng } from '../ext/render.js';
import { iso, parseBody, type ExtDeps } from '../ext/util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';

const id = z.string().min(1).max(128);
const body = z.discriminatedUnion('kind', [
  z.object({ vehicleId: id, kind: z.literal('national') }),
  z.object({ vehicleId: id, kind: z.literal('trip'), tripIds: z.array(z.string().min(1).max(128)).min(1).max(20) }),
  z.object({ vehicleId: id, kind: z.literal('road'), roadKey: z.string().min(1).max(200) }),
]);

/** 차량당 보관하는 카드 수(넘으면 오래된 것부터 지운다). */
const MAX_CARDS_PER_VEHICLE = 100;
const FILE_RE = /^([A-Za-z0-9_-]{8,40})\.(png|svg)$/;

/** 공유 카드(plan 10-1): 이미지(PNG, 변환기가 없으면 SVG)로만 내보낸다. 좌표 원본·way id·차량 ID는 이미지와 응답에 없다. */
export const shareRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const limiter = new RateLimiter(deps.options.rateLimit?.max ?? 30, deps.options.rateLimit?.windowMs ?? 5 * 60_000, now);
  return new Hono()
    .use('/share/*', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }))
    .post('/share/cards', async (c) => {
      const p = await parseBody(c, body);
      if (!p.ok) return p.res;
      const vehicleId = canonicalVehicleId(db, p.data.vehicleId);
      if (limiter.blocked(vehicleId)) return c.json({ error: 'too_many_requests' }, 429);
      limiter.record(vehicleId);
      const r = p.data.kind === 'national' ? nationalCard(deps, vehicleId) : p.data.kind === 'trip' ? tripCard(deps, vehicleId, p.data.tripIds) : roadCard(deps, vehicleId, p.data.roadKey);
      if (!r.ok) return c.json({ error: r.error }, r.status);
      const cardId = randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO share_cards (id, vehicle_id, kind, svg, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(cardId, vehicleId, p.data.kind, r.svg, JSON.stringify(r.meta satisfies CardMeta), iso(now()));
      db.prepare(
        `DELETE FROM share_cards WHERE vehicle_id = ? AND id NOT IN (SELECT id FROM share_cards WHERE vehicle_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      ).run(vehicleId, vehicleId, MAX_CARDS_PER_VEHICLE);
      const base = publicBase(deps, c);
      const ext = (await pngAvailable()) ? 'png' : 'svg';
      return c.json({ id: cardId, url: `${base}/s/${cardId}`, imageUrl: `${base}/share/cards/${cardId}.${ext}` }, 200);
    })
    .get('/share/cards/:file', async (c) => {
      const m = FILE_RE.exec(c.req.param('file'));
      if (!m) return c.json({ error: 'not_found' }, 404);
      const row = db.prepare('SELECT svg FROM share_cards WHERE id = ?').get(m[1]) as { svg: string } | undefined;
      if (!row) return c.json({ error: 'not_found' }, 404);
      const headers = { 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="nubi-${m[1]}.${m[2]}"` };
      if (m[2] === 'svg') return c.body(row.svg, 200, { ...headers, 'content-type': 'image/svg+xml; charset=utf-8' });
      const png = await svgToPng(row.svg, deps.options.fontFile);
      if (!png) return c.json({ error: 'png_unavailable' }, 503);
      return c.body(new Uint8Array(png), 200, { ...headers, 'content-type': 'image/png' });
    })
    .delete('/share/cards/:id', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' }, 400);
      const r = db.prepare('DELETE FROM share_cards WHERE id = ? AND vehicle_id = ?').run(c.req.param('id'), canonicalVehicleId(db, vehicleId));
      return Number(r.changes) > 0 ? c.json({ ok: true as const }, 200) : c.json({ error: 'not_found' }, 404);
    });
};
