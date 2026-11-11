import * as SecureStore from 'expo-secure-store';

/** SecureStore가 없거나 던지면(웹·테스트·잠긴 키체인) 메모리로 대신한다. 앱 재시작 후에는 사라진다. */
const memory = new Map<string, string>();

export const storage = {
  async get(key: string): Promise<string | null> {
    try {
      const v = await SecureStore.getItemAsync(key);
      return v ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    memory.set(key, value);
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      /* 메모리에는 남았다 */
    }
  },
  /** 지우지 못했으면 false. 메모리 값은 항상 지운다(호출자가 저장소 실패를 사용자에게 알릴 수 있게 한다). */
  async remove(key: string): Promise<boolean> {
    memory.delete(key);
    try {
      await SecureStore.deleteItemAsync(key);
      return true;
    } catch {
      return false;
    }
  },
};

export const KEYS = { pairing: 'nubi.pairing', guest: 'nubi.guest' } as const;

export const readJson = async <T>(key: string): Promise<T | null> => {
  const raw = await storage.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
