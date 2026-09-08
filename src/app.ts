/**
 * Express app + MCP wiring for linkedin-mcp-server.
 *
 * Kept separate from the process entrypoints (src/index.ts for local/Node
 * hosting, api/index.ts for Vercel) so both can share the exact same routes
 * without duplicating anything.
 *
 * Also hosts a minimal, single-user OAuth 2.1 authorization server
 * (RFC9728, RFC8414, RFC7591, RFC8707, PKCE) so this server can be
 * registered as a real "custom connector" in Claude's Settings, which only
 * supports no-auth or full OAuth — not a static bearer token. The static
 * MCP_AUTH_TOKEN keeps working as a master key (handy for MCP Inspector /
 * curl testing) and doubles as the consent gate on /authorize, since there's
 * exactly one operator and one LinkedIn account behind this server.
 */
import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LinkedInClient } from "./services/linkedin-client.js";
import { createTokenStore } from "./services/token-store.js";
import { createKeyValueStore } from "./services/kv-store.js";
import { OAuthStore, verifyPkce, escapeHtml } from "./services/oauth-store.js";
import { registerLinkedInTools, type ToolContext } from "./tools/index.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { SafetyGuard } from "./safety/guard.js";
import { OutreachEngine } from "./outreach/engine.js";
import { PostHistory } from "./services/post-history.js";
import { selectProvider } from "./providers/http.js";

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
export const isAuthConfigured = Boolean(MCP_AUTH_TOKEN);

/**
 * The capability cache, outreach records, safety counters and audit log all
 * live in the key-value store. On Vercel each invocation is a fresh process
 * with no persistent disk, so the file driver would silently discard every one
 * of them — a failed boot is far better than data that quietly disappears.
 */
if (process.env.VERCEL && (process.env.TOKEN_STORE_DRIVER || "file").toLowerCase() !== "kv") {
  throw new Error(
    "ERROR: running on Vercel requires TOKEN_STORE_DRIVER=kv. The file store has no persistent disk there, so tokens, outreach state, safety counters and the audit log would be lost between requests."
  );
}

const tokenStore = createTokenStore();
const capabilityKv = createKeyValueStore("capabilities");
const safetyKv = createKeyValueStore("safety");
const outreachKv = createKeyValueStore("outreach");
const historyKv = createKeyValueStore("history");

const provider = selectProvider();

export const linkedInClient = new LinkedInClient(
  { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI },
  tokenStore
);

const capabilities = new CapabilityRegistry(capabilityKv, linkedInClient.auth, provider);

/**
 * Built once at module scope and shared by every request. Each field is a thin
 * object over the stores — all I/O is lazy — so a fresh McpServer per request
 * costs nothing extra.
 */
const toolContext: ToolContext = {
  client: linkedInClient,
  capabilities,
  guard: new SafetyGuard(safetyKv),
  outreach: new OutreachEngine(outreachKv),
  history: new PostHistory(historyKv),
  provider,
};

const oauthStore = new OAuthStore();

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "linkedin-mcp-server", version: "1.0.0" });
  registerLinkedInTools(server, toolContext);
  return server;
}

// In-memory pending states for the LinkedIn-side OAuth (separate from the
// MCP-client-facing OAuth server below). Fine for a single-operator server
// since the flow completes within the same process lifetime on Node hosts.
// On Vercel (a fresh process per invocation) this still works because the
// callback request typically lands on a warm instance seconds after
// /oauth/linkedin/start — but if you hit "Invalid or expired OAuth state",
// just retry /oauth/linkedin/start.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

/** Canonical base URL of this deployment, used in OAuth metadata/redirects. */
function baseUrl(req: express.Request): string {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function unauthorized(req: express.Request, res: express.Response) {
  const base = baseUrl(req);
  res.set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: "Unauthorized" });
}

/**
 * Accepts either the static MCP_AUTH_TOKEN (master key, for Inspector/curl)
 * or a valid access token issued by this server's own /token endpoint.
 */
async function bearerAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string | undefined);

  if (!provided) {
    if (!isAuthConfigured) return next(); // local/dev only, no auth configured at all
    return unauthorized(req, res);
  }
  if (isAuthConfigured && provided === MCP_AUTH_TOKEN) return next();

  const record = await oauthStore.getAccessToken(provided);
  if (record) return next();

  return unauthorized(req, res);
}

export const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // for the /authorize consent form POST

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Session health for the operator: when the LinkedIn token expires, whether it
 * can renew itself, and the date a human has to re-authorize by. Reads only
 * stored state — no LinkedIn API call.
 */
app.get("/auth/status", bearerAuth, async (_req, res) => {
  try {
    res.json(await linkedInClient.getAuthStatus());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * What this connection can actually do, per capability. Same data as the
 * linkedin_capabilities tool, reachable over HTTP for when the MCP layer
 * itself is the thing misbehaving.
 */
app.get("/capabilities", bearerAuth, async (_req, res) => {
  try {
    res.json({
      capabilities: await capabilities.snapshot(),
      provider: provider ? provider.name : null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** The audit trail, including refused actions. */
app.get("/audit", bearerAuth, async (req, res) => {
  try {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    res.json({
      entries: await toolContext.guard.audit.recent({ limit: Number.isFinite(limit) ? limit : 50 }),
      kill_switch: await toolContext.guard.killSwitch(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * The emergency stop, reachable without an MCP client — so it can be hit from
 * a phone when something is going wrong.
 */
app.post("/admin/kill-switch", bearerAuth, async (req, res) => {
  try {
    const { on, reason } = req.body as { on?: boolean; reason?: string };
    if (typeof on !== "boolean") {
      res.status(400).json({ error: "Body must be {\"on\": true|false, \"reason\"?: string}" });
      return;
    }
    res.json(await toolContext.guard.setKillSwitch(on, reason));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// MCP client OAuth (RFC9728 / RFC8414 / RFC7591 / RFC8707) — this is what
// lets Claude's "Add custom connector" UI drive a real OAuth flow against
// this server instead of needing a manually-entered bearer token.
// ============================================================================

// RFC9728: Protected Resource Metadata — tells clients which authorization
// server(s) protect this MCP endpoint.
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

// RFC8414: Authorization Server Metadata.
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// RFC7591: Dynamic Client Registration. Deliberately open/unauthenticated —
// that's normal for DCR; the real gate is the consent step in /authorize.
// Always registers a public client (PKCE required, no client secret to
// manage) regardless of what the requester's metadata suggests.
app.post("/register", async (req, res) => {
  const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "redirect_uris must be a non-empty array of strings.",
    });
    return;
  }
  const clientName = typeof body.client_name === "string" ? body.client_name : undefined;
  const client = await oauthStore.registerClient({ client_name: clientName, redirect_uris: redirectUris as string[] });
  res.status(201).json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    grant_types: client.grant_types,
    response_types: client.response_types,
  });
});

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: "S256";
  resource?: string;
  scope?: string;
}

async function issueCodeAndRedirect(res: express.Response, params: AuthorizeParams) {
  const code = await oauthStore.createAuthorizationCode({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    resource: params.resource,
    scope: params.scope,
  });
  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (params.state) redirectUrl.searchParams.set("state", params.state);
  res.redirect(redirectUrl.toString());
}

// Authorization endpoint. Since this is a single-user server, "consent" is
// just proving you know MCP_AUTH_TOKEN (if one is configured) — there's no
// account system to log into. If MCP_AUTH_TOKEN isn't set at all (local dev
// only), this auto-approves with no form.
app.get("/authorize", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const { client_id, redirect_uri, response_type, state, code_challenge, resource, scope } = q;
  const code_challenge_method = q.code_challenge_method || "S256";

  if (response_type !== "code") {
    res.status(400).send("Only response_type=code is supported.");
    return;
  }
  if (!code_challenge || code_challenge_method !== "S256") {
    res.status(400).send("PKCE (code_challenge with code_challenge_method=S256) is required.");
    return;
  }
  if (!client_id) {
    res.status(400).send("Missing client_id.");
    return;
  }
  const client = await oauthStore.getClient(client_id);
  if (!client) {
    res.status(400).send("Unknown client_id. Register a client first via POST /register.");
    return;
  }
  if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send("redirect_uri does not match a registered redirect URI for this client.");
    return;
  }

  const params: AuthorizeParams = {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method: "S256",
    resource,
    scope,
  };

  if (!isAuthConfigured) {
    await issueCodeAndRedirect(res, params);
    return;
  }

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize linkedin-mcp-server</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:80px auto;padding:0 16px;color:#111}
  input{width:100%;padding:10px;margin:8px 0 16px;box-sizing:border-box;font-size:15px;border:1px solid #ccc;border-radius:6px}
  button{padding:10px 20px;font-size:15px;border:0;border-radius:6px;background:#0a66c2;color:#fff;cursor:pointer}
  button:hover{background:#004182}
  p{line-height:1.4}
</style></head>
<body>
<h2>Authorize access</h2>
<p><strong>${escapeHtml(client.client_name || client.client_id)}</strong> is requesting access to your
linkedin-mcp-server (LinkedIn profile + posting tools).</p>
<form method="POST" action="/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(client_id)}" />
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}" />
  <input type="hidden" name="state" value="${escapeHtml(state || "")}" />
  <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}" />
  <input type="hidden" name="code_challenge_method" value="S256" />
  <input type="hidden" name="resource" value="${escapeHtml(resource || "")}" />
  <input type="hidden" name="scope" value="${escapeHtml(scope || "")}" />
  <label for="token">Server access token (MCP_AUTH_TOKEN)</label>
  <input type="password" name="token" id="token" autofocus required autocomplete="off" />
  <button type="submit">Allow</button>
</form>
</body></html>`;
  res.type("html").send(html);
});

// Consent form submission.
app.post("/authorize", async (req, res) => {
  const body = req.body as Record<string, string | undefined>;
  const { client_id, redirect_uri, state, code_challenge, resource, scope, token } = body;
  const code_challenge_method = body.code_challenge_method || "S256";

  if (isAuthConfigured && token !== MCP_AUTH_TOKEN) {
    res.status(401).send("Invalid token. Go back and try again.");
    return;
  }
  if (!client_id || !redirect_uri || !code_challenge || code_challenge_method !== "S256") {
    res.status(400).send("Malformed authorization request.");
    return;
  }
  const client = await oauthStore.getClient(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send("Invalid client or redirect_uri.");
    return;
  }

  await issueCodeAndRedirect(res, {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method: "S256",
    resource,
    scope,
  });
});

/** RFC8707: if a resource is asserted anywhere in the flow, it must match this deployment's canonical MCP URI. */
function resourceMatches(req: express.Request, resource: string | undefined): boolean {
  if (!resource) return true; // not every client population sends this yet — validate only when present
  return resource === `${baseUrl(req)}/mcp`;
}

// Token endpoint: authorization_code (+ PKCE) and refresh_token grants.
app.post("/token", async (req, res) => {
  const body = req.body as Record<string, string | undefined>;
  const { grant_type } = body;

  if (grant_type === "authorization_code") {
    const { code, redirect_uri, client_id, code_verifier, resource } = body;
    if (!code || !code_verifier) {
      res.status(400).json({ error: "invalid_request", error_description: "code and code_verifier are required." });
      return;
    }
    const record = await oauthStore.consumeAuthorizationCode(code);
    if (!record) {
      res.status(400).json({ error: "invalid_grant", error_description: "Unknown, expired, or already-used authorization code." });
      return;
    }
    if ((client_id && record.client_id !== client_id) || record.redirect_uri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "client_id/redirect_uri mismatch." });
      return;
    }
    if (record.resource && !resourceMatches(req, resource ?? record.resource)) {
      res.status(400).json({ error: "invalid_target", error_description: "resource does not match this server." });
      return;
    }
    if (!verifyPkce(code_verifier, record.code_challenge)) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
      return;
    }

    const { token: accessToken, expiresIn } = await oauthStore.issueAccessToken({
      client_id: record.client_id,
      scope: record.scope,
      resource: record.resource,
    });
    const refreshToken = await oauthStore.issueRefreshToken({
      client_id: record.client_id,
      scope: record.scope,
      resource: record.resource,
    });
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: record.scope,
    });
    return;
  }

  if (grant_type === "refresh_token") {
    const { refresh_token, client_id, resource } = body;
    if (!refresh_token) {
      res.status(400).json({ error: "invalid_request", error_description: "refresh_token is required." });
      return;
    }
    const record = await oauthStore.getRefreshToken(refresh_token);
    if (!record || (client_id && record.client_id !== client_id)) {
      res.status(400).json({ error: "invalid_grant", error_description: "Unknown refresh token." });
      return;
    }
    if (!resourceMatches(req, resource)) {
      res.status(400).json({ error: "invalid_target", error_description: "resource does not match this server." });
      return;
    }
    const { token: accessToken, expiresIn } = await oauthStore.issueAccessToken({
      client_id: record.client_id,
      scope: record.scope,
      resource: resource || record.resource,
    });
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token, // not rotated — kept simple for a single-operator server
      scope: record.scope,
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// ============================================================================
// LinkedIn-side OAuth (this server acting as the OAuth *client* against
// LinkedIn's API) — unchanged from before the MCP-client OAuth layer above.
// ============================================================================

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
    const status = await linkedInClient.getAuthStatus();

    const fmt = (epochMs?: number) =>
      epochMs === undefined ? "unknown" : new Date(epochMs).toISOString().slice(0, 10);

    // Be honest about which of the two worlds this session is in. LinkedIn
    // only issues refresh tokens to apps approved for programmatic refresh;
    // without one this connection silently dies when the access token expires.
    const renewal = status.has_refresh_token
      ? `<p>A refresh token was stored, so the access token renews automatically. You will need to
           repeat this step by <strong>${escapeHtml(fmt(status.refresh_token_expires_at))}</strong>
           — LinkedIn does not extend that deadline on refresh.</p>`
      : `<p class="warn"><strong>Warning: LinkedIn issued no refresh token for this session.</strong>
           This connection cannot renew itself and will stop working on
           <strong>${escapeHtml(fmt(status.access_token_expires_at))}</strong>, after which posting
           fails until you repeat this step. To avoid a 60-day re-auth cycle, get the LinkedIn app
           approved for programmatic refresh tokens.</p>`;

    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>LinkedIn connected</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#111;line-height:1.5}
  .warn{background:#fff4e5;border-left:4px solid #d97706;padding:12px 16px;border-radius:4px}
  code{background:#f3f4f6;padding:2px 5px;border-radius:4px}
</style></head>
<body>
<h2>LinkedIn connected</h2>
<p>Authenticated as <strong>${escapeHtml(info.name ?? info.sub)}</strong>.
   Access token valid until <strong>${escapeHtml(fmt(status.access_token_expires_at))}</strong>.</p>
${renewal}
<p>Check this any time with the <code>linkedin_auth_status</code> tool or
   <code>GET /auth/status</code>. You can close this tab.</p>
</body></html>`);
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

// A GET on /mcp with no/invalid auth should still carry the discovery
// header so clients that probe here first can find the metadata endpoint.
app.get("/mcp", bearerAuth, (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});
