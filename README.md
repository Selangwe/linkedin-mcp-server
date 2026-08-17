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

This is a plain Node/Express app — deploy it anywhere that gives you:
- a public HTTPS URL (for the OAuth redirect and for Claude to reach `/mcp`)
- **persistent disk** at the path you set `TOKEN_STORE_PATH` to (Fly.io
  volumes, Railway volumes, a small VPS, or any host with a real filesystem
  all work; most serverless/edge platforms do NOT persist disk between
  invocations and will break token storage — avoid those unless you swap
  `TokenStore` for a real database)

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
TOKEN_STORE_PATH=./data/tokens.json   # point this at a persistent volume
MCP_AUTH_TOKEN=<a long random string> # protects /mcp and /oauth/linkedin/start
PORT=3000
TRANSPORT=http
```

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

Add `https://<your-deployed-host>/mcp` as a custom MCP connector, sending
`Authorization: Bearer <MCP_AUTH_TOKEN>` on every request. Once connected,
the four `linkedin_*` tools become available to any session that has this
connector enabled.

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
  this server publicly without `MCP_AUTH_TOKEN` set.
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
