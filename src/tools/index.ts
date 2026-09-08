import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./shared.js";
import { registerAuthTools } from "./auth-tools.js";
import { registerProfileTools } from "./profile-tools.js";
import { registerPostTools } from "./post-tools.js";
import { registerCommentTools } from "./comment-tools.js";
import { registerAnalyticsTools } from "./analytics-tools.js";
import { registerOutreachTools } from "./outreach-tools.js";
import { registerDiagnosticsTools } from "./diagnostics-tools.js";
import { registerMessagingTools } from "./messaging-tools.js";

export type { ToolContext } from "./shared.js";

/**
 * Registers every tool.
 *
 * Which tools exist is decided by static configuration only — never by
 * runtime capability state. A fresh McpServer is built per request, so a
 * capability-dependent tool list would mean a KV round trip before every
 * tools/list, and a tool that silently disappears mid-conversation is a worse
 * failure than one that explains why it can't help. Tools whose capability is
 * unavailable stay listed and return an actionable error naming a fallback.
 *
 * The exception is a tool whose only possible answer is "no": there is no
 * linkedin_send_dm here, because LinkedIn allows no self-serve route to one.
 * Its job is done by linkedin_outreach_run, which drafts. Messaging tools
 * appear only when a provider is configured, and that comes from env, which is
 * stable for the process lifetime.
 */
export function registerLinkedInTools(server: McpServer, ctx: ToolContext): void {
  registerAuthTools(server, ctx);
  registerProfileTools(server, ctx);
  registerPostTools(server, ctx);
  registerCommentTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  registerOutreachTools(server, ctx);
  registerDiagnosticsTools(server, ctx);
  registerMessagingTools(server, ctx);
}
