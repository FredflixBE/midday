import type { ApiKey } from "@midday/db/queries";
import { MemoryCache } from "./memory-cache";

// In-process cache for API keys
const cache = new MemoryCache("api-key", 30 * 60); // 30 minutes TTL

export const apiKeyCache = {
  get: (key: string): Promise<ApiKey | undefined> => cache.get<ApiKey>(key),
  set: (key: string, value: ApiKey): Promise<void> => cache.set(key, value),
  delete: (key: string): Promise<void> => cache.delete(key),
};
