#!/usr/bin/env node
/**
 * Local/Node entrypoint for linkedin-mcp-server (Fly.io, Railway, a VPS, or
 * stdio for local MCP clients). For Vercel, see api/index.ts instead — it
 * imports the same `app` from ./app.js without calling listen().
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function runHTTP(): Promise<void> {
  const { app, isAuthConfigured } = await import("./app.js");
  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`linkedin-mcp-server listening on :${port}`);
    console.error(`  MCP endpoint:      http://localhost:${port}/mcp`);
    console.error(`  One-time OAuth:    http://localhost:${port}/oauth/linkedin/start${isAuthConfigured ? "?token=<MCP_AUTH_TOKEN>" : ""}`);
    if (!isAuthConfigured) {
      console.error("  WARNING: MCP_AUTH_TOKEN is not set — /mcp and /oauth/linkedin/start are unauthenticated.");
    }
  });
}

async function runStdio(): Promise<void> {
  const { buildMcpServer } = await import("./app.js");
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("linkedin-mcp-server running via stdio");
}

const transportMode = process.env.TRANSPORT || "http";
const run = transportMode === "stdio" ? runStdio : runHTTP;

run().catch((err) => {
  console.error("Server error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
