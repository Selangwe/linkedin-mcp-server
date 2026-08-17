import { promises as fs } from "fs";
import path from "path";

/**
 * Generic key-value storage abstraction (with optional TTL), used by the
 * OAuth authorization server layer to persist registered clients,
 * single-use authorization codes, and issued access/refresh tokens.
 *
 * Deliberately separate from token-store.ts (which is purpose-built for the
 * single LinkedIn token record) so that file doesn't have to grow a generic
 * multi-key interface it doesn't otherwise need.
 *
 * Same two backends, chosen the same way (TOKEN_STORE_DRIVER):
 *  - FileKeyValueStore: one JSON file per key, on disk. Fine for local dev
 *    and any host with a persistent volume.
 *  - RedisKeyValueStore: Upstash Redis via @upstash/redis, with native TTL
 *    support (used for auth codes and access tokens so they expire without
 *    any manual cleanup). Required on Vercel.
 */
export interface IKeyValueStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface FileEnvelope<T> {
  value: T;
  /** Epoch ms after which this entry is treated as absent. */
  expiresAt?: number;
}

export class FileKeyValueStore implements IKeyValueStore {
  constructor(private readonly dir: string) {}

  private fileFor(key: string): string {
    // Keys can contain characters that aren't filesystem-safe (tokens are
    // base64url so they're fine, but be defensive for client ids etc.).
    const safe = Buffer.from(key).toString("base64url");
    return path.join(this.dir, `${safe}.json`);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.fileFor(key), "utf-8");
      const envelope = JSON.parse(raw) as FileEnvelope<T>;
      if (envelope.expiresAt && envelope.expiresAt < Date.now()) {
        await this.del(key);
        return null;
      }
      return envelope.value;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const envelope: FileEnvelope<T> = {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    };
    await fs.writeFile(this.fileFor(key), JSON.stringify(envelope), "utf-8");
  }

  async del(key: string): Promise<void> {
    try {
      await fs.unlink(this.fileFor(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

// Typed loosely (rather than importing Redis's own type) to avoid a hard
// compile-time dependency on @upstash/redis for consumers who only use
// FileKeyValueStore, and to sidestep its overly-strict SetCommandOptions
// union (which doesn't structurally accept a plain `{ ex?: number }`).
interface LooseRedisClient {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
}

export class RedisKeyValueStore implements IKeyValueStore {
  private redisPromise: Promise<LooseRedisClient> | null = null;

  private async client(): Promise<LooseRedisClient> {
    if (!this.redisPromise) {
      this.redisPromise = import("@upstash/redis").then(({ Redis }) => {
        try {
          return Redis.fromEnv() as unknown as LooseRedisClient;
        } catch {
          const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
          const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
          if (!url || !token) {
            throw new Error(
              "No Redis credentials found for RedisKeyValueStore. Checked UPSTASH_REDIS_REST_URL/_TOKEN and KV_REST_API_URL/_TOKEN."
            );
          }
          return new Redis({ url, token }) as unknown as LooseRedisClient;
        }
      });
    }
    return this.redisPromise;
  }

  async get<T>(key: string): Promise<T | null> {
    const redis = await this.client();
    const value = await redis.get(key);
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const redis = await this.client();
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await redis.set(key, serialized, { ex: ttlSeconds });
    } else {
      await redis.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    const redis = await this.client();
    await redis.del(key);
  }
}

/**
 * @param namespace Used to keep different record types (clients, codes,
 *   access tokens, refresh tokens) from colliding — becomes a subdirectory
 *   for the file backend and is expected to already be reflected in the
 *   keys callers pass for the Redis backend.
 */
export function createKeyValueStore(namespace: string): IKeyValueStore {
  const driver = (process.env.TOKEN_STORE_DRIVER || "file").toLowerCase();
  if (driver === "kv") return new RedisKeyValueStore();
  const baseDir = process.env.TOKEN_STORE_PATH ? path.dirname(process.env.TOKEN_STORE_PATH) : "./data";
  return new FileKeyValueStore(path.join(baseDir, namespace));
}
