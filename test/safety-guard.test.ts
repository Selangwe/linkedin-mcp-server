import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SafetyGuard } from "../src/safety/guard.js";
import { MemoryKv } from "./helpers/memory-kv.js";

const ENV_KEYS = [
  "LINKEDIN_KILL_SWITCH",
  "LINKEDIN_CAP_MESSAGE_SEND",
  "LINKEDIN_CAP_TOTAL",
  "LINKEDIN_MIN_ACTION_GAP_SECONDS",
  "LINKEDIN_REQUIRE_CONFIRMATION",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function guard() {
  return new SafetyGuard(new MemoryKv());
}

describe("two-phase confirmation", () => {
  const spec = { action: "message.send" } as const;

  it("refuses the first call and hands back a preview plus a token", async () => {
    const g = guard();
    const verdict = await g.check(spec, { text: "hello" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("needs_confirmation");
    expect(verdict.confirm_token).toBeTruthy();
    expect(verdict.preview).toEqual({ text: "hello" });
    expect(verdict.message).toContain("Nothing has been sent");
  });

  it("accepts the token when the payload is unchanged", async () => {
    const g = guard();
    const first = await g.check(spec, { text: "hello" });
    if (first.ok) throw new Error("expected a confirmation request");
    expect((await g.check(spec, { text: "hello" }, first.confirm_token)).ok).toBe(true);
  });

  it("rejects the token if the content changed after approval", async () => {
    const g = guard();
    const first = await g.check(spec, { text: "hello" });
    if (first.ok) throw new Error("expected a confirmation request");

    const second = await g.check(spec, { text: "something else entirely" }, first.confirm_token);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("content changed");
  });

  it("treats payload key order as the same content", async () => {
    const g = guard();
    const first = await g.check(spec, { a: 1, b: 2 });
    if (first.ok) throw new Error("expected a confirmation request");
    expect((await g.check(spec, { b: 2, a: 1 }, first.confirm_token)).ok).toBe(true);
  });

  it("burns the token so an approval cannot be replayed", async () => {
    const g = guard();
    const first = await g.check(spec, { text: "hello" });
    if (first.ok) throw new Error("expected a confirmation request");

    expect((await g.check(spec, { text: "hello" }, first.confirm_token)).ok).toBe(true);
    const replay = await g.check(spec, { text: "hello" }, first.confirm_token);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.message).toContain("already used");
  });

  it("rejects a token issued for a different action", async () => {
    const g = guard();
    const first = await g.check({ action: "post.publish" }, { text: "x" });
    if (first.ok) throw new Error("expected a confirmation request");

    const cross = await g.check({ action: "message.send" }, { text: "x" }, first.confirm_token);
    expect(cross.ok).toBe(false);
  });

  it("still confirms sends even when confirmation is relaxed by env", async () => {
    process.env.LINKEDIN_REQUIRE_CONFIRMATION = "false";
    const g = guard();
    // Publishing may be relaxed...
    expect((await g.check({ action: "post.publish" }, { a: 1 })).ok).toBe(true);
    // ...but anything that reaches another person may not.
    expect((await g.check({ action: "message.send" }, { a: 1 })).ok).toBe(false);
  });
});

describe("kill switch", () => {
  it("blocks every action once set, ahead of any other rail", async () => {
    const g = guard();
    await g.setKillSwitch(true, "testing");
    const verdict = await g.check({ action: "post.publish" }, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("kill_switch");
    expect(verdict.message).toContain("testing");
  });

  it("cannot be cleared from a tool while the env var holds it on", async () => {
    process.env.LINKEDIN_KILL_SWITCH = "1";
    const g = guard();
    expect((await g.killSwitch()).on).toBe(true);
    await expect(g.setKillSwitch(false)).rejects.toThrow(/environment variable/);
  });
});

describe("daily caps", () => {
  it("refuses once the per-action cap is spent", async () => {
    process.env.LINKEDIN_CAP_MESSAGE_SEND = "2";
    process.env.LINKEDIN_REQUIRE_CONFIRMATION = "false";
    const g = guard();
    const spec = { action: "message.send", requiresConfirmation: false } as const;

    await g.reserve(spec);
    await g.reserve(spec);

    const verdict = await g.check(spec, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("cap");
    expect(verdict.message).toContain("2/2");
  });

  it("refuses on the global cap even when the per-action cap has room", async () => {
    process.env.LINKEDIN_CAP_TOTAL = "1";
    const g = guard();
    await g.reserve({ action: "comment.reply" });

    const verdict = await g.check({ action: "post.publish", requiresConfirmation: false }, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain("across all LinkedIn actions");
  });
});

describe("throttle and cooldown", () => {
  it("refuses with a next_allowed_at rather than sleeping", async () => {
    const g = guard();
    await g.reserve({ action: "comment.reply" });

    const verdict = await g.check({ action: "comment.reply", requiresConfirmation: false }, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("throttle");
    expect(verdict.next_allowed_at).toBeGreaterThan(Date.now());
  });

  it("does not pace publishing", async () => {
    const g = guard();
    await g.reserve({ action: "post.publish" });
    expect((await g.check({ action: "post.publish", requiresConfirmation: false }, {})).ok).toBe(true);
  });

  it("pauses writes after a rate limit", async () => {
    const g = guard();
    await g.noteRateLimit(60);
    const verdict = await g.check({ action: "post.publish", requiresConfirmation: false }, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("cooldown");
  });
});

describe("audit log", () => {
  it("records blocked actions, not just executed ones", async () => {
    const g = guard();
    await g.audit.record({ action: "message.send", outcome: "blocked", detail: "cap reached" });
    await g.audit.record({ action: "post.publish", outcome: "executed", target: "urn:li:share:1" });

    const recent = await g.audit.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0].action).toBe("post.publish"); // newest first
    expect(recent.map((e) => e.outcome)).toContain("blocked");
  });

  it("filters by action", async () => {
    const g = guard();
    await g.audit.record({ action: "message.send", outcome: "executed" });
    await g.audit.record({ action: "post.publish", outcome: "executed" });

    const only = await g.audit.recent({ action: "post.publish" });
    expect(only).toHaveLength(1);
    expect(only[0].action).toBe("post.publish");
  });
});
