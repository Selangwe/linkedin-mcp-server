import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, type ToolContext } from "./shared.js";

export function registerProfileTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "linkedin_get_profile",
    title: "Get LinkedIn Profile",
    description: `Fetch the authenticated member's basic profile from LinkedIn's OpenID Connect userinfo endpoint. Read-only; confirms which account this server is acting as.

Args: none.

Returns JSON: { sub, name?, given_name?, family_name?, email?, picture?, locale? }

Note on scope: this is the ONLY profile data LinkedIn exposes to a self-serve app. Full profile fields (positions, skills, connection counts) and other members' profiles are not available at any access tier this app can reach.

Use when: verifying the right account is connected before publishing, or you need the member's own URN/id.`,
    schema: z.object({}).strict(),
    annotations: { readOnlyHint: true },
    capability: "profile.read",
    handler: async (_args, c) => {
      const info = await c.client.getUserInfo();
      return info as unknown as Record<string, unknown>;
    },
  });
}
