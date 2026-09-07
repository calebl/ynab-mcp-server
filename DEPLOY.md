# Deploying as a remote MCP server

The stdio server in `src/index.ts` only works on the machine it runs on. To use
these tools from claude.ai or the Claude mobile app, deploy the Worker in
`src/worker/` to Cloudflare and add it as a custom connector.

The Worker holds the YNAB token server-side and puts GitHub sign-in in front of
it, restricted to a single account. That matters: the tool set includes create,
update and delete, so an unauthenticated endpoint would let anyone who finds the
URL rewrite the budget.

## One-time setup

### 1. Cloudflare account and login

```bash
npx wrangler login
```

### 2. Create the KV namespace for OAuth grants

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Create a GitHub OAuth app

At <https://github.com/settings/developers> → **New OAuth App**:

- **Homepage URL**: `https://ynab-mcp-server.<your-subdomain>.workers.dev`
- **Authorization callback URL**: `https://ynab-mcp-server.<your-subdomain>.workers.dev/callback`

You get the exact hostname after the first `npm run deploy`; deploy once, then
fill these in and update them if the name changes.

### 4. Set the allowed login

In `wrangler.jsonc`, set `ALLOWED_GITHUB_LOGIN` to your GitHub username. Only
that account can complete sign-in.

### 5. Set the secrets

Run each of these and paste the value when prompted. Secrets never go in
`wrangler.jsonc`.

```bash
npx wrangler secret put YNAB_API_TOKEN
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Optionally pin a default budget so tool calls can omit `budgetId`:

```bash
npx wrangler secret put YNAB_BUDGET_ID
```

### 6. Deploy

```bash
npm run deploy
```

## Add the connector in Claude

1. claude.ai → Settings → Connectors → **Add custom connector**
2. Name: `YNAB`
3. URL: `https://ynab-mcp-server.<your-subdomain>.workers.dev/mcp`
4. Connect, and complete the GitHub sign-in when prompted

Once connected it works everywhere you are signed in to Claude, including the
mobile app. Your Mac does not need to be running.

## Read-only mode

To expose only the tools that read data and none that change it, set
`YNAB_READ_ONLY` to `"true"` in `wrangler.jsonc` and redeploy. The write tools
disappear from `tools/list` entirely rather than failing when called.

## Local development

```bash
npm run dev:worker
```

Uses `.dev.vars` for secrets (git-ignored). The OAuth flow needs a real GitHub
app to complete end to end; without one you can still exercise the unauthorized
paths and the OAuth metadata endpoints.

## Layout

| Path | Purpose |
| --- | --- |
| `src/registry.ts` | The one tool list, shared by both entry points |
| `src/index.ts` | stdio entry (local Claude Code / Claude Desktop) |
| `src/worker/index.ts` | Worker entry: OAuth in front of the MCP handler |
| `src/worker/mcp.ts` | Builds the MCP server and serves `/mcp` |
| `src/worker/github-handler.ts` | GitHub sign-in and the single-user gate |
