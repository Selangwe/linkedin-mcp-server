import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import { handleLinkedInApiError } from "../services/errors.js";
import { AuditLog } from "../safety/audit.js";
import type { LinkedInClient } from "../services/linkedin-client.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { CapabilityId } from "../capabilities/types.js";
import type { SafetyGuard } from "../safety/guard.js";
import type { ActionSpec } from "../safety/config.js";
import type { OutreachEngine } from "../outreach/engine.js";
import type { OutreachProvider } from "../providers/types.js";
import type { PostHistory } from "../services/post-history.js";

export interface ToolContext {
  client: LinkedInClient;
  capabilities: CapabilityRegistry;
  guard: SafetyGuard;
  outreach: OutreachEngine;
  history: PostHistory;
  provider: OutreachProvider | null;
}

export type TextBlock = { type: "text"; text: string };

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated: response was ${text.length} characters, limit is ${CHARACTER_LIMIT}]`
  );
}

/**
 * A trailing warning block for successful results when the LinkedIn session is
 * heading for a deadline a human has to clear. Returned as its own content
 * block rather than appended to the first one, so the JSON payload callers
 * parse stays valid JSON.
 *
 * Never throws: a failed status lookup must not turn a successful post into an
 * error.
 */
export async function authWarningBlocks(client: LinkedInClient): Promise<TextBlock[]> {
  try {
    const status = await client.getAuthStatus();
    if (!status.warning) return [];
    return [{ type: "text", text: `⚠ LinkedIn auth: ${status.warning}` }];
  } catch {
    return [];
  }
}

/** The confirm_token every guarded tool accepts. Declared once so it reads alike everywhere. */
export const confirmTokenField = z
  .string()
  .optional()
  .describe(
    "Leave this out on the first call: the tool returns a preview and a confirm_token without doing anything. Pass that token back, with the identical content, to actually go ahead."
  );

type ToolResult = CallToolResult;

function json(payload: unknown): TextBlock {
  return { type: "text", text: truncate(JSON.stringify(payload, null, 2)) };
}

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<S>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Checked before the handler runs; a gated capability short-circuits with an explanation. */
  capability?: CapabilityId;
  /** Offered in the error when the capability is unavailable. */
  fallbackTool?: string;
  /** Present => this is an outward-facing action and passes the safety rails. */
  action?: ActionSpec;
  /** What the human is asked to approve. Defaults to the tool's own arguments. */
  previewOf?: (args: z.infer<z.ZodObject<S>>) => unknown;
  /** Identifies the target in the audit log. */
  targetOf?: (args: z.infer<z.ZodObject<S>>) => string | undefined;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/**
 * Registers a tool with the cross-cutting concerns applied once, in one place:
 * capability check, safety rails, audit, error formatting, and the trailing
 * auth warning.
 *
 * The rails live here rather than in LinkedInClient on purpose. The unofficial
 * provider does not go through the HTTP client at all, so a cap or a kill
 * switch enforced down there would be silently bypassed the moment a provider
 * is enabled. Every outward action reaches LinkedIn through a tool, so this is
 * the one chokepoint that covers both routes.
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<S>
): void {
  const callback = async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
      try {
        if (spec.capability) await ctx.capabilities.require(spec.capability);

        if (spec.action) {
          const blocked = await runGuard(ctx, spec, args);
          if (blocked) return blocked;
        }

        const result = await spec.handler(args, ctx);

        if (spec.action) {
          await ctx.guard.audit.record({
            action: spec.action.action,
            outcome: "executed",
            target: spec.targetOf?.(args),
            payload_digest: digestOf(spec, args),
            provider: ctx.provider?.name,
          });
        }

        return {
          content: [json(result), ...(await authWarningBlocks(ctx.client))],
          structuredContent: result,
        };
      } catch (error) {
        if (spec.action) {
          await ctx.guard.audit.record({
            action: spec.action.action,
            outcome: "failed",
            target: spec.targetOf?.(args),
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: handleLinkedInApiError(error, {
                capability: spec.capability,
                fallbackTool: spec.fallbackTool,
                scopes: await ctx.client.auth.grantedScopes().catch(() => undefined),
              }),
            },
          ],
        };
      }
  };

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.schema.shape,
      annotations: {
        readOnlyHint: spec.annotations.readOnlyHint ?? false,
        destructiveHint: spec.annotations.destructiveHint ?? false,
        idempotentHint: spec.annotations.idempotentHint ?? false,
        openWorldHint: spec.annotations.openWorldHint ?? true,
      },
    },
    // The SDK derives its callback's argument type from the raw shape, which
    // does not unify with a generic ZodObject<S> even though the two describe
    // the same object. The cast is confined to this one line; every caller is
    // still fully typed through ToolSpec.
    callback as never
  );
}

function digestOf<S extends z.ZodRawShape>(
  spec: ToolSpec<S>,
  args: z.infer<z.ZodObject<S>>
): string {
  return AuditLog.digest(spec.previewOf ? spec.previewOf(args) : stripConfirm(args));
}

function stripConfirm(args: Record<string, unknown>): Record<string, unknown> {
  const { confirm_token: _ignored, ...rest } = args;
  return rest;
}

/**
 * Runs the safety rails and turns a refusal into a tool result.
 *
 * A confirmation request is NOT an error — it is the normal first half of a
 * two-phase write, and marking it isError would push the caller into treating
 * a working flow as a failure. A cap, throttle or kill switch *is* an error:
 * nothing further will happen without the human doing something.
 */
async function runGuard<S extends z.ZodRawShape>(
  ctx: ToolContext,
  spec: ToolSpec<S>,
  args: z.infer<z.ZodObject<S>>
): Promise<ToolResult | null> {
  const action = spec.action as ActionSpec;
  const payload = spec.previewOf ? spec.previewOf(args) : stripConfirm(args);
  const token = (args as { confirm_token?: string }).confirm_token;

  let verdict = await ctx.guard.check(action, payload, token);
  if (verdict.ok) {
    // reserve() makes the final, atomic cap decision — check()'s read is
    // advisory because it also runs for previews, which must not spend budget.
    verdict = await ctx.guard.reserve(action);
    if (verdict.ok) return null;
  }

  await ctx.guard.audit.record({
    action: action.action,
    outcome: verdict.kind === "needs_confirmation" ? "drafted" : "blocked",
    target: spec.targetOf?.(args),
    detail: verdict.kind,
  });

  if (verdict.kind === "needs_confirmation") {
    const body = {
      needs_confirmation: true,
      message: verdict.message,
      confirm_token: verdict.confirm_token,
      preview: verdict.preview,
    };
    return { content: [json(body)], structuredContent: body };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${verdict.message}` }],
  };
}
