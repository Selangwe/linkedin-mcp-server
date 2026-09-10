import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OutreachEngine } from "../src/outreach/engine.js";
import { SafetyGuard } from "../src/safety/guard.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { handleLinkedInApiError, OutreachError } from "../src/services/errors.js";
import type { LinkedInAuth } from "../src/services/linkedin-auth.js";
import type { SequenceStep } from "../src/outreach/types.js";
import { MemoryKv } from "./helpers/memory-kv.js";

/**
 * Regressions for the defects a code review found before this branch merged.
 * Each one was silently wrong: the code ran, it just did the wrong thing or
 * nothing at all.
 */

const STEPS: SequenceStep[] = [
  { key: "s1", channel: "linkedin_dm", delay_days: 0, template: "Hi {{first_name}}." },
  { key: "s2", channel: "linkedin_dm", delay_days: 3, template: "Following up, {{first_name}}." },
];

async function seeded() {
  const e = new OutreachEngine(new MemoryKv());
  const { prospect } = await e.upsertProspect({
    full_name: "Ada Lovelace",
    profile_url: "https://li/in/ada",
  });
  const seq = await e.defineSequence("seq", STEPS);
  await e.enroll(prospect.id, seq.id);
  return { e, pid: prospect.id, seqId: seq.id };
}

describe("redefining a sequence cannot strand a live enrollment", () => {
  it("refuses to change steps while someone is part-way through", async () => {
    const { e } = await seeded();
    await expect(
      e.defineSequence("seq", [{ ...STEPS[0], template: "Totally different." }])
    ).rejects.toThrow(/part-way through/);
  });

  it("allows an identical redefinition, so re-running setup is safe", async () => {
    const { e } = await seeded();
    await expect(e.defineSequence("seq", STEPS)).resolves.toBeTruthy();
  });

  it("allows a change once nobody is mid-sequence", async () => {
    const { e, pid } = await seeded();
    await e.updateProspect(pid, { status: "replied" });
    await expect(
      e.defineSequence("seq", [{ ...STEPS[0], template: "New copy." }])
    ).resolves.toBeTruthy();
  });
});

describe("stop_if_replied is actually honoured", () => {
  it("blocks a replied prospect by default", async () => {
    const { e, pid } = await seeded();
    await e.updateProspect(pid, { status: "replied" });
    await expect(e.prepare(pid)).rejects.toThrow(/replied/);
  });

  it("lets a step opt out of the reply stop", async () => {
    const e = new OutreachEngine(new MemoryKv());
    const { prospect } = await e.upsertProspect({ full_name: "Ada", profile_url: "https://li/in/a" });
    const seq = await e.defineSequence("continue", [
      { ...STEPS[0], stop_if_replied: false },
    ]);
    await e.enroll(prospect.id, seq.id);
    await e.updateProspect(prospect.id, { status: "replied" });

    // The enrollment is stopped by the status change, so re-enrol to model a
    // deliberate continuation of the conversation.
    await e.enroll(prospect.id, seq.id);
    await expect(e.prepare(prospect.id)).resolves.toBeTruthy();
  });

  it("never lets a step opt out of do_not_contact", async () => {
    const e = new OutreachEngine(new MemoryKv());
    const { prospect } = await e.upsertProspect({ full_name: "Ada", profile_url: "https://li/in/b" });
    const seq = await e.defineSequence("dnc", [{ ...STEPS[0], stop_if_replied: false }]);
    await e.enroll(prospect.id, seq.id);
    await e.updateProspect(prospect.id, { status: "do_not_contact" });
    await expect(e.prepare(prospect.id)).rejects.toThrow(/do_not_contact/);
  });
});

describe("daily caps are decided atomically", () => {
  const saved = process.env.LINKEDIN_CAP_MESSAGE_SEND;
  beforeEach(() => {
    process.env.LINKEDIN_CAP_MESSAGE_SEND = "2";
    process.env.LINKEDIN_MIN_ACTION_GAP_SECONDS = "0";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LINKEDIN_CAP_MESSAGE_SEND;
    else process.env.LINKEDIN_CAP_MESSAGE_SEND = saved;
    delete process.env.LINKEDIN_MIN_ACTION_GAP_SECONDS;
  });

  it("lets exactly the capped number of concurrent reservations through", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    const spec = { action: "message.send" } as const;

    // Four callers race for two slots. check() alone could pass all four.
    const verdicts = await Promise.all([
      guard.reserve(spec),
      guard.reserve(spec),
      guard.reserve(spec),
      guard.reserve(spec),
    ]);
    expect(verdicts.filter((v) => v.ok)).toHaveLength(2);
  });

  it("gives the slot back when the global cap is what refused", async () => {
    process.env.LINKEDIN_CAP_TOTAL = "1";
    const guard = new SafetyGuard(new MemoryKv());
    await guard.reserve({ action: "comment.reply" });

    const refused = await guard.reserve({ action: "message.send" });
    expect(refused.ok).toBe(false);

    // The per-action counter must not have been left incremented by the
    // refusal, or message.send would silently lose a slot it never used.
    delete process.env.LINKEDIN_CAP_TOTAL;
    const after = await guard.reserve({ action: "message.send" });
    expect(after.ok).toBe(true);
  });
});

describe("the daily request ceiling actually engages", () => {
  const saved = process.env.LINKEDIN_DAILY_REQUEST_CEILING;
  beforeEach(() => {
    process.env.LINKEDIN_DAILY_REQUEST_CEILING = "5";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LINKEDIN_DAILY_REQUEST_CEILING;
    else process.env.LINKEDIN_DAILY_REQUEST_CEILING = saved;
  });

  it("pauses writes once the ceiling is hit", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    for (let i = 0; i < 5; i++) await guard.noteRequest();

    const verdict = await guard.check({ action: "post.publish", requiresConfirmation: false }, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("cooldown");
  });

  it("warns at 80% of the ceiling, before it refuses", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    await guard.noteRequest();
    await guard.noteRequest();
    expect((await guard.noteRequest()).warn).toBe(false); // 3 of 5

    const fourth = await guard.noteRequest(); // 4 of 5 = 80%
    expect(fourth.warn).toBe(true);
    expect(fourth.used).toBe(4);

    // Warning is not refusing — writes still pass at this point.
    expect((await guard.check({ action: "post.publish", requiresConfirmation: false }, {})).ok).toBe(true);
  });
});

describe("a 429 pauses writes", () => {
  it("engages the cooldown branch that previously had no caller", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    await guard.noteRateLimit(120);
    const verdict = await guard.check({ action: "post.publish", requiresConfirmation: false }, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("cooldown");
    expect(verdict.next_allowed_at).toBeGreaterThan(Date.now());
  });
});

describe("capability observation is reachable", () => {
  it("promotes on a 2xx through the observer shape app.ts wires up", async () => {
    const auth = { async grantedScopes() { return ["w_member_social"]; } } as unknown as LinkedInAuth;
    const registry = new CapabilityRegistry(new MemoryKv(), auth, null);

    // Exactly the call the ResponseObserver in app.ts makes.
    const observer = {
      observe: (id: Parameters<typeof registry.observe>[0], status: number, evidence: string) =>
        registry.observe(id, status, evidence),
    };
    await observer.observe("comment.write", 201, "POST → 201");

    expect((await registry.get("comment.write")).state).toBe("available");
  });
});

describe("outreach errors keep their actionable message", () => {
  it("is not flattened into 'Unexpected error occurred'", () => {
    const msg = handleLinkedInApiError(
      new OutreachError("no value for company. Fill it in with linkedin_prospect_update")
    );
    expect(msg).toContain("Fill it in with linkedin_prospect_update");
    expect(msg).not.toContain("Unexpected error");
  });
});
