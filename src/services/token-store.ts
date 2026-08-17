import { promises as fs } from "fs";
import path from "path";
import type { StoredTokens } from "../types.js";

/**
 * Storage abstraction for the single LinkedIn token record this server
 * manages. Two implementations are provided:
 *
 *  - FileTokenStore: writes a JSON file to disk. Works on any host with a
 *    persistent volume (Fly.io, Railway, a plain VPS). Do NOT use this on
 *    serverless/edge platforms (Vercel, most "container per request" hosts)
 *    — the filesystem resets between invocations and tokens will vanish.
 *
 *  - KvTokenStore: writes to Upstash Redis via @upstash/redis. This is the
 *    right choice for Vercel — add the "Upstash for Redis" integration from
 *    the Vercel Marketplace (Storage tab) and it injects the env vars
 *    Redis.fromEnv() reads automatically. Also works anywhere else you'd
 *    rather not manage a disk.
 *
 * Both are single-key stores: this server is single-user by design (one
 * LinkedIn account). For multi-user support, key the store by user id.
 */
export interface ITokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export class FileTokenStore implements ITokenStore {
  private readonly filePath: string;
  private cache: StoredTokens | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<StoredTokens | null> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(raw) as StoredTokens;
      return this.cache;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    this.cache = tokens;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(tokens, null, 2), "utf-8");
  }

  async clear(): Promise<void> {
    this.cache = null;
    try {
      await fs.unlink(this.filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

const KV_KEY = "linkedin-mcp-server:tokens";

export class KvTokenStore implements ITokenStore {
  // Typed loosely to avoid a hard compile-time dependency on @upstash/redis
  // for consumers who only use FileTokenStore and never install it.
  private redisPromise: Promise<{
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<unknown>;
    del: (key: string) => Promise<unknown>;
  }> | null = null;

  private async client() {
    if (!this.redisPromise) {
      this.redisPromise = import("@upstash/redis").then(({ Redis }) => {
        // Redis.fromEnv() only reads UPSTASH_REDIS_REST_URL / _TOKEN. Vercel's
        // marketplace integration has used different prefixes for this over
        // time (e.g. KV_REST_API_URL / KV_REST_API_TOKEN), so fall back to
        // constructing the client manually from whichever pair is present.
        try {
          return Redis.fromEnv();
        } catch {
          const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
          const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
          if (!url || !token) {
            throw new Error(
              "No Redis credentials found. Checked UPSTASH_REDIS_REST_URL/_TOKEN and KV_REST_API_URL/_TOKEN. " +
                "Check Project Settings → Environment Variables for the exact names your storage integration injected, " +
                "and set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN to match if needed."
            );
          }
          return new Redis({ url, token });
        }
      });
    }
    return this.redisPromise;
  }

  async load(): Promise<StoredTokens | null> {
    const redis = await this.client();
    const value = await redis.get(KV_KEY);
    if (!value) return null;
    // @upstash/redis auto-deserializes JSON values; guard against either shape.
    return typeof value === "string" ? (JSON.parse(value) as StoredTokens) : (value as StoredTokens);
  }

  async save(tokens: StoredTokens): Promise<void> {
    const redis = await this.client();
    await redis.set(KV_KEY, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    const redis = await this.client();
    await redis.del(KV_KEY);
  }
}

export function createTokenStore(): ITokenStore {
  const driver = (process.env.TOKEN_STORE_DRIVER || "file").toLowerCase();
  if (driver === "kv") return new KvTokenStore();
  return new FileTokenStore(process.env.TOKEN_STORE_PATH || "./data/tokens.json");
}
