import type { Context } from 'hono';
import { COLORS, esc } from './render.js';

export { esc };

/** 서버 렌더 모바일 페이지 공통 스타일(브랜드 00: 배경 #0f141b, 앰버 #f59e0b). 외부 스크립트·글꼴 없음. */
export const BASE_CSS = `
:root{color-scheme:dark;--bg:${COLORS.bg};--panel:${COLORS.panel};--line:${COLORS.line};--text:${COLORS.text};--muted:${COLORS.muted};--amber:${COLORS.driven};--fresh:${COLORS.fresh}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 ${`'Apple SD Gothic Neo','Noto Sans KR','Noto Sans CJK KR','Malgun Gothic',system-ui,sans-serif`}}
main{max-width:520px;margin:0 auto;padding:20px 16px 40px}
.logo{font-weight:800;font-size:28px;color:var(--amber);letter-spacing:-.02em}
h1{font-size:24px;line-height:1.3;margin:18px 0 8px}
h2{font-size:18px;margin:26px 0 8px}
p{margin:8px 0}
.muted{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;margin:14px 0}
.btn{display:block;width:100%;min-height:52px;border:0;border-radius:14px;background:var(--amber);color:#1a1205;font:700 17px inherit;font-family:inherit;text-align:center;padding:14px;margin-top:14px;cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.btn[disabled]{opacity:.5}
label.check{display:flex;gap:12px;align-items:flex-start;padding:12px 0;cursor:pointer}
input[type=checkbox]{width:26px;height:26px;flex:none;accent-color:var(--amber);margin-top:2px}
input[type=text]{width:100%;min-height:48px;border-radius:12px;border:1px solid var(--line);background:#0f141b;color:var(--text);padding:10px 14px;font:inherit}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px}
.stat b{display:block;font-size:26px;color:var(--amber);line-height:1.2}
.stat span{color:var(--muted);font-size:13px}
.err{border-color:#7a2d2d;background:#241416}
.foot{margin-top:28px;font-size:12px;color:var(--muted)}
a{color:var(--amber)}
`;

type PageOpts = { title: string; body: string; description?: string; ogImage?: string; head?: string };

/** 완성된 HTML 문서. 제목·설명은 이스케이프한다. */
export const page = (o: PageOpts): string => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${COLORS.bg}"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>${esc(o.title)}</title>${o.description ? `<meta name="description" content="${esc(o.description)}"><meta property="og:description" content="${esc(o.description)}">` : ''}
<meta property="og:title" content="${esc(o.title)}">${o.ogImage ? `<meta property="og:image" content="${esc(o.ogImage)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<style>${BASE_CSS}</style>${o.head ?? ''}</head><body><main>${o.body}</main></body></html>`;

/**
 * HTML 응답. 토큰·코드가 URL에 있는 페이지라 캐시·Referer 유출을 막는다(no-store, no-referrer).
 * CSP: 스크립트는 허용하지 않는다(폼 POST로만 동작). 이미지는 같은 출처와 data: 만.
 */
export const htmlResponse = (c: Context, html: string, status: 200 | 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503 = 200) =>
  c.html(html, status, {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
