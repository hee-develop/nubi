import { act, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { createMockApi, type NubiApi } from '../api';
import { SessionProvider, type GuestSession, type Pairing } from '../state/session';
import { KEYS, storage } from '../state/storage';
import { setLocale } from '../lib/i18n';

export const PAIRING: Pairing = { accountId: 'a1', token: 'tok', vehicleId: 'mock-vehicle-0001' };
export const GUEST: GuestSession = { sessionId: 'mock-guest-1', token: 'gt', nickname: '민' };

/** 목 API를 지연 없이 만들고, 지정한 메서드만 덮어쓴다. */
export const makeApi = (over: Partial<NubiApi> = {}): NubiApi => ({ ...createMockApi({ latencyMs: 0 }), ...over });

export const renderApp = async (ui: ReactElement, opts: { api?: NubiApi; pairing?: Pairing | null; guest?: GuestSession | null } = {}) => {
  setLocale('ko');
  const { pairing = PAIRING, guest = null } = opts;
  await storage.remove(KEYS.pairing);
  await storage.remove(KEYS.guest);
  if (pairing) await storage.set(KEYS.pairing, JSON.stringify(pairing));
  if (guest) await storage.set(KEYS.guest, JSON.stringify(guest));
  const api = opts.api ?? makeApi();
  const view = await render(<SessionProvider api={api}>{ui}</SessionProvider>);
  await flush();
  return { ...view, api };
};

/** 대기 중인 프라미스·상태 갱신을 모두 비운다. */
export const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
