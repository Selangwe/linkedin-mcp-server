#!/usr/bin/env node
/**
 * linkedin-mcp-server
 *
 * MCP server that lets an agent post document/"carousel" content (e.g. a
 * Gamma export) to a single LinkedIn personal profile via LinkedIn's
 * official REST API ("Share on LinkedIn" product).
 *
 * This server also hosts the LinkedIn OAuth flow itself (see /oauth/linkedin/*),
 * which solves the "no public redirect URI" problem you'd otherwise hit doing
 * this OAuth dance from a script with no server of its own.
 */
import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LinkedInClient } from "./services/linkedin-client.js";
import { TokenStore } from "./services/token-store.js";
import { registerLinkedInTools } from "./tools/linkedin-tools.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} environment variable is required`);
    process.exit(1);
  }
  return value;
}

const CLIENT_ID = requireEnv("LINKEDIN_CLIENT_ID");
const CLIENT_SECRET = requireEnv("LINKEDIN_CLIENT_SECRET");
const REDIRECT_URI = requireEnv("LINKEDIN_REDIRECT_URI");
const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || "./data/tokens.json";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // optional but strongly recommended

const tokenStore = new TokenStore(TOKEN_STORE_PATH);
const linkedInClient = new LinkedInClient(
  { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI },
  tokenStore
);

function buildServer(): McpServer {
  const server = new McpServer({ name: "linkedin-mcp-server", version: "1.0.0" });
  registerLinkedInTools(server, linkedInClient);
  return server;
}

// In-memory pending OAuth states (fine for a single-operator server; short-lived).
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function bearerAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!MCP_AUTH_TOKEN) return next(); // no auth configured — allow (fine for local/dev only)
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string);
  if (provided !== MCP_AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // --- One-time human setup: visit this in a browser, logged into LinkedIn ---
  app.get("/oauth/linkedin/start", bearerAuth, (_req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now() + STATE_TTL_MS);
    res.redirect(linkedInClient.buildAuthorizationUrl(state));
  });

  // --- LinkedIn redirects here after the human clicks "Allow" ---
  app.get("/oauth/linkedin/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;
    if (error) {
      res.status(400).send(`LinkedIn authorization failed: ${error} — ${error_description ?? ""}`);
      return;
    }
    const expiry = state ? pendingStates.get(state) : undefined;
    if (!state || !expiry || expiry < Date.now()) {
      res.status(400).send("Invalid or expired OAuth state. Restart at /oauth/linkedin/start.");
      return;
    }
    pendingStates.delete(state);

    try {
      await linkedInClient.exchangeCodeForTokens(code);
      const info = await linkedInClient.getUserInfo();
      res.send(
        `LinkedIn connected successfully as ${info.name ?? info.sub}. You can close this tab — the MCP server now has a stored access + refresh token.`
      );
    } catch (err) {
      res.status(500).send(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // --- MCP endpoint (stateless streamable HTTP: new transport per request) ---
  app.post("/mcp", bearerAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`linkedin-mcp-server listening on :${port}`);
    console.error(`  MCP endpoint:      http://localhost:${port}/mcp`);
    console.error(`  One-time OAuth:    http://localhost:${port}/oauth/linkedin/start${MCP_AUTH_TOKEN ? "?token=<MCP_AUTH_TOKEN>" : ""}`);
    if (!MCP_AUTH_TOKEN) {
      console.error("  WARNING: MCP_AUTH_TOKEN is not set — /mcp and /oauth/linkedin/start are unauthenticated.");
    }
  });
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("linkedin-mcp-server running via stdio");
}

const transportMode = process.env.TRANSPORT || "http";
if (transportMode === "stdio") {
  runStdio().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
} else {
  runHTTP().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
