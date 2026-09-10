import crypto from "crypto";
import type { IKeyValueStore } from "./kv-store.js";

export interface PostRecord {
  urn: string;
  url: string;
  at: number;
  title?: string;
  /** First line of the caption, for recognising the post without storing all of it. */
  excerpt?: string;
  kind: "document" | "text";
}

const RING_SIZE = 200;

/**
 * A local record of what this server has published.
 *
 * LinkedIn will not give a self-serve app its own post analytics, so this is
 * the only history available: what went out, and when. It answers cadence
 * questions honestly and gives the analytics tool something real to report
 * instead of an apology.
 */
export class PostHistory {
  constructor(private readonly kv: IKeyValueStore) {}

  async record(entry: Omit<PostRecord, "at">): Promise<PostRecord> {
    const full: PostRecord = { ...entry, at: Date.now() };
    try {
      const id = crypto.createHash("sha1").update(entry.urn).digest("hex").slice(0, 12);
      await this.kv.set(`history:post:${id}`, full);
      const index = (await this.kv.get<string[]>("history:index")) ?? [];
      if (!index.includes(id)) index.unshift(id);
      await this.kv.set("history:index", index.slice(0, RING_SIZE));
    } catch {
      // Never let bookkeeping fail a publish that already succeeded.
    }
    return full;
  }

  async recent(limit = 25): Promise<PostRecord[]> {
    const index = (await this.kv.get<string[]>("history:index")) ?? [];
    const out: PostRecord[] = [];
    for (const id of index.slice(0, Math.min(limit, RING_SIZE))) {
      const entry = await this.kv.get<PostRecord>(`history:post:${id}`);
      if (entry) out.push(entry);
    }
    return out;
  }
}
