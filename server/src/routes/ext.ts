import { Hono } from 'hono';
import { ensureExtSchema } from '../db/schema-ext.js';
import type { ExtDeps } from '../ext/util.js';
import { authMiddleware } from '../ext/auth.js';
import { b2bRoutes } from './b2b.js';
import { accountRoutes } from './account.js';
import { guestRoutes } from './guest.js';
import { introRoutes } from './intro.js';
import { pairRoutes } from './pair.js';
import { reportsRoutes } from './reports.js';
import { shareRoutes } from './share.js';

export type { ExtOptions } from '../ext/util.js';

/**
 * 05 야간 계약서 T2 라우트를 한 번에 잇는다. app.ts에는 이 한 줄만 둔다(T1 등과 충돌을 줄이려는 것).
 * 이 라우트는 체인의 앞쪽에 둬야 토큰 인증 미들웨어가 뒤의 라우트(T1 `/map` 등)까지 덮는다.
 */
export const extRoutes = (deps: ExtDeps) => {
  ensureExtSchema(deps.db);
  return new Hono().use('*', authMiddleware(deps)).route('/', guestRoutes(deps)).route('/', pairRoutes(deps)).route('/', accountRoutes(deps)).route('/', reportsRoutes(deps)).route('/', shareRoutes(deps)).route('/', introRoutes(deps)).route('/', b2bRoutes(deps));
};
