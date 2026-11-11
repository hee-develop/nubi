import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApi, type NubiApi } from '../api';
import { KEYS, readJson, storage } from './storage';

export type Pairing = { accountId: string; token: string; vehicleId: string };
export type GuestSession = { sessionId: string; token: string; nickname?: string };

type Ctx = {
  api: NubiApi;
  ready: boolean;
  pairing: Pairing | null;
  guest: GuestSession | null;
  savePairing(p: Pairing): Promise<void>;
  clearPairing(): Promise<void>;
  saveGuest(g: GuestSession): Promise<void>;
  clearGuest(): Promise<void>;
};

const SessionContext = createContext<Ctx | null>(null);

export const SessionProvider = ({ api, children }: { api?: NubiApi; children: ReactNode }) => {
  const resolvedApi = useMemo(() => api ?? createApi(), [api]);
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [guest, setGuest] = useState<GuestSession | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [p, g] = await Promise.all([readJson<Pairing>(KEYS.pairing), readJson<GuestSession>(KEYS.guest)]);
      if (!alive) return;
      setPairing(p);
      setGuest(g);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const savePairing = useCallback(async (p: Pairing) => {
    await storage.set(KEYS.pairing, JSON.stringify(p));
    setPairing(p);
  }, []);
  const clearPairing = useCallback(async () => {
    await storage.remove(KEYS.pairing);
    setPairing(null);
  }, []);
  const saveGuest = useCallback(async (g: GuestSession) => {
    await storage.set(KEYS.guest, JSON.stringify(g));
    setGuest(g);
  }, []);
  const clearGuest = useCallback(async () => {
    await storage.remove(KEYS.guest);
    setGuest(null);
  }, []);

  const value = useMemo(
    () => ({ api: resolvedApi, ready, pairing, guest, savePairing, clearPairing, saveGuest, clearGuest }),
    [resolvedApi, ready, pairing, guest, savePairing, clearPairing, saveGuest, clearGuest],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = () => {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider 밖에서 useSession을 썼습니다.');
  return v;
};
