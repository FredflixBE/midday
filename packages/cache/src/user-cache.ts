import { MemoryCache } from "./memory-cache";

// In-process cache for users
const cache = new MemoryCache("user", 30 * 60); // 30 minutes TTL

export const userCache = {
  get: (key: string): Promise<any | undefined> => cache.get(key),
  set: (key: string, value: any): Promise<void> => cache.set(key, value),
  delete: (key: string): Promise<void> => cache.delete(key),
};
