import { promises as fs } from "fs";
import path from "path";
import type { StoredTokens } from "../types.js";

/**
 * Minimal file-backed token store.
 *
 * This is intentionally simple (single-user, single-file JSON) because this
 * server is meant to run privately for one LinkedIn account. If you need
 * multi-user support, swap this for a real database keyed by user id.
 *
 * IMPORTANT: TOKEN_STORE_PATH must point at a persistent disk/volume on
 * whatever host you deploy to. On platforms with ephemeral filesystems
 * (most serverless/container-per-request platforms), tokens will vanish on
 * every restart/redeploy and you'll need to re-run the OAuth flow.
 */
export class TokenStore {
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
