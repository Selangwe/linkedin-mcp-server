import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMemberPostAnalytics } from "../services/domains/analytics.js";
import { defineTool, type ToolContext } from "./shared.js";

const DAY_MS = 86_400_000;

export function registerAnalyticsTools(server: McpServer, ctx: ToolContext): void {
  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_post_history",
    title: "Posts Published Through This Server",
    description: `List the posts this server has published, newest first. Local record — it covers what went out through this server, not everything on the profile.

Args:
  - limit (number, optional, default 25, max 200).

Returns JSON: { posts: [{ urn, url, at, title?, excerpt?, kind }], count }

Use when: you need a post's URN or URL (to comment on it, for instance), or you want to see recent posting cadence.`,
    schema: z.object({ limit: z.number().int().min(1).max(200).default(25) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, c) => {
      const posts = await c.history.recent(args.limit);
      return { posts, count: posts.length };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_analytics_summary",
    title: "LinkedIn Analytics Summary",
    description: `Summarise this account's posting activity, and report honestly on which engagement metrics are actually obtainable.

What you get depends on access. LinkedIn's member post analytics (impressions, members reached, reactions, comments, reshares) live behind the r_member_postAnalytics scope, which only comes with the Community Management API — granted to registered legal organizations, not individuals. When that scope is present this tool returns the real numbers; when it isn't, it returns local cadence data and says plainly that the metrics are unavailable, rather than inventing them.

Args:
  - post_urn (string, optional): analytics for one post instead of the account.
  - days (number, optional, default 30): window for the local cadence summary.

Returns JSON: { metrics_available, metrics?, reason?, cadence: {...}, linkedin_ui_url }

Never present the cadence numbers as engagement metrics — they count posts, not impressions.`,
    schema: z
      .object({
        post_urn: z.string().optional().describe("Limit to a single post's analytics."),
        days: z.number().int().min(1).max(365).default(30),
      })
      .strict(),
    annotations: { readOnlyHint: true },
    handler: async (args, c) => {
      const capability = await c.capabilities.get("analytics.member_post");
      const out: Record<string, unknown> = {
        linkedin_ui_url: "https://www.linkedin.com/analytics/creator/content/",
      };

      if (capability.state === "available" || capability.state === "probable") {
        try {
          out.metrics = await getMemberPostAnalytics(c.client.http, { postUrn: args.post_urn });
          out.metrics_available = true;
        } catch (error) {
          // Asking was worth it, but don't let a gated endpoint fail the tool —
          // the local half below is still useful and still true.
          out.metrics_available = false;
          out.reason = `LinkedIn refused the analytics request: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      } else {
        out.metrics_available = false;
        out.reason = capability.reason;
        out.remedy = capability.remedy;
      }

      out.cadence = await cadence(c, args.days);
      return out;
    },
  });
}

/** Posting rhythm from the local history — real data, and clearly not engagement. */
async function cadence(c: ToolContext, days: number): Promise<Record<string, unknown>> {
  const posts = await c.history.recent(200);
  const since = Date.now() - days * DAY_MS;
  const inWindow = posts.filter((p) => p.at >= since);

  return {
    window_days: days,
    posts_in_window: inWindow.length,
    posts_per_week: Number(((inWindow.length / days) * 7).toFixed(2)),
    last_post_at: posts[0]?.at,
    days_since_last_post: posts[0] ? Math.floor((Date.now() - posts[0].at) / DAY_MS) : undefined,
    note: "Counts posts published through this server. These are not impression or engagement figures.",
  };
}
