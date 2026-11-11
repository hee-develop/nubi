import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientKey, checkCode, codeGuardOf, CODE_RE, lookupToken, type TokenInfo } from '../ext/auth.js';
import { esc, htmlResponse, page } from '../ext/html.js';
import { monthLabel, nationalMapInner } from '../ext/cards.js';
import { miniMapSvg, pngAvailable } from '../ext/render.js';
import { endSession, expireIdle } from '../ext/sessions.js';
import { guestCoverage, guestRegionLevels, guestWays, ownerCoverage, ownerRegionLevels, ownerWays, regionItems, regionSummary, type RegionLevels } from '../ext/stats.js';
import { iso, type ExtDeps } from '../ext/util.js';
import { canonicalVehicleId } from '../matching/pipeline.js';
import { claimPair } from './pair.js';
import { joinGuest } from './guest.js';

const LOGO = '<div class="logo">누비</div>';
const notice = (title: string, msg: string, extra = '') => page({ title, body: `${LOGO}<h1>${esc(title)}</h1><div class="card err"><p>${esc(msg)}</p></div>${extra}<p class="foot">누비</p>` });

const codeErrorPage = (error: string): { html: string; status: 404 | 410 | 429 } => {
  if (error === 'code_expired') return { status: 410, html: notice('코드가 만료됐어요', '코드는 5분 동안만 쓸 수 있어요. 차량 화면에서 새 QR을 띄워 다시 시도해 주세요.') };
  if (error === 'code_used') return { status: 410, html: notice('이미 쓴 코드예요', '이 QR은 한 번만 쓸 수 있어요. 차량 화면에서 새 QR을 띄워 주세요.') };
  if (error === 'too_many_requests') return { status: 429, html: notice('잠시 후 다시 해 주세요', '시도가 너무 많았어요. 몇 분 뒤에 다시 시도해 주세요.') };
  return { status: 404, html: notice('코드를 찾을 수 없어요', 'QR 링크가 올바르지 않아요. 차량 화면의 QR을 다시 스캔해 주세요.') };
};

type Level = { n: number; label: string };

/** 시군구 단계별 개수 한 줄(통과·방문·숙박). */
const levelLine = (s: ReturnType<typeof regionSummary>) => `통과 ${s.byLevel['1']} · 방문 ${s.byLevel['2']} · 숙박 ${s.byLevel['3']}`;

/** 서버 렌더 모바일 웹 페이지(폰 앱 없이 QR만으로 동작): `/g/:code` 게스트 참여, `/p/:code` 차주 연결, `/me` 내 기록, `/s/:id` 공유 카드. 스크립트는 쓰지 않는다(폼 POST). */
export const pagesRoutes = (deps: ExtDeps) => {
  const { db, now } = deps;
  const guard = codeGuardOf(deps);
  const home = (t: string) => `/me?t=${encodeURIComponent(t)}`;

  /** 코드 페이지 공통: 코드 상태를 보고 오류면 안내 페이지를 돌려준다. 실패는 시도 제한에 센다. */
  const checkPageCode = (c: Context, kind: 'pair' | 'guest', code: string): { html: string; status: 404 | 410 | 429 } | { vehicleId: string } => {
    const who = clientKey(c);
    if (guard.blocked(who)) return codeErrorPage('too_many_requests');
    const st = CODE_RE.test(code) ? checkCode(db, kind, code, now()) : ({ ok: false, status: 404, error: 'code_not_found' } as const);
    if (!st.ok) {
      guard.fail(who);
      return codeErrorPage(st.error);
    }
    return { vehicleId: st.vehicleId };
  };

  const consentForm = (action: string, title: string, lead: string, consentText: string, button: string, nickname: boolean) =>
    page({
      title,
      description: lead,
      body: `${LOGO}<h1>${esc(title)}</h1><p class="muted">${esc(lead)}</p>
<form method="post" action="${esc(action)}" class="card">
<label class="check"><input type="checkbox" name="consent" value="yes" required><span>${esc(consentText)}</span></label>
${nickname ? '<label class="muted" for="nick">별명(선택)</label><input id="nick" type="text" name="nickname" maxlength="20" autocomplete="off">' : ''}
<button class="btn" type="submit">${esc(button)}</button>
</form>
<p class="foot">동의하기 전에는 아무 기록도 시작되지 않아요. 기록은 언제든 지울 수 있어요.</p>`,
    });

  const form = async (c: Context): Promise<{ consent: boolean; nickname?: string }> => {
    const f = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
    const nick = typeof f['nickname'] === 'string' ? f['nickname'].trim().slice(0, 20) : '';
    return { consent: f['consent'] === 'yes', ...(nick ? { nickname: nick } : {}) };
  };

  return new Hono()
    .use('/g/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => htmlResponse(c, notice('요청이 너무 커요', '다시 시도해 주세요.'), 400) }))
    .use('/p/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => htmlResponse(c, notice('요청이 너무 커요', '다시 시도해 주세요.'), 400) }))
    .use('/me/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => htmlResponse(c, notice('요청이 너무 커요', '다시 시도해 주세요.'), 400) }))
    // ---- 게스트: 동의 체크 → 참여 → 내 기록 링크 ----
    .get('/g/:code', (c) => {
      const r = checkPageCode(c, 'guest', c.req.param('code'));
      if ('html' in r) return htmlResponse(c, r.html, r.status);
      return htmlResponse(
        c,
        consentForm(
          `/g/${c.req.param('code')}/join`,
          '이 차에 같이 탔어요',
          '이 차가 달리는 길과 지나간 시군구를 내 누비 지도에 채워 드려요. 앱 설치 없이 이 화면에서 바로 시작해요.',
          '이 차량이 달리는 동안의 위치 기록(지나간 도로·시군구)을 내 기록으로 받는 것에 동의합니다. 내 폰의 위치는 쓰지 않습니다.',
          '같이 타기 시작',
          true,
        ),
      );
    })
    .post('/g/:code/join', async (c) => {
      const code = c.req.param('code');
      if (!CODE_RE.test(code)) return htmlResponse(c, codeErrorPage('code_not_found').html, 404);
      const f = await form(c);
      const r = joinGuest(deps, guard, clientKey(c), { code, consent: f.consent, ...(f.nickname ? { nickname: f.nickname } : {}) }, null);
      if (r.ok) return c.redirect(home(r.token), 303);
      if (r.error === 'consent_required')
        return htmlResponse(c, notice('동의가 필요해요', '위치 기록을 내 기록으로 받으려면 동의 항목을 체크해 주세요. 동의 전에는 아무것도 시작되지 않아요.', `<a class="btn ghost" href="/g/${esc(code)}">돌아가기</a>`), 400);
      if (r.error === 'guest_limit') return htmlResponse(c, notice('자리가 다 찼어요', '이 차에는 한 번에 4명까지 같이 탈 수 있어요. 차주에게 문의해 주세요.'), 409);
      const e = codeErrorPage(r.error);
      return htmlResponse(c, e.html, e.status);
    })
    // ---- 차주 연결 ----
    .get('/p/:code', (c) => {
      const r = checkPageCode(c, 'pair', c.req.param('code'));
      if ('html' in r) return htmlResponse(c, r.html, r.status);
      return htmlResponse(
        c,
        consentForm(
          `/p/${c.req.param('code')}/join`,
          '내 차를 누비에 연결',
          '차가 달린 길을 내 누비 지도에 색칠해서 보여 드려요.',
          '이 차량의 위치 기록(달린 도로·지나간 시군구)을 수집하고 내 기록으로 쓰는 것에 동의합니다. 설정에서 언제든 멈추거나 지울 수 있습니다.',
          '내 차 연결하기',
          false,
        ),
      );
    })
    .post('/p/:code/join', async (c) => {
      const code = c.req.param('code');
      if (!CODE_RE.test(code)) return htmlResponse(c, codeErrorPage('code_not_found').html, 404);
      const f = await form(c);
      if (!f.consent)
        return htmlResponse(c, notice('동의가 필요해요', '위치 기록을 쓰려면 동의 항목을 체크해 주세요.', `<a class="btn ghost" href="/p/${esc(code)}">돌아가기</a>`), 400);
      const who = clientKey(c);
      if (guard.blocked(who)) return htmlResponse(c, codeErrorPage('too_many_requests').html, 429);
      const st = checkCode(db, 'pair', code, now());
      if (!st.ok) {
        guard.fail(who);
        const e = codeErrorPage(st.error);
        return htmlResponse(c, e.html, e.status);
      }
      const made = claimPair(deps, st.vehicleId, now(), iso(now()));
      if (!made) return htmlResponse(c, notice('이미 연결된 차예요', '이 차는 다른 계정에 연결되어 있어요. 연결을 해제한 뒤 다시 시도해 주세요.'), 409);
      db.prepare('UPDATE link_codes SET used_at = ? WHERE code = ?').run(iso(now()), code);
      return c.redirect(home(made.token), 303);
    })
    // ---- 내 기록(토큰) ----
    .get('/me', (c) => {
      const t = c.req.query('t') ?? '';
      const info = /^[A-Za-z0-9_-]{16,256}$/.test(t) ? lookupToken(db, t) : null;
      if (!info || info.kind !== 'account') return htmlResponse(c, notice('링크가 올바르지 않아요', '내 기록 링크가 만료됐거나 올바르지 않아요. QR을 다시 스캔해 주세요.'), 401);
      return htmlResponse(c, mePage(info, t));
    })
    .post('/me/leave', async (c) => {
      const info = tokenFromForm(await c.req.parseBody().catch(() => ({})));
      if (!info) return htmlResponse(c, notice('링크가 올바르지 않아요', '다시 시도해 주세요.'), 401);
      if (info.info.role === 'guest') {
        for (const s of db.prepare('SELECT id FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL').all(info.info.accountId) as { id: string }[]) endSession(db, s.id, now(), 'guest');
      }
      return c.redirect(home(info.token), 303);
    })
    .post('/me/delete-session', async (c) => {
      const info = tokenFromForm(await c.req.parseBody().catch(() => ({})));
      if (!info) return htmlResponse(c, notice('링크가 올바르지 않아요', '다시 시도해 주세요.'), 401);
      if (info.info.role === 'guest') {
        db.exec('BEGIN');
        try {
          for (const s of db.prepare('SELECT id FROM guest_sessions WHERE account_id = ? AND deleted_at IS NULL').all(info.info.accountId) as { id: string }[]) {
            endSession(db, s.id, now(), 'deleted');
            db.prepare('DELETE FROM guest_ways WHERE session_id = ?').run(s.id);
            db.prepare('UPDATE guest_sessions SET deleted_at = ? WHERE id = ?').run(iso(now()), s.id);
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      return c.redirect(home(info.token), 303);
    })
    // ---- 공유 카드 ----
    .get('/s/:id', async (c) => {
      const row = /^[A-Za-z0-9_-]{8,40}$/.test(c.req.param('id'))
        ? (db.prepare('SELECT meta_json FROM share_cards WHERE id = ?').get(c.req.param('id')) as { meta_json: string } | undefined)
        : undefined;
      if (!row) return htmlResponse(c, notice('공유 카드를 찾을 수 없어요', '삭제됐거나 주소가 올바르지 않아요.'), 404);
      const meta = JSON.parse(row.meta_json) as { label: string; lines: string[]; aria: string };
      const ext = (await pngAvailable()) ? 'png' : 'svg';
      const img = `/share/cards/${c.req.param('id')}.${ext}`;
      const base = (deps.options.publicUrl ?? process.env.NUBI_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
      const install = deps.options.installUrl ?? process.env.NUBI_INSTALL_URL;
      const body = `${LOGO}<p class="muted">${esc(meta.label)}</p>
<img src="${esc(img)}" alt="${esc(meta.aria)}" style="width:100%;height:auto;border-radius:20px;display:block;margin:12px 0" width="800" height="960">
<h1 style="font-size:20px">${esc(meta.lines.join(' · '))}</h1>
${install ? `<a class="btn" href="${esc(install)}">누비 설치하기</a>` : ''}
<p class="foot">출발·도착 지점과 날짜를 지운 이미지예요. © OpenStreetMap contributors</p>`;
      return htmlResponse(c, page({ title: `누비 · ${meta.lines[0] ?? '공유 카드'}`, description: meta.lines.join(' · '), ogImage: `${base}${img}`, body }), 200, 'public, max-age=300');
    });

  function tokenFromForm(f: Record<string, string | File | (string | File)[]>): { info: Extract<TokenInfo, { kind: 'account' }>; token: string } | null {
    const t = typeof f['t'] === 'string' ? f['t'] : '';
    const info = /^[A-Za-z0-9_-]{16,256}$/.test(t) ? lookupToken(db, t) : null;
    return info && info.kind === 'account' ? { info, token: t } : null;
  }

  function mePage(info: Extract<TokenInfo, { kind: 'account' }>, token: string): string {
    const regions = deps.getRegions();
    const roads = deps.getRoads();
    const owner = info.role === 'owner' && info.vehicleId !== null;
    let levels: RegionLevels;
    let active = false;
    let sessionCount = 0;
    if (owner) levels = ownerRegionLevels(db, canonicalVehicleId(db, info.vehicleId!));
    else {
      for (const s of db.prepare('SELECT vehicle_id FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL').all(info.accountId) as { vehicle_id: string }[]) expireIdle(db, now(), s.vehicle_id);
      active = !!db.prepare('SELECT 1 AS x FROM guest_sessions WHERE account_id = ? AND ended_at IS NULL AND deleted_at IS NULL').get(info.accountId);
      sessionCount = (db.prepare('SELECT COUNT(*) AS n FROM guest_sessions WHERE account_id = ? AND deleted_at IS NULL').get(info.accountId) as { n: number }).n;
      levels = guestRegionLevels(db, regions, info.accountId);
    }
    const items = regions ? regionItems(db, regions, levels) : null;
    const sum = items ? regionSummary(items) : null;
    const cov = roads ? (owner ? ownerCoverage(db, roads, canonicalVehicleId(db, info.vehicleId!)) : guestCoverage(db, roads, info.accountId)) : null;
    const stats: Level[] = [
      ...(sum ? [{ n: sum.colored, label: `시군구 / ${sum.total}` }, { n: sum.depop.colored, label: `인구감소지역 / ${sum.depop.total}` }] : []),
      ...(cov ? [{ n: cov.nationalPercent, label: '전국 완료율 %' }, { n: cov.drivenKm, label: '달린 도로 km' }] : []),
    ];
    const map = roads || regions ? miniMapSvg(nationalMapInner(deps, levels, roads ? (owner ? ownerWays(db, canonicalVehicleId(db, info.vehicleId!)) : guestWays(db, info.accountId)) : []), '전국 지도에 색칠한 내 도로와 시군구') : '';
    const recent = (items ?? [])
      .filter((i) => i.level > 0 && i.lastAt)
      .sort((a, b) => (b.lastAt! > a.lastAt! ? 1 : -1))
      .slice(0, 5);
    const lvName = ['', '통과', '방문', '숙박'];
    const guestPanel = owner
      ? ''
      : `<div class="card"><p><b>${active ? '지금 같이 타고 있어요' : '내린 상태예요'}</b></p>
<p class="muted">같이 탄 기록 ${sessionCount}번${active ? ' · 이 차가 달리는 동안의 길이 자동으로 채워져요' : ''}</p>
${active ? `<form method="post" action="/me/leave"><input type="hidden" name="t" value="${esc(token)}"><button class="btn ghost" type="submit">내리기</button></form>` : ''}
<form method="post" action="/me/delete-session"><input type="hidden" name="t" value="${esc(token)}"><button class="btn ghost" type="submit">같이 탄 기록 모두 지우기</button></form></div>`;
    return page({
      title: '내 누비 지도',
      description: '내 누비 지도 요약',
      body: `${LOGO}<h1>${owner ? '내 차의 누비 지도' : '같이 탄 길의 누비 지도'}</h1>
${map ? `<div class="card" style="padding:8px">${map}</div>` : ''}
${stats.length ? `<div class="stats">${stats.map((s) => `<div class="stat"><b>${esc(String(s.n))}</b><span>${esc(s.label)}</span></div>`).join('')}</div>` : '<div class="card err"><p>지도 데이터를 아직 쓸 수 없어요.</p></div>'}
${sum ? `<p class="muted">${esc(levelLine(sum))}</p>` : ''}
${recent.length ? `<h2>최근 칠한 곳</h2><div class="card">${recent.map((r) => `<p style="margin:4px 0"><b>${esc(r.displayName)}</b> <span class="muted">${lvName[r.level]} · ${esc(monthLabel(r.lastAt!))}</span></p>`).join('')}</div>` : ''}
${guestPanel}
<p class="foot">지도 © OpenStreetMap contributors (ODbL) · 행정구역 경계: 통계청 SGIS, vuski/admdongkor (CC BY 4.0)</p>`,
    });
  }
};
