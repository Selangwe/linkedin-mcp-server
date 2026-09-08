import { describe, expect, it } from "vitest";
import { OutreachEngine, OutreachError, render, prospectId } from "../src/outreach/engine.js";
import type { Prospect, SequenceStep } from "../src/outreach/types.js";
import { MemoryKv } from "./helpers/memory-kv.js";

const DAY_MS = 86_400_000;

function engine() {
  return new OutreachEngine(new MemoryKv());
}

const STEPS: SequenceStep[] = [
  { key: "s1", channel: "linkedin_dm", delay_days: 0, template: "Hi {{first_name}}, saw {{company}}." },
  { key: "s2", channel: "linkedin_dm", delay_days: 3, template: "Following up, {{first_name}}." },
  { key: "s3", channel: "linkedin_dm", delay_days: 7, template: "Last note, {{first_name}}." },
];

async function seeded() {
  const e = engine();
  const { prospect } = await e.upsertProspect({
    full_name: "Ada Lovelace",
    company: "Analytical Engines",
    profile_url: "https://www.linkedin.com/in/ada/",
  });
  const seq = await e.defineSequence("3-touch", STEPS);
  await e.enroll(prospect.id, seq.id);
  return { e, prospectId: prospect.id, sequenceId: seq.id };
}

/** A complete Prospect, so render() is exercised against the real shape. */
function makeProspect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    id: "p1",
    full_name: "Ada Lovelace",
    company: "Analytical Engines",
    tags: [],
    source: "manual",
    status: "active",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("template rendering", () => {
  const prospect = makeProspect({ custom: { topic: "compilers" } });

  it("substitutes the built-in fields", () => {
    expect(render(STEPS[0], prospect)).toBe("Hi Ada, saw Analytical Engines.");
  });

  it("substitutes custom fields", () => {
    const step = { ...STEPS[0], template: "About {{custom.topic}}" };
    expect(render(step, prospect)).toBe("About compilers");
  });

  it("refuses to render an unresolved placeholder rather than sending a literal {{var}}", () => {
    const step = { ...STEPS[0], template: "Hi {{first_name}} at {{custom.missing}}" };
    expect(() => render(step, prospect)).toThrow(/no value for custom.missing/);
  });

  it("treats an empty company as missing, not as an empty string", () => {
    const bare = makeProspect({ company: "" });
    expect(() => render(STEPS[0], bare)).toThrow(/company/);
  });
});

describe("prospect identity", () => {
  it("dedupes on profile URL regardless of trailing slash, case or query", () => {
    const a = prospectId({ full_name: "A", profile_url: "https://www.linkedin.com/in/ada/" });
    const b = prospectId({ full_name: "B", profile_url: "https://WWW.linkedin.com/IN/ada?utm=x" });
    expect(a).toBe(b);
  });

  it("falls back to name plus company when there is no URL", () => {
    const a = prospectId({ full_name: "Ada Lovelace", company: "Engines" });
    const b = prospectId({ full_name: "ada lovelace", company: "engines" });
    expect(a).toBe(b);
    expect(a).not.toBe(prospectId({ full_name: "Ada Lovelace", company: "Other" }));
  });

  it("updates rather than duplicates on a second upsert", async () => {
    const e = engine();
    const first = await e.upsertProspect({ full_name: "Ada", profile_url: "https://li/in/ada" });
    const second = await e.upsertProspect({
      full_name: "Ada",
      profile_url: "https://li/in/ada",
      company: "Engines",
    });
    expect(second.created).toBe(false);
    expect(second.prospect.id).toBe(first.prospect.id);
    expect(second.prospect.company).toBe("Engines");
    expect(await e.listProspects()).toHaveLength(1);
  });
});

describe("the drafting lifecycle", () => {
  it("runs add → define → enroll → due → prepare → complete → next step", async () => {
    const { e, prospectId: pid } = await seeded();

    const due = await e.due();
    expect(due).toHaveLength(1);
    expect(due[0].prospect_id).toBe(pid);

    const prepared = await e.prepare(pid);
    expect(prepared.text).toBe("Hi Ada, saw Analytical Engines.");
    expect(prepared.step.key).toBe("s1");
    expect(prepared.duplicate).toBe(false);

    // Drafted: the sequence must NOT advance until a human confirms the send.
    await e.complete(pid, {
      step_key: "s1",
      at: Date.now(),
      channel: "linkedin_dm",
      mode: "drafted",
      message_digest: prepared.digest,
    });

    let prospect = await e.getProspect(pid);
    expect(prospect?.enrollment?.state).toBe("awaiting_send");
    expect(prospect?.enrollment?.step_index).toBe(0);
    // Nothing is due while we are waiting on the human.
    expect(await e.due()).toHaveLength(0);

    // Human confirms the send: now it advances and schedules step 2.
    await e.complete(pid, {
      step_key: "s1",
      at: Date.now(),
      channel: "linkedin_dm",
      mode: "marked_sent_by_human",
      message_digest: prepared.digest,
    });

    prospect = await e.getProspect(pid);
    expect(prospect?.enrollment?.step_index).toBe(1);
    expect(prospect?.enrollment?.state).toBe("pending");
    // Step 2 has a 3-day delay, so it is not due yet...
    expect(await e.due()).toHaveLength(0);
    // ...but is due once that window passes.
    expect(await e.due(Date.now() + 4 * DAY_MS)).toHaveLength(1);

    const second = await e.prepare(pid);
    expect(second.text).toBe("Following up, Ada.");
  });

  it("marks a repeated step as a duplicate", async () => {
    const { e, prospectId: pid } = await seeded();
    const prepared = await e.prepare(pid);
    await e.complete(pid, {
      step_key: "s1",
      at: Date.now(),
      channel: "linkedin_dm",
      mode: "auto_sent",
      message_digest: prepared.digest,
    });

    // Re-enrolling replays step 1; prepare should flag that it already went out.
    await e.enroll(pid, (await e.listSequences())[0].id);
    expect((await e.prepare(pid)).duplicate).toBe(true);
  });

  it("completes the sequence after the last step", async () => {
    const { e, prospectId: pid } = await seeded();
    for (const key of ["s1", "s2", "s3"]) {
      const prepared = await e.prepare(pid);
      expect(prepared.step.key).toBe(key);
      await e.complete(pid, {
        step_key: key,
        at: Date.now(),
        channel: "linkedin_dm",
        mode: "auto_sent",
        message_digest: prepared.digest,
      });
    }
    const prospect = await e.getProspect(pid);
    expect(prospect?.enrollment?.state).toBe("completed");
    await expect(e.prepare(pid)).rejects.toThrow(/finished every step/);
  });
});

describe("stopping conditions", () => {
  it("stops the sequence the moment a prospect is marked replied", async () => {
    const { e, prospectId: pid } = await seeded();
    await e.updateProspect(pid, { status: "replied" });

    const prospect = await e.getProspect(pid);
    expect(prospect?.enrollment?.state).toBe("stopped");
    await expect(e.prepare(pid)).rejects.toThrow(/replied/);
    expect(await e.due()).toHaveLength(0);
  });

  it("refuses to enrol someone marked do_not_contact", async () => {
    const e = engine();
    const { prospect } = await e.upsertProspect({ full_name: "Ada", company: "Engines" });
    await e.updateProspect(prospect.id, { status: "do_not_contact" });
    const seq = await e.defineSequence("s", STEPS);
    await expect(e.enroll(prospect.id, seq.id)).rejects.toThrow(/do_not_contact/);
  });

  it("refuses to prepare for someone who is not enrolled", async () => {
    const e = engine();
    const { prospect } = await e.upsertProspect({ full_name: "Ada", company: "Engines" });
    await expect(e.prepare(prospect.id)).rejects.toThrow(/not enrolled/);
  });

  it("reports a missing prospect clearly", async () => {
    await expect(engine().prepare("nope")).rejects.toThrow(OutreachError);
  });
});

describe("sequence definition", () => {
  it("rejects an empty sequence and duplicate step keys", async () => {
    const e = engine();
    await expect(e.defineSequence("empty", [])).rejects.toThrow(/at least one step/);
    await expect(
      e.defineSequence("dupes", [STEPS[0], { ...STEPS[1], key: "s1" }])
    ).rejects.toThrow(/unique/);
  });
});

describe("drafts", () => {
  it("stores a draft a human can retrieve and send by hand", async () => {
    const e = engine();
    const draft = await e.saveDraft({
      prospect_id: "p1",
      step_key: "s1",
      channel: "linkedin_dm",
      text: "Hi Ada",
      profile_url: "https://linkedin.com/in/ada",
    });
    const back = await e.getDraft(draft.id);
    expect(back?.text).toBe("Hi Ada");
    expect(back?.profile_url).toBe("https://linkedin.com/in/ada");
  });
});
