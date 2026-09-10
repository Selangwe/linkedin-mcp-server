import type { IKeyValueStore } from "../../src/services/kv-store.js";

/** An in-memory IKeyValueStore with working TTLs, for tests. */
export class MemoryKv implements IKeyValueStore {
  private data = new Map<string, { value: unknown; expiresAt?: number }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  /**
   * Atomic, like Redis INCRBY — the read and write happen in one synchronous
   * step with no await between them. That matters: the safety guard relies on
   * incr being atomic to decide daily caps, and a fake that yields mid-update
   * would make a correct guard look broken (and a broken one look fine).
   */
  async incr(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    const entry = this.data.get(key);
    const live = entry && (!entry.expiresAt || entry.expiresAt >= Date.now());
    const next = (live ? (entry.value as number) : 0) + by;
    this.data.set(key, {
      value: next,
      expiresAt: live ? entry.expiresAt : ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    return next;
  }
}
