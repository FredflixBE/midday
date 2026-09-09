/**
 * A per-process cache with the shape the Redis one had.
 *
 * These caches exist to spare the database a repeated lookup of something that
 * barely changes — a team, a user, an API key, a banking token. Redis was there
 * so several API instances could share one copy. This deployment runs a single
 * instance, which makes a local map equivalent and removes a service.
 *
 * The one real difference: an invalidation only reaches this process. If this
 * API is ever scaled past one instance, a second instance would keep serving a
 * stale entry for up to its TTL. That is the thing to remember before adding a
 * replica, and the reason every method still returns a promise — a shared cache
 * can be dropped back in without touching a single call site.
 */

interface Entry {
  value: unknown;
  /** Epoch milliseconds, or null for an entry that never expires. */
  expiresAt: number | null;
}

/**
 * Entries per cache. Well above the working set of a single-user deployment,
 * and low enough that a runaway key space cannot exhaust memory.
 */
const MAX_ENTRIES = 5_000;

export class MemoryCache {
  private readonly store = new Map<string, Entry>();
  private readonly defaultTTL: number;

  /**
   * @param _prefix - Kept for parity with the Redis cache's key namespacing.
   *   Each instance has its own map, so nothing needs prefixing any more.
   * @param defaultTTL - Seconds. 0 means entries never expire.
   */
  constructor(_prefix: string, defaultTTL: number = 30 * 60) {
    this.defaultTTL = defaultTTL;
  }

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }

    // Re-insert so the oldest key by last use is the one evicted first.
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTTL;

    this.store.delete(key);
    this.store.set(key, {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null,
    });

    if (this.store.size > MAX_ENTRIES) {
      this.evictOldest();
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Drop the least recently used entries, preferring anything already expired.
   * Map preserves insertion order and `get`/`set` re-insert, so iteration order
   * is least-recently-used first.
   */
  private evictOldest(): void {
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      }
      if (this.store.size <= MAX_ENTRIES) {
        return;
      }
    }

    while (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next();
      if (oldest.done) return;
      this.store.delete(oldest.value);
    }
  }
}
