# linkedin-mcp-server

An MCP server for working a personal LinkedIn profile: publishing document
("carousel") posts, commenting, and running prospect follow-up — plus an honest
account of what LinkedIn's API will and won't let a self-serve app do.

It also hosts the LinkedIn OAuth flow itself, so you don't need a separate
public server just to catch the redirect — this one *is* that server.

## What LinkedIn actually allows

Read this before planning a workflow around it. Most of the interesting
capabilities are gated, and the gate is LinkedIn's access model, not this code.

| Capability | Status | Why |
|---|---|---|
| Publish posts / carousels | **Works** | `w_member_social`, self-serve "Share on LinkedIn" |
| Read own profile | **Works** | OpenID Connect `profile` scope |
| Comment / reply to a comment | **Probably — probe it** | The permission table lists `w_member_social`, but the endpoint sits under the Community Management API and may need that product too. Run `linkedin_capabilities` with `probe: "safe"` to classify it without posting anything. |
| Read comments on your posts | **No** | Needs `r_member_social`, a closed permission: "access requests are not being accepted at this time". So comment URNs must be pasted in from the browser. |
| Post/profile analytics | **No** | `memberCreatorPostAnalytics` needs `r_member_postAnalytics`, granted only via the Community Management API — "registered legal organizations for commercial use cases only". |
| Send / read DMs | **No** | The Messages API is restricted to approved partners, *and* partners are separately barred from automated or scheduled sends. |
| People search / prospecting | **No** | LinkedIn exposes no people-search endpoint at any tier. The Connections API is restricted and first-degree only. |

Two consequences worth internalising:

- **Outreach works by drafting, not sending.** `linkedin_outreach_run` renders
  the next message and hands it to you to send, then tracks it once you confirm.
  That is the normal, successful path — not a failure mode.
- **There is no scheduler, deliberately.** Follow-ups are pull-based
  (`linkedin_outreach_due`), because LinkedIn forbids automated sends even for
  approved partners.

Anything marked "No" above is only reachable through an unofficial provider you
run yourself. That is off by default — see [Unofficial provider](#unofficial-provider).

## Tools

**Posting**

| Tool | What it does |
|---|---|
| `linkedin_upload_document` | Uploads a PDF (from a URL) to LinkedIn as a document asset. Publishes nothing. |
| `linkedin_create_post` | Publishes a post referencing an uploaded document. Two-phase, irreversible. |
| `linkedin_post_carousel` | Download → upload → publish in one call. Two-phase, irreversible. |
| `linkedin_comment_reply` | Comments on a post, or replies to a comment. Target is a pasted URL or URN. |

**Outreach**

| Tool | What it does |
|---|---|
| `linkedin_prospect_add` / `_import` / `_update` | Maintain the local prospect list. Marking someone `replied` stops their sequence. |
| `linkedin_sequence_define` | Define a multi-step follow-up sequence with templates and delays. |
| `linkedin_outreach_enroll` | Start a prospect on a sequence. |
| `linkedin_outreach_due` | What follow-up is due now. |
| `linkedin_outreach_run` | Render the next step — sends it if that is possible, otherwise drafts it. |
| `linkedin_outreach_mark_sent` | Confirm a drafted step went out; advances the sequence. |

**Diagnostics and safety**

| Tool | What it does |
|---|---|
| `linkedin_auth_status` | Token expiry, granted scopes, re-authorization deadline. No API call. |
| `linkedin_get_profile` | Confirms which account is authenticated. |
| `linkedin_capabilities` | Per-capability verdict, why, and what to use instead. Optional live probing. |
| `linkedin_post_history` | Posts published through this server. |
| `linkedin_analytics_summary` | Real metrics when the scope exists; local cadence and an honest reason when it doesn't. |
| `linkedin_kill_switch` | Halt or resume every outward action. |
| `linkedin_audit_log` | What was done and what was refused. |

`linkedin_send_message` appears only when an unofficial provider is configured.

## Safety model

The target is normally the operator's main LinkedIn account, so the defaults
are conservative and the rails sit in the tool layer — where they also cover
the unofficial provider, which bypasses the HTTP client entirely.

- **Two-phase confirmation.** Every outward action previews first and returns a
  single-use token *bound to a digest of the exact payload*. Editing the text
  invalidates the token, so what you approved is what goes out. It is not a
  `confirm: true` boolean, because a model would simply set one.
- **Daily caps** (15 messages, 20 comments, 3 posts, 40 total) and a **90s
  minimum gap** between paced actions. The throttle refuses with a retry time
  rather than sleeping.
- **Kill switch**, as a tool, an HTTP route (`POST /admin/kill-switch`, so you
  can hit it from a phone), and an env var that cannot be cleared from a tool.
- **Audit log** of every action including refusals, storing message digests
  rather than message bodies.

All tunable — see `.env.example`.

## Unofficial provider

LinkedIn licenses no third party to send member-to-member DMs or search people;
services that appear to do so drive LinkedIn's internal endpoints with a
session cookie, which breaks the User Agreement and can get an account
restricted.

So this repo ships the *seam*, not the mechanism: set `LINKEDIN_PROVIDER_URL`
to an endpoint you run, and requests are forwarded there HMAC-signed. Enabling
it needs two variables — `LINKEDIN_UNOFFICIAL_PROVIDER=http` and
`LINKEDIN_UNOFFICIAL_ACK=i-accept-tos-risk` — so a copied `.env` cannot switch
it on by accident. With it off, the capability report says so and nothing
changes.

## Development

```bash
npm install
npm test          # unit tests, no credentials needed
npm run typecheck # includes api/, which the build's tsconfig excludes
npm run build
```

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
exchanges the code for tokens and saves them to `TOKEN_STORE_PATH`. That page
tells you exactly when this session expires — read it, because the answer
depends on your LinkedIn app.

### Token lifetime & re-auth

There are two cases, and they behave very differently:

- **Your app is approved for programmatic refresh** (LinkedIn returned a
  refresh token). The server refreshes the access token by itself, ahead of
  expiry, and retries once if LinkedIn rejects a token mid-call. You still have
  to repeat step 3 roughly **once a year** — refresh tokens last ~365 days and
  LinkedIn does *not* extend that deadline when it issues a new access token.
- **It isn't** (no refresh token returned). Nothing renews. Everything works for
  ~60 days and then every tool call fails until you repeat step 3. The callback
  page warns you about this explicitly, as does every successful tool result
  once the deadline gets close.

Check where you stand at any time — neither of these makes a LinkedIn API call:

```bash
curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://<your-host>/auth/status
```

or ask the model to call the `linkedin_auth_status` tool. Both report
`hard_deadline_at` — the date by which a human must re-authorize — plus a
`warning` string that is only present when action is actually needed.

Successful tool results carry that warning as an extra content block starting
within 14 days of the deadline (tune with `LINKEDIN_AUTH_WARN_DAYS`), so a
looming expiry surfaces while you're working rather than as a surprise failure.

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
