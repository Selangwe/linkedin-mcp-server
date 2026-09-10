import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createComment } from "../services/domains/social-actions.js";
import { parsePostUrn } from "../services/urn.js";
import { confirmTokenField, defineTool, type ToolContext } from "./shared.js";

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "linkedin_comment_reply",
    title: "Comment on a LinkedIn Post or Reply to a Comment",
    description: `Post a comment on a LinkedIn post, or a reply to an existing comment.

IMPORTANT — read before promising this to a user. This server CANNOT list the comments on a post: that needs LinkedIn's r_member_social permission, which is closed and not accepting applications. So there is no way to discover what to reply to. The target has to be pasted in by a human, as a post URL or a comment permalink copied from the LinkedIn UI.

Whether writing works at all is uncertain until proven: the permission table lists w_member_social (which this app holds), but the endpoint sits under the Community Management API and may need that product too. Run linkedin_capabilities with probe='safe' to classify it without posting anything.

Two-phase: call without confirm_token to see exactly what will be posted and get a single-use token bound to that text; call again with the token to post it. Irreversible through this API — comments can only be deleted from the LinkedIn UI.

Args:
  - target (string, required): a LinkedIn post URL, a comment permalink, or a
    urn:li:activity: / urn:li:ugcPost: / urn:li:share: / urn:li:comment: value.
    Pointing at a comment URN makes this a reply to that comment.
  - text (string, required): the comment body, plain text.
  - confirm_token (string, optional).

Returns JSON: { commentUrn, targetUrn } — or { needs_confirmation: true, preview, confirm_token }.

If this is gated: draft the reply with linkedin_outreach_run instead and post it by hand.`,
    schema: z
      .object({
        target: z
          .string()
          .min(1)
          .describe("Post URL, comment permalink, or a LinkedIn URN. A comment URN makes this a reply."),
        text: z.string().min(1).max(1250).describe("The comment text, plain text."),
        confirm_token: confirmTokenField,
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: false },
    capability: "comment.write",
    fallbackTool: "linkedin_outreach_run",
    action: { action: "comment.reply" },
    previewOf: (args) => ({ target: parseQuietly(args.target), text: args.text }),
    targetOf: (args) => parseQuietly(args.target),
    handler: async (args, c) => {
      const parsed = parsePostUrn(args.target);
      const actorUrn = await c.client.getMemberUrn();
      const result = await createComment(c.client.http, {
        targetUrn: parsed.urn,
        actorUrn,
        text: args.text,
      });
      return {
        ...result,
        kind: parsed.kind === "comment" ? "reply" : "comment",
        note: "This API cannot delete comments — remove it from the LinkedIn UI if needed.",
      };
    },
  });
}

/**
 * Parsing for the preview/audit path, which must not throw: a bad target
 * should fail in the handler with the parser's own detailed message, not
 * inside digest computation.
 */
function parseQuietly(target: string): string {
  try {
    return parsePostUrn(target).urn;
  } catch {
    return target;
  }
}
