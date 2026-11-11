import { hc } from 'hono/client';
import type { AppType } from '@nubi/server';
import { makeApiFetch, qs, type FetchLike } from './http';
import type { NubiApi } from './types';

type Json = Record<string, unknown>;

/** 차주 토큰 공급자. 연결 전이면 null. */
export type TokenProvider = () => string | null;

/** 헤더에 Authorization이 없으면 차주 토큰을 붙인다. 명시한 토큰(게스트 등)은 덮어쓰지 않는다. */
const withOwnerToken =
  (f: FetchLike, getToken: TokenProvider): FetchLike =>
  (input, init) => {
    const t = getToken();
    const h = new Headers(init?.headers);
    if (t && !h.has('Authorization')) h.set('Authorization', `Bearer ${t}`);
    return f(input, { ...init, headers: h });
  };

/**
 * 실서버 구현. 기존 API는 Hono RPC 클라이언트, 새 API(T2)는 05b 경로로 fetch한다.
 * 차량 API(RPC 포함)에는 차주 토큰을 Bearer로 붙인다(`NUBI_AUTH=optional|required`). claim은 토큰 없이 보낸다.
 */
export const createLiveApi = (baseUrl: string, mode: 'hybrid' | 'live', baseFetch?: FetchLike, getToken: TokenProvider = () => null): NubiApi => {
  const plainFetch = makeApiFetch(baseFetch);
  const apiFetch = withOwnerToken(plainFetch, getToken);
  const rpc = hc<AppType>(baseUrl, { fetch: apiFetch });
  const call = async <T>(path: string, init?: { method?: string; body?: Json; token?: string; anon?: boolean }): Promise<T> => {
    const res = await (init?.anon ? plainFetch : apiFetch)(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
  const json = async <T>(p: Promise<{ json(): Promise<unknown> }>) => (await (await p).json()) as T;

  return {
    mode,
    baseUrl,
    viewerUrl: (vehicleId) => `${baseUrl}/viewer${qs({ vehicleId })}`,
    coverageSummary: (vehicleId) => json(rpc.coverage.summary.$get({ query: { vehicleId } })),
    coverageRoads: (vehicleId, q = {}) => json(rpc.coverage.roads.$get({ query: { vehicleId, ...stringify(q) } })),
    regionsSummary: (vehicleId) => json(rpc.regions.summary.$get({ query: { vehicleId } })),
    regionsList: (vehicleId, q = {}) => json(rpc.regions.list.$get({ query: { vehicleId, ...stringify(q) } })),
    trips: (vehicleId, limit = 10) => json(rpc.trips.$get({ query: { vehicleId, limit: String(limit) } })),
    reportsDaily: (vehicleId, date) => call(`/reports/daily${qs({ vehicleId, date })}`),
    reportsMonthly: (vehicleId, month) => call(`/reports/monthly${qs({ vehicleId, month })}`),
    pairClaim: (code, consent) => call('/pair/claim', { method: 'POST', body: { code, consent }, anon: true }),
    pairDelete: async (token) => void (await call('/pair', { method: 'DELETE', token })),
    guestClaim: (input) => call('/guest/claim', { method: 'POST', body: input, anon: true }),
    guestEnd: (sessionId, token) => call(`/guest/${encodeURIComponent(sessionId)}/end`, { method: 'POST', token }),
    guestDeleteData: async (sessionId, token) => void (await call(`/guest/${encodeURIComponent(sessionId)}/data`, { method: 'DELETE', token })),
    guestSessions: (vehicleId) => call(`/guest/sessions${qs({ vehicleId })}`),
    meSummary: (token) => call('/me/summary', { token }),
    shareCreate: (req) => call('/share/cards', { method: 'POST', body: req }),
    getSettings: (vehicleId) => call(`/vehicles/${encodeURIComponent(vehicleId)}/settings`),
    putSettings: (vehicleId, patch) => call(`/vehicles/${encodeURIComponent(vehicleId)}/settings`, { method: 'PUT', body: patch }),
    deleteData: (vehicleId) => call(`/vehicles/${encodeURIComponent(vehicleId)}/data`, { method: 'DELETE' }),
  };
};

const stringify = (q: Record<string, string | number | undefined>) =>
  Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
