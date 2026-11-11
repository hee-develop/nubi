import { Hono } from 'hono';
import { ensureExtSchema } from '../db/schema-ext.js';
import { authMiddleware } from '../ext/auth.js';
import type { ExtDeps } from '../ext/util.js';
import { accountRoutes } from './account.js';
import { b2bRoutes } from './b2b.js';
import { guestRoutes } from './guest.js';
import { introRoutes } from './intro.js';
import { pagesRoutes } from './pages.js';
import { pairRoutes } from './pair.js';
import { reportsRoutes } from './reports.js';
import { shareRoutes } from './share.js';

export type { ExtOptions } from '../ext/util.js';

/**
 * 05 야간 계약서 T2 라우트와 전역 미들웨어(본문 크기·토큰 인증)를 만든다. app.ts에서는
 *   `new Hono().use('*', ext.middleware)` 를 **체인 맨 앞**에 두고 `.route('/', ext.routes)` 를 아무 데나 붙이면 된다.
 * 미들웨어가 앞에 있으면 뒤에 붙는 모든 라우트(T1 `/map`·`/trips/:id/live` 포함)에 같은 인증·본문 한도가 적용된다.
 */
export const createExt = (deps: ExtDeps) => {
  ensureExtSchema(deps.db); // openDb가 이미 만들지만, 다른 경로로 연 DB도 안전하게(멱등)
  return {
    middleware: authMiddleware(deps),
    routes: new Hono()
      .route('/', guestRoutes(deps))
      .route('/', pairRoutes(deps))
      .route('/', accountRoutes(deps))
      .route('/', reportsRoutes(deps))
      .route('/', shareRoutes(deps))
      .route('/', introRoutes(deps))
      .route('/', b2bRoutes(deps))
      .route('/', pagesRoutes(deps)),
  };
};
