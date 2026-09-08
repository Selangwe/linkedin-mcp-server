import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SafetyGuard } from "../src/safety/guard.js";
import { MemoryKv } from "./helpers/memory-kv.js";

/**
 * A confirmation approves a specific action against a specific target. These
 * cover the failure a security review found: the outreach send path bound its
 * token to the prospect's DISPLAY NAME and the message text, so two people
 * sharing a name whose step rendered identically produced the same digest —
 * and an approval for one could be replayed against the other, reaching
 * someone the human never saw.
 */
describe("confirmation binds the recipient, not just the message", () => {
  const saved = process.env.LINKEDIN_MIN_ACTION_GAP_SECONDS;

  beforeEach(() => {
    // Take the throttle out of the picture; it isn't what's under test.
    process.env.LINKEDIN_MIN_ACTION_GAP_SECONDS = "0";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.LINKEDIN_MIN_ACTION_GAP_SECONDS;
    else process.env.LINKEDIN_MIN_ACTION_GAP_SECONDS = saved;
  });

  /** The payload shape runStep now guards with. */
  const payloadFor = (prospectId: string, recipient: string) => ({
    prospect_id: prospectId,
    recipient,
    step_key: "s1",
    text: "Hi John, saw your work.",
  });

  it("refuses a token approved for a different person with the same name and text", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    const spec = { action: "message.send" } as const;

    const approved = payloadFor("prospect-a", "https://linkedin.com/in/john-smith-a");
    const first = await guard.check(spec, approved);
    if (first.ok) throw new Error("expected a confirmation request");

    // Same display name, same rendered text — a different human being.
    const other = payloadFor("prospect-b", "https://linkedin.com/in/john-smith-b");
    const replay = await guard.check(spec, other, first.confirm_token);

    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.message).toContain("content changed");
  });

  it("accepts the token for the person it was actually approved for", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    const spec = { action: "message.send" } as const;

    const approved = payloadFor("prospect-a", "https://linkedin.com/in/john-smith-a");
    const first = await guard.check(spec, approved);
    if (first.ok) throw new Error("expected a confirmation request");

    expect((await guard.check(spec, approved, first.confirm_token)).ok).toBe(true);
  });

  it("puts the recipient in the preview, so a human approves an address not a label", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    const verdict = await guard.check(
      { action: "message.send" },
      payloadFor("prospect-a", "urn:li:person:abc123")
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.preview).toMatchObject({
      prospect_id: "prospect-a",
      recipient: "urn:li:person:abc123",
    });
  });

  it("refuses when only the step changes, even for the same recipient", async () => {
    const guard = new SafetyGuard(new MemoryKv());
    const spec = { action: "message.send" } as const;

    const first = await guard.check(spec, payloadFor("prospect-a", "urn:li:person:abc"));
    if (first.ok) throw new Error("expected a confirmation request");

    const laterStep = { ...payloadFor("prospect-a", "urn:li:person:abc"), step_key: "s3" };
    expect((await guard.check(spec, laterStep, first.confirm_token)).ok).toBe(false);
  });
});
