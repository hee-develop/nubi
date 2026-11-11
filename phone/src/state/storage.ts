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
  async remove(key: string): Promise<void> {
    memory.delete(key);
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* 무시 */
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
