import { MemoryCache } from "./memory-cache";

// In-process cache for team permissions
const cache = new MemoryCache("team-permissions", 30 * 60); // 30 minutes TTL

export const teamPermissionsCache = {
  get: (key: string): Promise<string | undefined> => cache.get<string>(key),
  set: (key: string, value: string): Promise<void> => cache.set(key, value),
  delete: (key: string): Promise<void> => cache.delete(key),
};
