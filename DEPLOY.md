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

## Categorize reminders (optional)

The Worker can drop a reminder on a Google Calendar when transactions are
waiting to be categorized. It runs hourly and acts once a day, in the local
hour you choose. With no service account configured the job is a no-op, so this
is entirely opt-in.

### 1. Create a service account

In the [Google Cloud console](https://console.cloud.google.com/projectcreate):

1. Create a project, then enable the
   [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
2. APIs & Services → Credentials → Create credentials → Service account
3. On the new account, Keys → Add key → Create new key → JSON

A service account avoids the usual OAuth dance: there are no refresh tokens to
store and no consent screen, because access comes from sharing the calendar
with it directly.

### 2. Share the calendar with it

In Google Calendar, open the calendar's settings → "Share with specific people
or groups" → add the service account's email with **Make changes to events**.

### 3. Configure and deploy

Set `NAG_CALENDAR_ID`, `NAG_TIMEZONE`, the `NAG_HOUR_MIN`/`NAG_HOUR_MAX`
window and `NAG_SINCE_DAYS` in `wrangler.jsonc`, then store the key file as a secret:

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < service-account.json
npm run deploy
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NAG_CALENDAR_ID` | — | Calendar to write to. Unset disables the job. |
| `NAG_TIMEZONE` | `America/Los_Angeles` | IANA zone the reminder is scheduled in |
| `NAG_HOUR_MIN` | `8` | Earliest local hour the event may land on |
| `NAG_HOUR_MAX` | `20` | Latest local hour, inclusive. Set equal to the minimum for a fixed time. |

### How it behaves

- **Nothing pending, no event.** The reminder only exists when there is work.
- **A different hour each day.** The slot is drawn from the configured window,
  derived from the date so that every hourly run agrees on it — a per-run
  random draw would fire several times some days and never on others.
- **One event per day.** The event id is derived from the date, so a re-run
  updates that day's event rather than stacking duplicates.
- **The count is the current month.** It resets on the 1st, so the month you
  are budgeting is the month you are reminded about. Anything older is a
  footnote in the description, not the headline.
- **Transfers are ignored.** Moving money between your own accounts shows up
  as uncategorized in YNAB but never needs a category. In the budget this was
  built against, 77 of 80 "uncategorized" items were transfer legs.
- **The wording rotates daily.** Same mechanism as the hour: derived from the
  date, so it is stable within a day and different the next.
- **Daylight saving is handled.** Cloudflare crons are UTC, so the job runs
  hourly and acts only in the configured local hour, holding its wall-clock
  slot year round.

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
