import crypto from "crypto";
import type { IKeyValueStore } from "../services/kv-store.js";
import type { SafetyAction } from "./config.js";

export type AuditOutcome = "executed" | "blocked" | "failed" | "drafted";

export interface AuditEntry {
  id: string;
  at: number;
  action: SafetyAction | "outreach.step" | "kill_switch";
  outcome: AuditOutcome;
  /** Who or what the action was aimed at — a post URN, a prospect id. */
  target?: string;
  /**
   * sha256 of the payload, not the payload. Proves what was sent without
   * keeping a second copy of every message body in a second store.
   */
  payload_digest?: string;
  provider?: string;
  detail?: string;
}

const RING_SIZE = 500;
const ENTRY_TTL_SECONDS = 365 * 24 * 3600;

/**
 * An append-only record of everything this server did on the member's behalf,
 * including the things it refused to do — a blocked action is usually the more
 * interesting entry.
 *
 * The index is a bounded ring rather than an ever-growing list, because
 * IKeyValueStore has no scan and an unbounded index would eventually be too
 * big to read inside a request.
 */
export class AuditLog {
  constructor(private readonly kv: IKeyValueStore) {}

  static digest(payload: unknown): string {
    return crypto.createHash("sha256").update(canonical(payload)).digest("hex").slice(0, 32);
  }

  async record(entry: Omit<AuditEntry, "id" | "at">): Promise<AuditEntry> {
    const full: AuditEntry = {
      ...entry,
      id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      at: Date.now(),
    };
    try {
      await this.kv.set(`audit:${full.id}`, full, ENTRY_TTL_SECONDS);
      const index = (await this.kv.get<string[]>("audit:index")) ?? [];
      index.unshift(full.id);
      await this.kv.set("audit:index", index.slice(0, RING_SIZE));
    } catch {
      // Auditing must never be the reason a tool call fails.
    }
    return full;
  }

  async recent(opts: { limit?: number; action?: string; since?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(opts.limit ?? 50, RING_SIZE);
    const index = (await this.kv.get<string[]>("audit:index")) ?? [];
    const out: AuditEntry[] = [];

    for (const id of index) {
      if (out.length >= limit) break;
      const entry = await this.kv.get<AuditEntry>(`audit:${id}`);
      if (!entry) continue; // expired out from under the index
      if (opts.action && entry.action !== opts.action) continue;
      if (opts.since && entry.at < opts.since) continue;
      out.push(entry);
    }
    return out;
  }
}

/** Stable stringify, so the same payload always digests to the same value. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
