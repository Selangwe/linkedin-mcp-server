# linkedin-mcp-server

An MCP server that posts document/"carousel" content (e.g. a Gamma PDF export) to a
personal LinkedIn profile via LinkedIn's official REST API. Built for the
"post Gamma carousels to LinkedIn automatically" workflow, but the tools are
generic enough for any PDF-carousel-to-LinkedIn use case.

It also hosts the LinkedIn OAuth flow itself, so you don't need a separate
public server just to catch the redirect — this one *is* that server.

## Tools

| Tool | What it does |
|---|---|
| `linkedin_get_profile` | Read-only. Confirms which account is authenticated. |
| `linkedin_upload_document` | Uploads a PDF (from a URL) to LinkedIn as a document asset. Doesn't publish anything. |
| `linkedin_create_post` | Publishes a post referencing an already-uploaded document. Irreversible. |
| `linkedin_post_carousel` | Does both steps in one call: download PDF → upload → publish. Irreversible. |

Use `linkedin_upload_document` + `linkedin_create_post` separately if you want
a review step between uploading and going live; use `linkedin_post_carousel`
for full one-shot automation.

## 1. Create the LinkedIn app (one-time, ~5 minutes)

1. Go to https://www.linkedin.com/developers/apps → **Create app**.
2. Fill in the required fields. LinkedIn requires the app be associated with
   a Company Page even for personal-profile posting — if you don't have one,
   create a minimal one for this purpose.
3. On the **Products** tab, request **"Share on LinkedIn"**. This is
   self-serve for the scopes this server needs (`openid`, `profile`,
   `w_member_social`) — no manual review wait.
4. On the **Auth** tab, note the **Client ID** and **Client Secret**, and add
   an **Authorized redirect URL** of:
   ```
   https://<your-deployed-host>/oauth/linkedin/callback
   ```
   (must match `LINKEDIN_REDIRECT_URI` exactly, including scheme/host/path)

## 2. Deploy the server

Two supported paths — pick based on where you want to host this.

### Option A: Vercel (serverless)

Vercel Functions have no persistent disk, so the file-based token store
won't survive between requests. Use the built-in Redis-backed store instead:

1. Push this repo to GitHub, then **import it in Vercel** (New Project → your repo). It's picked up automatically — `api/index.ts` is the serverless entrypoint, `vercel.json` routes everything there.
2. In the Vercel project, go to **Storage → Marketplace Database Providers → Upstash → Redis** and create one. This injects Redis env vars into your project automatically.
3. Add the rest of the environment variables (Project Settings → Environment Variables):
   ```
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   LINKEDIN_REDIRECT_URI=https://<your-vercel-domain>/oauth/linkedin/callback
   TOKEN_STORE_DRIVER=kv
   MCP_AUTH_TOKEN=<a long random string>
   ```
4. Redeploy so the new env vars take effect.

The 4.5 MB request-body limit on Vercel Functions doesn't affect this server
— the PDF is fetched by an outbound request from `linkedin_post_carousel`
(you pass a `pdf_url`, not the file itself), not received as an inbound
upload. The 300s default duration on every plan is comfortably more than an
upload+publish needs.

### Option B: A host with a real disk (Fly.io, Railway, a VPS)

```bash
npm install
npm run build
npm start   # or: node dist/index.js
```

Set these environment variables (see `.env.example`):

```
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
LINKEDIN_REDIRECT_URI=https://<your-deployed-host>/oauth/linkedin/callback
TOKEN_STORE_DRIVER=file
TOKEN_STORE_PATH=./data/tokens.json   # point this at a persistent volume
MCP_AUTH_TOKEN=<a long random string> # protects /mcp and /oauth/linkedin/start
PORT=3000
TRANSPORT=http
```

Either way, you need a public HTTPS URL (for the OAuth redirect and for
Claude to reach `/mcp`).

## 3. Authorize (one-time human step)

Open, in a browser where you're logged into the LinkedIn account you want to
post as:

```
https://<your-deployed-host>/oauth/linkedin/start?token=<MCP_AUTH_TOKEN>
```

Click **Allow**. You'll land back on `/oauth/linkedin/callback`, which
exchanges the code for an access + refresh token and saves them to
`TOKEN_STORE_PATH`. The access token is refreshed automatically by the
server on subsequent tool calls (refresh tokens last ~1 year), so this step
shouldn't need repeating often.

## 4. Register as a connector

This server hosts its own minimal OAuth 2.1 authorization server
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/register`, `/authorize`, `/token` — RFC9728, RFC8414, RFC7591, RFC8707,
PKCE), so it can be added as a real **custom connector** wherever a client
only supports "no auth" or full OAuth rather than a static bearer header
(e.g. Claude's Settings → Connectors → Add custom connector UI):

1. Add `https://<your-deployed-host>/mcp` as a custom connector's URL and
   choose OAuth. Most clients handle Dynamic Client Registration and PKCE
   automatically from there — no Client ID/Secret to paste in.
2. When the client opens the authorization page in a browser, you'll be
   asked to enter `MCP_AUTH_TOKEN`. That's the entire "login" step — this
   server is single-user, so proving you know that value is the consent
   gate. Submit it and you'll be redirected back with the connector
   connected.
3. Access tokens this layer issues are short-lived (1 hour) and refreshed
   automatically by the client using the refresh token from step 2 — no
   further action needed under normal use.

If your client only supports a static bearer token (e.g. MCP Inspector, or
`curl`), you can skip all of the above and just send
`Authorization: Bearer <MCP_AUTH_TOKEN>` directly — the old path still
works unchanged and is treated as a master key by the same `/mcp` route.

## Local development

```bash
npm run dev   # tsx watch, auto-reloads on save
```

For local testing you can run with `TRANSPORT=stdio` and connect via any
stdio-based MCP client (e.g. `npx @modelcontextprotocol/inspector`), though
you'll still need `LINKEDIN_REDIRECT_URI` reachable from your browser to
complete the OAuth step — a tunnel like `ngrok` works well for this during
development.

## Notes / limitations

- Single-user by design (one LinkedIn account, one token file). Don't expose
  this server publicly without `MCP_AUTH_TOKEN` set — it protects `/mcp`,
  `/oauth/linkedin/start`, and doubles as the consent gate on the connector
  OAuth server's `/authorize` page.
- The connector-facing OAuth layer (`/register`, `/authorize`, `/token`) is
  intentionally separate from the LinkedIn-facing OAuth flow
  (`/oauth/linkedin/start` / `/callback`) — the former lets *clients* (like
  Claude) authenticate to *this server*; the latter lets *this server*
  authenticate to *LinkedIn*. Don't confuse the two `code`/`token` exchanges
  if you're debugging.
- Registered OAuth clients, authorization codes, and issued access/refresh
  tokens are stored the same way as the LinkedIn token (file or Redis, via
  `TOKEN_STORE_DRIVER`) — see `src/services/kv-store.ts` /
  `src/services/oauth-store.ts`. Access tokens expire in 1 hour; refresh
  tokens don't expire but aren't rotated, matching this server's
  single-operator threat model. If you ever need to revoke everything,
  clear the `data/oauth-*` files (file driver) or flush those key prefixes
  in Redis (kv driver).
- Set `PUBLIC_BASE_URL` (e.g. `https://your-app.vercel.app`) if you're
  behind a proxy that doesn't set `X-Forwarded-Proto`/`Host` correctly —
  the OAuth metadata endpoints otherwise infer the base URL from the
  incoming request.
- LinkedIn posts published via `linkedin_create_post` / `linkedin_post_carousel`
  cannot be edited or deleted through this API — only from the LinkedIn UI.
  There's no "undo" tool here on purpose; double-check the caption and PDF
  before calling.
- LinkedIn's native ads-only "Carousel" format has no organic API equivalent;
  what these tools produce is a document post, which LinkedIn renders as a
  swipeable carousel in the feed — visually the same thing users mean by
  "LinkedIn carousel."
- `LINKEDIN_API_VERSION` in `src/constants.ts` is a calendar-month version
  string LinkedIn requires on every REST call. Bump it periodically per
  LinkedIn's versioning docs.
