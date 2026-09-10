import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, type ToolContext } from "./shared.js";

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "linkedin_auth_status",
    title: "Check LinkedIn Auth Status",
    description: `Report the health of the stored LinkedIn session: which account is connected, when the token expires, whether it can renew itself, which scopes LinkedIn actually granted, and the date a human must re-authorize by.

Makes no LinkedIn API call — it reads the stored token record — so it is cheap and safe to call at any time.

Args: none.

Returns JSON: { connected, member_id?, access_token_expires_at?, access_token_expires_in_days?, has_refresh_token, hard_deadline_at?, hard_deadline_in_days?, scopes?, missing_expected_scopes?, scopes_unknown?, warning?, reauthorize_path }

Use when: posting failed with an auth error, or you want to know how long the connection has left. For what the connection can actually DO (which endpoints LinkedIn will allow), use linkedin_capabilities instead.`,
    schema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, c) => {
      const status = await c.client.getAuthStatus();
      return status as unknown as Record<string, unknown>;
    },
  });
}
