import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { confirmTokenField, defineTool, type ToolContext } from "./shared.js";

/**
 * Direct messaging exists only when a provider is configured.
 *
 * There is deliberately no official-adapter version of this tool. LinkedIn's
 * Messages API is restricted to approved partners, and the partner agreement
 * separately forbids automated or scheduled sends — so for this server the
 * answer is always no, and a tool that can only ever refuse is worse than no
 * tool at all: it invites the model to plan around a capability that will
 * never arrive. Drafting through linkedin_outreach_run is the real workflow.
 *
 * Registration keys off env, which is fixed for the process lifetime, so
 * tools/list stays stable within a session.
 */
export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  if (!ctx.provider?.sendMessage) return;

  defineTool(server, ctx, {
    name: "linkedin_send_message",
    title: "Send a LinkedIn Message",
    description: `Send a direct message through the configured '${ctx.provider.name}' provider.

This does NOT go through LinkedIn's official API — that route is closed to this app — it goes to the endpoint configured in LINKEDIN_PROVIDER_URL. Reaching LinkedIn by unofficial means carries a real risk of the account being restricted, which is why it is off unless explicitly enabled.

Two-phase: call without confirm_token to preview the exact message and get a single-use token bound to that text; call again with the token to send. Subject to the same daily caps, pacing and kill switch as every other outward action.

Args:
  - recipient (string, required): profile URL or person URN.
  - text (string, required): the message body.
  - subject (string, optional).
  - confirm_token (string, optional).

Returns JSON: { threadId?, messageId? } — or { needs_confirmation: true, preview, confirm_token }.

For sequenced follow-up, prefer linkedin_outreach_run: it tracks what was sent and schedules the next step.`,
    schema: z
      .object({
        recipient: z.string().min(1).describe("Profile URL or urn:li:person: URN."),
        text: z.string().min(1).max(8000).describe("The message body."),
        subject: z.string().max(200).optional(),
        confirm_token: confirmTokenField,
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: false },
    capability: "message.send",
    fallbackTool: "linkedin_outreach_run",
    action: { action: "message.send" },
    previewOf: (args) => ({ recipient: args.recipient, subject: args.subject, text: args.text }),
    targetOf: (args) => args.recipient,
    handler: async (args, c) => {
      const result = await c.provider!.sendMessage!({
        recipient: args.recipient,
        text: args.text,
        subject: args.subject,
      });
      return { ...result, provider: c.provider!.name };
    },
  });
}
