import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapabilityId } from "../capabilities/types.js";
import type { StepChannel } from "../outreach/types.js";
import { confirmTokenField, defineTool, type ToolContext } from "./shared.js";

const channel = z
  .enum(["linkedin_dm", "linkedin_comment", "connection_note", "email", "manual"])
  .describe("How this step is delivered.");

const prospectFields = {
  full_name: z.string().min(1).max(200).describe("The person's full name."),
  profile_url: z.string().url().optional().describe("Their LinkedIn profile URL. Used for de-duplication."),
  headline: z.string().max(300).optional(),
  company: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).optional(),
  notes: z.string().max(2000).optional(),
  custom: z
    .record(z.string())
    .optional()
    .describe("Extra merge fields, available to templates as {{custom.key}}."),
};

/** Which capability a step's channel would need in order to send automatically. */
const CHANNEL_CAPABILITY: Partial<Record<StepChannel, CapabilityId>> = {
  linkedin_dm: "message.send",
  linkedin_comment: "comment.write",
};

export function registerOutreachTools(server: McpServer, ctx: ToolContext): void {
  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_prospect_add",
    title: "Add or Update a Prospect",
    description: `Add someone to the local prospect list, or update them if they are already there.

Identity is the profile URL when given, otherwise name plus company — so re-adding the same person updates their record rather than creating a duplicate.

Args: full_name (required), profile_url, headline, company, tags, notes, custom.

Returns JSON: { prospect, created }`,
    schema: z.object(prospectFields).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args, c) => {
      const { prospect, created } = await c.outreach.upsertProspect({ ...args, source: "manual" });
      return { prospect, created };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_prospect_import",
    title: "Import Prospects in Bulk",
    description: `Load a batch of prospects at once.

On sourcing: LinkedIn has no people-search API at any access tier, and scraping one is what gets a main account restricted — so this server does not find prospects, it tracks them. Get the rows from a real data provider (an Apollo, Clay or similar connector, a CRM export, a conference list) and pass them here.

Args:
  - prospects (array, required): objects with full_name plus optional profile_url, headline, company, tags, custom.

Returns JSON: { added, updated, total, index_pressure }`,
    schema: z
      .object({
        prospects: z
          .array(z.object(prospectFields).strict())
          .min(1)
          .max(200)
          .describe("Rows to import. Existing people are updated, not duplicated."),
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args, c) => {
      let added = 0;
      let updated = 0;
      for (const row of args.prospects) {
        const { created } = await c.outreach.upsertProspect({ ...row, source: "import" });
        if (created) added++;
        else updated++;
      }
      return {
        added,
        updated,
        total: added + updated,
        index_pressure: await c.outreach.indexPressure(),
      };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_prospect_update",
    title: "Update a Prospect's Status",
    description: `Change a prospect's status, tags, notes or merge fields.

Setting status to 'replied', 'won', 'lost', 'paused' or 'do_not_contact' STOPS their sequence immediately — nobody should receive step 3 after answering step 2. Marking replies is what makes the follow-up engine safe to run.

Args:
  - prospect_id (required)
  - status ('new'|'active'|'replied'|'won'|'lost'|'paused'|'do_not_contact', optional)
  - tags, notes, company, headline, custom (optional)

Returns JSON: { prospect }`,
    schema: z
      .object({
        prospect_id: z.string().min(1),
        status: z
          .enum(["new", "active", "replied", "won", "lost", "paused", "do_not_contact"])
          .optional(),
        tags: z.array(z.string().max(40)).optional(),
        notes: z.string().max(2000).optional(),
        company: z.string().max(200).optional(),
        headline: z.string().max(300).optional(),
        custom: z.record(z.string()).optional(),
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args, c) => {
      const { prospect_id, ...patch } = args;
      return { prospect: await c.outreach.updateProspect(prospect_id, patch) };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_sequence_define",
    title: "Define an Outreach Sequence",
    description: `Create (or replace) a named follow-up sequence.

Templates support {{first_name}}, {{full_name}}, {{company}}, {{headline}} and {{custom.anything}}. A placeholder with no value is a hard error at send time rather than a message that reads "Hi {{first_name}}" — so keep templates to fields your prospects actually have.

delay_days on each step counts from when the PREVIOUS step completed, not from enrollment.

Args:
  - name (string, required)
  - steps (array, required): { key, channel, delay_days, template, stop_if_replied? }

Returns JSON: { sequence }`,
    schema: z
      .object({
        name: z.string().min(1).max(100),
        steps: z
          .array(
            z
              .object({
                key: z.string().min(1).max(20).describe("Unique within the sequence, e.g. 's1'."),
                channel,
                delay_days: z.number().int().min(0).max(365),
                template: z.string().min(1).max(3000),
                stop_if_replied: z.boolean().default(true),
              })
              .strict()
          )
          .min(1)
          .max(10),
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args, c) => {
      return { sequence: await c.outreach.defineSequence(args.name, args.steps) };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_outreach_enroll",
    title: "Enroll a Prospect in a Sequence",
    description: `Start a prospect on a sequence. Step 1 becomes due after its delay_days (usually immediately).

Args: prospect_id (required), sequence_id (required).

Returns JSON: { prospect }`,
    schema: z.object({ prospect_id: z.string().min(1), sequence_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args, c) => {
      return { prospect: await c.outreach.enroll(args.prospect_id, args.sequence_id) };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_outreach_due",
    title: "What Outreach Is Due",
    description: `List prospects whose next sequence step is due now, most overdue first.

Purely local and read-only. This is the pull-based replacement for a scheduler: LinkedIn forbids automated and scheduled sends even for approved partners, so follow-ups are surfaced for a human to act on rather than fired on a timer.

Args: limit (number, optional, default 25).

Returns JSON: { due: [{ prospect_id, full_name, company?, sequence_id, step_index, next_due_at, overdue_days }], count }`,
    schema: z.object({ limit: z.number().int().min(1).max(200).default(25) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, c) => {
      const due = await c.outreach.due(Date.now(), args.limit);
      return { due, count: due.length };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_outreach_run",
    title: "Run the Next Outreach Step",
    description: `Work out a prospect's next step, render the message, and either send it or draft it.

WHAT NORMALLY HAPPENS: LinkedIn does not let a self-serve app send DMs — the Messages API is partner-only, and partners are barred from automated sends anyway. So this normally returns the finished message text plus the prospect's profile URL for you to send by hand. That is SUCCESS, not failure: report the drafted message to the user and offer to mark it sent. Only when a capability genuinely exists (a configured provider, or comment.write for a comment step) does it send automatically, and then it asks for confirmation first.

After the human sends it, call linkedin_outreach_mark_sent to advance the sequence. Until then the prospect sits at 'awaiting_send' and will not be offered again by linkedin_outreach_due.

Args:
  - prospect_id (string, required)
  - confirm_token (string, optional): only needed on the auto-send path.

Returns JSON:
  drafted  → { mode: 'drafted', text, draft_id, profile_url?, step, next_action }
  sent     → { mode: 'auto_sent', step, result }
  or       → { needs_confirmation: true, preview, confirm_token }`,
    schema: z.object({ prospect_id: z.string().min(1), confirm_token: confirmTokenField }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (args, c) => runStep(args.prospect_id, c, args.confirm_token),
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_outreach_mark_sent",
    title: "Mark an Outreach Step as Sent",
    description: `Confirm that a drafted step actually went out, advancing the sequence and scheduling the next step.

Call this after sending a drafted message by hand. Without it the prospect stays at 'awaiting_send' forever and nothing further is scheduled.

Args:
  - prospect_id (required)
  - step_key (optional): defaults to the step currently awaiting send.
  - sent_at (number, optional): epoch ms, defaults to now.

Returns JSON: { prospect, next_due_at?, sequence_state }`,
    schema: z
      .object({
        prospect_id: z.string().min(1),
        step_key: z.string().max(20).optional(),
        sent_at: z.number().int().optional(),
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (args, c) => {
      const prospect = await c.outreach.getProspect(args.prospect_id);
      if (!prospect?.enrollment) {
        throw new Error(`No enrolled prospect with id ${args.prospect_id}.`);
      }
      const sequence = await c.outreach.getSequence(prospect.enrollment.sequence_id);
      const step = sequence?.steps[prospect.enrollment.step_index];
      const stepKey = args.step_key ?? step?.key;
      if (!stepKey) throw new Error("There is no step awaiting a send for this prospect.");

      const lastDraft = [...prospect.enrollment.history]
        .reverse()
        .find((event) => event.step_key === stepKey);

      const updated = await c.outreach.complete(
        args.prospect_id,
        {
          step_key: stepKey,
          at: args.sent_at ?? Date.now(),
          channel: step?.channel ?? "manual",
          mode: "marked_sent_by_human",
          message_digest: lastDraft?.message_digest ?? "",
        },
        { advance: true }
      );

      return {
        prospect: updated,
        next_due_at: updated.enrollment?.next_due_at,
        sequence_state: updated.enrollment?.state,
      };
    },
  });
}

/**
 * The degradation path, and the heart of the outreach design.
 *
 * Everything that could refuse happens in prepare(): terminal status, finished
 * sequence, unresolved template placeholder. Only then do we ask whether a
 * send is even possible — and when it isn't, drafting is the successful
 * outcome, not an error.
 */
async function runStep(
  prospectId: string,
  c: ToolContext,
  confirmToken?: string
): Promise<Record<string, unknown>> {
  const prepared = await c.outreach.prepare(prospectId);
  const { prospect, step, text, digest } = prepared;

  const capabilityId = CHANNEL_CAPABILITY[step.channel];
  const capability = capabilityId ? await c.capabilities.get(capabilityId) : null;
  const canSend =
    capability !== null &&
    (capability.state === "available" || capability.state === "probable") &&
    // A DM can only be sent by a provider; LinkedIn's own API never allows it.
    (step.channel !== "linkedin_dm" || Boolean(c.provider?.sendMessage));

  if (!canSend) {
    const draft = await c.outreach.saveDraft({
      prospect_id: prospect.id,
      step_key: step.key,
      channel: step.channel,
      text,
      profile_url: prospect.profile_url,
    });

    await c.outreach.complete(prospectId, {
      step_key: step.key,
      at: Date.now(),
      channel: step.channel,
      mode: "drafted",
      message_digest: digest,
      draft_id: draft.id,
      detail: capability?.reason ?? "No automatic send path for this channel.",
    });

    return {
      mode: "drafted",
      step: { key: step.key, channel: step.channel, index: prospect.enrollment?.step_index },
      prospect: { id: prospect.id, full_name: prospect.full_name, company: prospect.company },
      text,
      draft_id: draft.id,
      profile_url: prospect.profile_url,
      duplicate: prepared.duplicate,
      why_not_sent: capability?.reason ?? "This channel has no automatic send path.",
      next_action: `Send this yourself, then call linkedin_outreach_mark_sent with prospect_id="${prospect.id}". This is the expected flow — nothing has gone wrong.`,
    };
  }

  // --- the auto-send path, only reachable with a real capability ---
  const spec = { action: "message.send" as const };
  const verdict = await c.guard.check(spec, { to: prospect.full_name, text }, confirmToken);
  if (!verdict.ok) {
    if (verdict.kind === "needs_confirmation") {
      return {
        needs_confirmation: true,
        message: verdict.message,
        confirm_token: verdict.confirm_token,
        preview: { to: prospect.full_name, channel: step.channel, text },
      };
    }
    throw new Error(verdict.message);
  }
  await c.guard.reserve(spec);

  const result = await c.provider!.sendMessage!({
    recipient: prospect.member_urn ?? prospect.profile_url ?? prospect.full_name,
    text,
  });

  await c.outreach.complete(prospectId, {
    step_key: step.key,
    at: Date.now(),
    channel: step.channel,
    mode: "auto_sent",
    message_digest: digest,
    detail: `via ${c.provider!.name}`,
  });

  await c.guard.audit.record({
    action: "message.send",
    outcome: "executed",
    target: prospect.id,
    payload_digest: digest,
    provider: c.provider!.name,
  });

  return { mode: "auto_sent", step: { key: step.key, channel: step.channel }, result };
}
