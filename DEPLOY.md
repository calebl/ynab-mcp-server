# Deploying as a remote MCP server

The stdio server in `src/index.ts` only works on the machine it runs on. To use
these tools from claude.ai, the Claude mobile app, or another MCP client that
supports remote servers, deploy the Worker in `src/worker/` to Cloudflare and
add it as a custom connector.

The Worker holds the YNAB token server-side and puts GitHub sign-in in front of
it, restricted to a single GitHub account. These are separate layers:
GitHub sign-in controls who may connect, while the YNAB Personal Access Token
controls which YNAB account the server reaches. They answer different
questions, and neither substitutes for the other. The Worker uses one
server-wide YNAB token, so anyone admitted through GitHub reaches the
deployer's YNAB account, money, and every plan available to that token—not
their own YNAB account.
`ynab_list_plans` lists all of those plans, and a caller-supplied `planId`
overrides the optional `YNAB_PLAN_ID` default. That matters: the tool set
includes create, update and delete, so an unauthenticated endpoint would let
anyone who finds the URL rewrite those plans.

## One-time setup

### 1. Create your local Wrangler config and log in

The repository provides a template; the real config is git-ignored because it
contains your account-specific KV namespace ID.

```bash
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
```

### 2. Create the KV namespace for OAuth state and grants

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into your local `wrangler.jsonc`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`. Do not edit `wrangler.example.jsonc` with your
account-specific value.

### 3. Create a GitHub OAuth app

At <https://github.com/settings/developers> → **New OAuth App**:

- **Homepage URL**: `https://ynab-mcp-server.<your-subdomain>.workers.dev`
- **Authorization callback URL**: `https://ynab-mcp-server.<your-subdomain>.workers.dev/callback`

You get the exact hostname after the first `npm run deploy`; deploy once, then
fill these in and update them if the name changes.

### 4. Set deployment values and secrets

Run each command and paste the value when prompted. Keep deployment-specific
values out of `wrangler.jsonc`; Wrangler stores them remotely on the Worker.
Only the GitHub username stored in `ALLOWED_GITHUB_LOGIN` can complete sign-in.

```bash
npx wrangler secret put ALLOWED_GITHUB_LOGIN
npx wrangler secret put YNAB_API_TOKEN
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Optionally pin a default plan so tool calls can omit `planId`:

```bash
npx wrangler secret put YNAB_PLAN_ID
```

`YNAB_BUDGET_ID` is deprecated but still accepted as an alias; there is no
removal date. Use `YNAB_PLAN_ID` for new deployments.

Set the operator-owned TypeSafe credential as a Worker secret:

```bash
npx wrangler secret put TYPESAFE_API_KEY
```

Category suggestions remain off unless you also add
`"YNAB_AI_CATEGORIZATION": "true"` under `vars` in `wrangler.jsonc`. Both
settings are required to expose `ynab_suggest_categories`; the key never
belongs in `wrangler.jsonc` or a tool argument.

Optionally, add `"YNAB_AI_TYPICAL_PAYEES": "true"` under `vars` to send each
category's most frequent payee names to the model. It improves accuracy on your
own filing habits but discloses aggregated payee history to TypeSafe, so it is
off unless set.

### 6. Deploy

```bash
npm run deploy
```

## Add the connector in Claude

1. claude.ai → Settings → Connectors → **Add custom connector**
2. Name: `YNAB`
3. URL: `https://ynab-mcp-server.<your-subdomain>.workers.dev/mcp`
4. Connect, check the address on the approval page and choose **Approve**, then
   complete the GitHub sign-in

Once connected it works everywhere you are signed in to Claude, including the
mobile app. Your Mac does not need to be running.

Any MCP client that supports remote servers with OAuth can connect the same
way: give it the `/mcp` URL and complete the sign-in it opens.

## Approving MCP clients

MCP clients register themselves with the Worker automatically, so the Worker
cannot know in advance which ones are yours. Every permitted sign-in therefore
stops at an approval page before GitHub. It shows the name the client gave
itself and the full address the grant will be sent to, with **Approve** and
**Deny**.
Clients choose their own names, so check the address: only approve a sign-in
you just started, going to your client's callback. Denying sends the client an
`access_denied` error and issues nothing.

The pending sign-in is stored in `OAUTH_KV` and tied to your browser with a
short-lived cookie, so a link someone else prepared cannot complete it.

### Restricting redirects (optional)

Set `ALLOWED_REDIRECT_URIS` to the exact callback URIs of the clients you use,
separated by commas or whitespace. Requests for any other redirect are refused
before the approval page, and checked again just before a grant is issued.
`http://` loopback redirects (`localhost`, `127.0.0.1`, `[::1]`, any port)
stay allowed, because local clients pick their port at runtime. The approval
page still appears for allowed clients. Leave the setting unset or blank to
allow any client, subject to approval.

Set it as a plain var in your `wrangler.jsonc` `vars`, or as a secret; either
works:

```bash
npx wrangler secret put ALLOWED_REDIRECT_URIS
```

Example callback URIs (check your client's documentation; the approval page
also shows the exact URI a client asked for):

| Client | Redirect URI |
| --- | --- |
| Claude (claude.ai, desktop, and mobile apps) | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` |
| ChatGPT connectors | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Claude Code, MCP Inspector, and other local clients | `http://localhost:<port>/...` (loopback, always allowed) |

For example, to allow only Claude plus local clients:

```bash
echo "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback" | npx wrangler secret put ALLOWED_REDIRECT_URIS
```

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

Set the deployment-specific calendar ID and service-account key as Worker
secrets. Configure `NAG_TIMEZONE`, the `NAG_HOUR_MIN`/`NAG_HOUR_MAX` window,
and `NAG_SINCE_DAYS` in `wrangler.jsonc` if their defaults do not suit you:

```bash
npx wrangler secret put NAG_CALENDAR_ID
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
  as uncategorized in YNAB but never needs a category. In the plan this was
  built against, 77 of 80 "uncategorized" items were transfer legs.
- **The wording rotates daily.** Same mechanism as the hour: derived from the
  date, so it is stable within a day and different the next.
- **Daylight saving is handled.** Cloudflare crons are UTC, so the job runs
  hourly and acts only in the configured local hour, holding its wall-clock
  slot year round.

## TypeSafe category preview (optional)

When enabled as described above, `ynab_suggest_categories` proposes categories
for eligible uncategorized outflows. It answers from exact-payee history and a
personal prior trained on the plan's own history first, and calls the model
only for what is left. It is a preview only and never writes to YNAB. Applying a proposal requires a separate explicit write; see
[Category suggestions](./README.md#category-suggestions-optional) for the apply
tool and its safeguards.

See [Category suggestions](./README.md#category-suggestions-optional) for the
authoritative data-sharing contract, model and cost limits, and evaluation
caveats.

## Auto-budget service (optional)

The Worker can run an auto-budget service on its hourly cron trigger. Each run
asks YNAB only for what changed since the last run (delta requests), works out
what it would do, and alerts you about spending:

- **Categorize** an unapproved outflow when every one of its payee's last
  12 months of transactions (at least three) used the same category.
- **Approve** a categorized transaction from a payee you have approved at least
  three times before. Transfers, splits, matched pairs, possible duplicates
  and anything over the per-transaction cap are left for you.
- **Assign** Ready to Assign to this month's underfunded targets, largest
  shortfall first, then spend what is left on next month's targets.
- **Alert** through Pushover the moment a category goes negative, Ready to
  Assign goes negative, or a bank import link breaks. Once a day it sends a
  digest with categories on pace to overspend, bills due within three days
  that their category cannot cover, your unapproved and uncategorized backlog,
  and a summary of what it would do.

**This version never writes to YNAB.** It runs in shadow mode: every decision is
recorded in an audit log in D1, and the digest reports it, but nothing in your
plan changes. Its YNAB client can only send GET requests. Later versions will
add write stages that you switch on one at a time.

The caps the write stages will enforce already shape the shadow decisions, so
the log shows what a live run would do: at most $250 per transaction, at most
min(Ready to Assign, total underfunded, $5,000) assigned per day, and at most
25 transactions and 10 categories per run. Transactions it changes will carry a
purple flag.

### 1. Create the D1 database

```bash
npx wrangler d1 create ynab-autobudget
```

Add the binding it prints to `wrangler.jsonc`, keeping the binding name
`AUTOBUDGET_DB`, then create the tables:

```jsonc
"d1_databases": [
  {
    "binding": "AUTOBUDGET_DB",
    "database_name": "ynab-autobudget",
    "database_id": "<id from wrangler d1 create>",
    "migrations_dir": "migrations"
  }
]
```

```bash
npx wrangler d1 migrations apply ynab-autobudget --remote
```

Run the `migrations apply` command again after any upgrade that adds a file
under `migrations/`.

### 2. Set up Pushover

Create an application at [pushover.net](https://pushover.net/apps/build), then
store its API token and your user key as secrets:

```bash
npx wrangler secret put PUSHOVER_APP_TOKEN
npx wrangler secret put PUSHOVER_USER_KEY
```

Without both secrets the service still runs and records decisions, but sends
nothing. Alerts it could not deliver are retried on the next run.

### 3. Switch it on and deploy

Set `AUTOBUDGET_MODE` to `"shadow"` in `wrangler.jsonc` and deploy:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTOBUDGET_MODE` | `off` | `off`, `shadow` or `live`. This version runs `live` as `shadow`. |
| `AUTOBUDGET_TIMEZONE` | `NAG_TIMEZONE`, then `America/Los_Angeles` | IANA zone for the daily digest |
| `AUTOBUDGET_DIGEST_HOUR` | `8` | Local hour (0-23) the digest is sent |
| `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY` | — | Secrets. Pushover credentials; unset sends nothing. |

The service uses `YNAB_PLAN_ID` (or the deprecated `YNAB_BUDGET_ID`). If the
token cannot see that plan, each run records an error that names the plans it
can see, and Pushover alerts you once.

### How it behaves

- **YNAB_READ_ONLY is a hard stop.** With `YNAB_READ_ONLY` set to `"true"`, the
  service stays in shadow mode whatever `AUTOBUDGET_MODE` says.
- **Pause from any MCP client.** `ynab_autobudget_pause` stops every scheduled
  run until you resume it with `paused: false`. It changes only the service's
  own state, so it stays available in read-only mode.
- **Small, predictable API use.** A run makes about five YNAB requests and
  never more than 20. YNAB allows 200 an hour per token, shared with every
  other client of that token, so a separate token for the Worker keeps the
  budgets apart.
- **The first run reads 12 months of transactions.** Later runs read only
  changes. On the Workers Free plan, a large first read can exceed the 10 ms
  CPU limit for cron triggers; the Workers Paid plan raises it. Steady-state
  runs are small.
- **One run at a time.** A lease in D1 stops an overlapping run or dry run
  from interleaving with a scheduled one.
- **The audit log shows changes, not repeats.** A decision is recorded again
  only when it differs from the last one for that transaction or category.
  Runs, decisions and alerts are kept for 13 months.

### MCP tools

When `AUTOBUDGET_DB` is bound, the Worker also serves these tools to any MCP
client. They are not part of the npm package, which has no D1 database.

| Tool | What it does |
| --- | --- |
| `ynab_autobudget_status` | Mode and why, pause state, last run, decisions recorded in the last 24 hours, and the caps |
| `ynab_autobudget_plan` | Dry run: syncs and shows what the service would do right now and the alerts it would raise. Records and sends nothing. |
| `ynab_autobudget_pause` | Pauses the service, or resumes it with `paused: false` |

## Read-only mode

To expose only the tools that read data and none that change it, set
`YNAB_READ_ONLY` to `"true"` in `wrangler.jsonc` and redeploy. The write tools
disappear from `tools/list` entirely rather than failing when called. The
TypeSafe preview is registered as read-only and remains available in this mode
only when both its feature flag and secret are configured. The auto-budget
service stays in shadow mode, and its tools stay available.

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
| `src/worker/autobudget/` | The auto-budget service and its MCP tools |
| `migrations/` | D1 schema for the auto-budget service |
| `src/worker/github-handler.ts` | GitHub sign-in and the single-user gate |
