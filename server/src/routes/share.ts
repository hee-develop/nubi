import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { nationalCard, roadCard, tripCard, type CardMeta } from '../ext/cards.js';
import { publicBase, RateLimiter } from '../ext/auth.js';
import { svgToPng } from '../ext/render.js';
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
const FILE_RE = /^([A-Za-z0-9_-]{8,40})\.png$/;

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
      // PNG는 만들 때 한 번만 렌더해 저장한다(GET은 저장본). 변환기가 없으면 SVG로 내보내지 않고 503이다(공개 경로는 PNG만).
      const png = await (deps.options.pngRenderer ?? ((svg: string) => svgToPng(svg, deps.options.fontFile)))(r.svg);
      if (!png) return c.json({ error: 'png_unavailable' }, 503);
      const cardId = randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO share_cards (id, vehicle_id, kind, svg, png, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        cardId,
        vehicleId,
        p.data.kind,
        r.svg,
        png,
        JSON.stringify(r.meta satisfies CardMeta),
        iso(now()),
      );
      db.prepare(
        `DELETE FROM share_cards WHERE vehicle_id = ? AND id NOT IN (SELECT id FROM share_cards WHERE vehicle_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      ).run(vehicleId, vehicleId, MAX_CARDS_PER_VEHICLE);
      const base = publicBase(deps, c);
      return c.json({ id: cardId, url: `${base}/s/${cardId}`, imageUrl: `${base}/share/cards/${cardId}.png` }, 200);
    })
    .get('/share/cards/:file', (c) => {
      const m = FILE_RE.exec(c.req.param('file'));
      if (!m) return c.json({ error: 'not_found' }, 404);
      const row = db.prepare('SELECT png FROM share_cards WHERE id = ?').get(m[1]) as { png: Uint8Array | null } | undefined;
      if (!row?.png) return c.json({ error: 'not_found' }, 404);
      return c.body(new Uint8Array(row.png), 200, {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `inline; filename="nubi-${m[1]}.png"`,
      });
    })
    .delete('/share/cards/:id', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' }, 400);
      const r = db.prepare('DELETE FROM share_cards WHERE id = ? AND vehicle_id = ?').run(c.req.param('id'), canonicalVehicleId(db, vehicleId));
      return Number(r.changes) > 0 ? c.json({ ok: true as const }, 200) : c.json({ error: 'not_found' }, 404);
    });
};
