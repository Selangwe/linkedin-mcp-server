import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeCommentWrite } from "../capabilities/probe.js";
import { createComment } from "../services/domains/social-actions.js";
import { parsePostUrn } from "../services/urn.js";
import { confirmTokenField, defineTool, type ToolContext } from "./shared.js";

export function registerDiagnosticsTools(server: McpServer, ctx: ToolContext): void {
  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_capabilities",
    title: "What Can This LinkedIn Connection Actually Do",
    description: `Report, per capability, whether this server can do it — and if not, why not and what to use instead.

This is the tool to reach for whenever a LinkedIn call fails with a permission error, or before promising a user that something is possible. LinkedIn gates its API by product as well as by OAuth scope, so holding a scope does not guarantee an endpoint will answer.

States: 'available' (proven by a real successful call), 'probable' (scope present or a probe passed), 'gated' (the endpoint exists but this app lacks the product/scope), 'unsupported' (no API at any tier), 'provider_only', 'unknown'.

Args:
  - probe ('none' | 'safe' | 'live', optional, default 'none'):
      none — read cached and static state. No network calls.
      safe — ask LinkedIn which scopes this token really holds, and classify
             comment.write by aiming a well-formed comment at a share that
             cannot exist. Creates nothing.
      live — settle comment.write for certain by posting a REAL comment on a
             post you own, returning its URN so you can delete it. Requires
             live_target and a confirm_token.
  - live_target (string, optional): required for probe='live'. A LinkedIn post URL or URN you own.
  - confirm_token (string, optional): required for probe='live'.

Returns JSON: { capabilities: [...], scopes?, probe? }

Use when: any tool reports a permission problem, or you need to tell a user honestly what is and isn't possible.`,
    schema: z
      .object({
        probe: z
          .enum(["none", "safe", "live"])
          .default("none")
          .describe("How hard to check. 'none' is free and makes no network call."),
        live_target: z
          .string()
          .optional()
          .describe("For probe='live': a LinkedIn post URL or URN belonging to the authenticated member."),
        confirm_token: confirmTokenField,
      })
      .strict(),
    annotations: { readOnlyHint: false, openWorldHint: true },
    handler: async (args, c) => {
      if (args.probe === "live") {
        return runLiveProbe(args.live_target, c, args.confirm_token);
      }

      const out: Record<string, unknown> = {};

      if (args.probe === "safe") {
        try {
          const introspection = await c.client.auth.introspectToken();
          out.scopes = introspection.scopes;
          out.token_status = introspection.status;
        } catch (error) {
          out.scopes_error = `Could not introspect the token: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        out.probe = await probeCommentWrite(c.client.http, c.client.auth, c.capabilities);
      } else {
        const scopes = await c.client.auth.grantedScopes();
        if (scopes) out.scopes = scopes;
      }

      out.capabilities = await c.capabilities.snapshot();
      out.provider = c.provider ? c.provider.name : null;
      return out;
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_kill_switch",
    title: "LinkedIn Kill Switch",
    description: `Stop, or resume, every outward-facing LinkedIn action this server can take — publishing, commenting, sending, inviting.

While the switch is on, every guarded tool refuses immediately. Reads (profile, auth status, capabilities, outreach drafts) keep working.

Args:
  - on (boolean, required): true to stop everything, false to resume.
  - reason (string, optional): recorded and shown in the refusal message.

Returns JSON: { on, reason?, set_at }

Note: if the LINKEDIN_KILL_SWITCH environment variable is set, the switch is held on and cannot be cleared from here — that is the emergency stop, and it deliberately cannot be undone by the same automation it was set to stop.`,
    schema: z
      .object({
        on: z.boolean().describe("true to halt all outward actions, false to resume."),
        reason: z.string().max(200).optional().describe("Why, for the audit log."),
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args, c) => {
      const state = await c.guard.setKillSwitch(args.on, args.reason);
      await c.guard.audit.record({
        action: "kill_switch",
        outcome: args.on ? "blocked" : "executed",
        detail: `kill switch turned ${args.on ? "ON" : "OFF"}${args.reason ? `: ${args.reason}` : ""}`,
      });
      return state as unknown as Record<string, unknown>;
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_audit_log",
    title: "LinkedIn Action Audit Log",
    description: `List what this server has done on the member's behalf, including the actions it refused.

Blocked entries are usually the interesting ones: they show a cap, throttle or kill switch doing its job. Message bodies are stored as a digest, not as text.

Args:
  - limit (number, optional, default 50, max 500).
  - action (string, optional): filter, e.g. 'post.publish', 'message.send', 'comment.reply'.
  - since (number, optional): epoch ms lower bound.

Returns JSON: { entries: [{ id, at, action, outcome, target?, payload_digest?, detail? }], usage }`,
    schema: z
      .object({
        limit: z.number().int().min(1).max(500).default(50),
        action: z.string().optional().describe("Filter to one action type."),
        since: z.number().int().optional().describe("Epoch ms lower bound."),
      })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, c) => {
      const entries = await c.guard.audit.recent(args);
      const kill = await c.guard.killSwitch();
      return { entries, kill_switch: kill };
    },
  });
}

/**
 * The only probe that proves comment.write, because it is the only one that
 * actually writes. Guarded like any other send, and it hands back the created
 * comment's URN so the human can remove it.
 */
async function runLiveProbe(
  target: string | undefined,
  c: ToolContext,
  confirmToken?: string
): Promise<Record<string, unknown>> {
  if (!target) {
    throw new Error(
      "probe='live' needs live_target: a LinkedIn post URL or URN belonging to you. It posts a real comment on that post, so pick one of your own."
    );
  }

  const parsed = parsePostUrn(target);

  // This is a real write, so it goes through the same rails as any send —
  // defineTool can't do it for us because probe='none' must stay unguarded.
  const spec = { action: "probe.live" } as const;
  const verdict = await c.guard.check(spec, { target: parsed.urn }, confirmToken);
  if (!verdict.ok) {
    if (verdict.kind === "needs_confirmation") {
      return {
        needs_confirmation: true,
        message: `${verdict.message} This posts a REAL comment on ${parsed.urn}, visible to anyone who can see that post.`,
        confirm_token: verdict.confirm_token,
        preview: verdict.preview,
      };
    }
    throw new Error(verdict.message);
  }
  await c.guard.reserve(spec);

  const actorUrn = await c.client.getMemberUrn();
  const result = await createComment(c.client.http, {
    targetUrn: parsed.urn,
    actorUrn,
    text: "Testing API access — this comment can be deleted.",
  });

  await c.capabilities.record(
    "comment.write",
    "available",
    `live probe created ${result.commentUrn || "a comment"} on ${parsed.urn}`
  );

  return {
    probe: "live",
    capability: "comment.write",
    state: "available",
    created_comment_urn: result.commentUrn,
    note: "A real comment was posted. Delete it from the LinkedIn UI — this API cannot.",
    capabilities: await c.capabilities.snapshot(),
  };
}
