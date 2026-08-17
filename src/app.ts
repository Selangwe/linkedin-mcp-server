/**
 * Express app + MCP wiring for linkedin-mcp-server.
 *
 * Kept separate from the process entrypoints (src/index.ts for local/Node
 * hosting, api/index.ts for Vercel) so both can share the exact same routes
 * without duplicating anything.
 */
import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LinkedInClient } from "./services/linkedin-client.js";
import { createTokenStore } from "./services/token-store.js";
import { registerLinkedInTools } from "./tools/linkedin-tools.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`ERROR: ${name} environment variable is required`);
  }
  return value;
}

const CLIENT_ID = requireEnv("LINKEDIN_CLIENT_ID");
const CLIENT_SECRET = requireEnv("LINKEDIN_CLIENT_SECRET");
const REDIRECT_URI = requireEnv("LINKEDIN_REDIRECT_URI");
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // optional but strongly recommended

const tokenStore = createTokenStore();
export const linkedInClient = new LinkedInClient(
  { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI },
  tokenStore
);

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "linkedin-mcp-server", version: "1.0.0" });
  registerLinkedInTools(server, linkedInClient);
  return server;
}

// In-memory pending OAuth states. Fine for a single-operator server since the
// flow completes within the same process lifetime on Node hosts. On Vercel
// (a fresh process per invocation) this still works because the callback
// request typically lands on a warm instance seconds after /start — but if
// you hit "Invalid or expired OAuth state", just retry /oauth/linkedin/start.
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

export const app = express();
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
      `LinkedIn connected successfully as ${info.name ?? info.sub}. You can close this tab — the token is now stored and will be refreshed automatically.`
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
  const server = buildMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

export const isAuthConfigured = Boolean(MCP_AUTH_TOKEN);
