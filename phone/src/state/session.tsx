import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApi, type NubiApi } from '../api';
import { KEYS, readJson, storage } from './storage';
import { getOwnerToken, setOwnerToken } from './token';

export type Pairing = { accountId: string; token: string; vehicleId: string };
/** ended: 내리기를 마친 세션(기록 열람·삭제를 위해 토큰은 남겨 둔다). */
export type GuestSession = { sessionId: string; token: string; nickname?: string; ended?: boolean };

type Ctx = {
  api: NubiApi;
  ready: boolean;
  pairing: Pairing | null;
  /** 차주 토큰이 만료·폐기돼(401) 연결이 풀렸다. 연결 화면이 안내한다. */
  expired: boolean;
  guest: GuestSession | null;
  savePairing(p: Pairing): Promise<void>;
  /** 저장소에서 못 지웠으면 false(메모리 상태는 비운다). */
  clearPairing(): Promise<boolean>;
  saveGuest(g: GuestSession): Promise<void>;
  clearGuest(): Promise<boolean>;
  /** 데이터 삭제 등으로 서버 기록이 바뀌면 부른다. 이 값에 의존하는 화면이 다시 조회한다. */
  dataVersion: number;
  invalidate(): void;
};

const SessionContext = createContext<Ctx | null>(null);

export const SessionProvider = ({ api, children }: { api?: NubiApi; children: ReactNode }) => {
  // 차주 토큰은 호출 때마다 읽어 모든 차량 API 요청에 Bearer로 붙인다(api를 다시 만들지 않는다).
  const [expired, setExpired] = useState(false);
  const [ready, setReady] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  /** 차주 토큰이 401(만료 180일·폐기)이면 이 폰의 연결을 풀고 연결 화면이 안내한다. */
  const onUnauthorized = useCallback(() => {
    void storage.remove(KEYS.pairing);
    setOwnerToken(null);
    setPairing(null);
    setExpired(true);
  }, []);
  const resolvedApi = useMemo(() => api ?? createApi(undefined, getOwnerToken, onUnauthorized), [api, onUnauthorized]);
  const [guest, setGuest] = useState<GuestSession | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [p, g] = await Promise.all([readJson<Pairing>(KEYS.pairing), readJson<GuestSession>(KEYS.guest)]);
      if (!alive) return;
      setOwnerToken(p?.token ?? null);
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
    setOwnerToken(p.token);
    setPairing(p);
    setExpired(false);
  }, []);
  const clearPairing = useCallback(async () => {
    const ok = await storage.remove(KEYS.pairing);
    setOwnerToken(null);
    setPairing(null);
    return ok;
  }, []);
  const saveGuest = useCallback(async (g: GuestSession) => {
    await storage.set(KEYS.guest, JSON.stringify(g));
    setGuest(g);
  }, []);
  const clearGuest = useCallback(async () => {
    const ok = await storage.remove(KEYS.guest);
    setGuest(null);
    return ok;
  }, []);
  const invalidate = useCallback(() => setDataVersion((n) => n + 1), []);

  const value = useMemo(
    () => ({ api: resolvedApi, ready, pairing, expired, guest, savePairing, clearPairing, saveGuest, clearGuest, dataVersion, invalidate }),
    [resolvedApi, ready, pairing, expired, guest, savePairing, clearPairing, saveGuest, clearGuest, dataVersion, invalidate],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = () => {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider 밖에서 useSession을 썼습니다.');
  return v;
};
