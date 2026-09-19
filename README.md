# ynab-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI
assistant read and modify a [YNAB](https://ynab.com) budget. Forked from
[calebl/ynab-mcp-server](https://github.com/calebl/ynab-mcp-server).

The server talks to the YNAB API through the official
[`ynab` SDK](https://github.com/ynab/ynab-sdk-js). Your Personal Access Token
lives in an environment variable and is never sent to the model.

It runs two ways from one codebase:

- **Local (stdio)** — a child process of Claude Code or Claude Desktop on your
  own machine. Simplest, but only works on that machine while it is running.
- **Remote (Cloudflare Worker)** — deployed behind GitHub sign-in and added to
  claude.ai as a custom connector, so it works from the web and the mobile app
  with your computer switched off. See [DEPLOY.md](./DEPLOY.md).

Both entry points register the same tools from `src/registry.ts`, so a tool
written once is available in both.

## Setup

Get a Personal Access Token from <https://api.ynab.com/#personal-access-tokens>, then:

```bash
npm install
npm run build
```

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `YNAB_API_TOKEN` | yes | Personal Access Token used for every API call |
| `YNAB_BUDGET_ID` | no | Default budget, so tools can omit `budgetId`. Find it with `ynab_list_budgets`. |
| `TYPESAFE_API_KEY` | no | Operator-owned TypeSafe credential. Required, but not sufficient, to enable category suggestions. |
| `YNAB_AI_CATEGORIZATION` | no | Set to `"true"` together with `TYPESAFE_API_KEY` to expose the opt-in suggestion tool. |

### Local: Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp-server/dist/index.js"],
      "env": {
        "YNAB_API_TOKEN": "your-token",
        "YNAB_BUDGET_ID": "your-budget-id"
      }
    }
  }
}
```

### Remote: phone and claude.ai

The stdio server above cannot be reached from a phone. To use these tools from
claude.ai or the Claude mobile app, deploy `src/worker/` to Cloudflare Workers
and add it as a custom connector. [DEPLOY.md](./DEPLOY.md) has the full walk
through; the shape of it:

1. `npx wrangler login`, then `npx wrangler kv namespace create OAUTH_KV`
2. `npm run deploy` once to learn your `*.workers.dev` hostname
3. Create a GitHub OAuth app whose callback is `https://<host>/callback`
4. Set `ALLOWED_GITHUB_LOGIN` in `wrangler.jsonc` to the one account allowed in
5. `npx wrangler secret put` for `YNAB_API_TOKEN`, `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`, then `npm run deploy` again
6. Add `https://<host>/mcp` as a custom connector in claude.ai

The YNAB token stays a Worker secret and never reaches the client. GitHub sign-in
controls **who may connect** to the remote Worker; the YNAB Personal Access
Token controls **which YNAB account it reaches**. They answer different
questions, and neither substitutes for the other. The Worker uses one
server-wide YNAB token, so anyone admitted through the GitHub gate reaches the
deployer's YNAB account, money, and every budget available to that token—not
their own YNAB account.
`ynab_list_budgets` lists all of those budgets, and a caller-supplied `budgetId`
overrides the optional `YNAB_BUDGET_ID` default. Any GitHub account other than
`ALLOWED_GITHUB_LOGIN` is refused. This matters because the tool set can create
and delete transactions—an unauthenticated endpoint would grant access to those
budgets to anyone who found the URL.

## Why not YNAB OAuth?

YNAB OAuth is deliberately not supported. Its token exchange requires a client
secret even with PKCE; an open-source package cannot ship a secret, so a local
package cannot honestly implement the authorization-code flow
([OAuth application requirements](https://api.ynab.com/#oauth-applications)).
The only secretless flow YNAB documents is the implicit grant, which expires in
two hours with no refresh
([OAuth application requirements](https://api.ynab.com/#oauth-applications)).
YNAB recommends a Personal Access Token for an individual accessing their own
account
([Personal Access Tokens](https://api.ynab.com/#personal-access-tokens)).

Setting `YNAB_READ_ONLY` to `"true"` drops every write tool from the tool list,
which is worth considering for a connector you will mostly use on a phone.

## Tools

Budget-scoped tools take an optional `budgetId` that falls back to
`YNAB_BUDGET_ID`. Optional tool inputs may be `null`; the server treats `null`
the same as omitting that input. All monetary values — in both directions — are
plain currency amounts, never YNAB's milliunits; conversion happens in
`src/tools/money.ts`.

### Reading

| Tool | What it does |
| --- | --- |
| `ynab_list_budgets` | Every budget on the account. Run this first to find a budget ID. |
| `ynab_budget_summary` | A month at a glance: income, budgeted, activity, Ready to Assign, plus categories split into `overspent`, `underfunded` (goal not yet met) and `positive_balance`. Hidden and deleted categories are excluded. |
| `ynab_list_accounts` | Accounts with balances. `includeClosedAccounts` to see closed ones. |
| `ynab_list_categories` | Categories grouped by category group, with goal info. |
| `ynab_list_payees` | Payees, for resolving payee IDs. |
| `ynab_list_months` | Every budget month with its summary numbers. |
| `ynab_list_scheduled_transactions` | Scheduled/recurring transactions. |
| `ynab_get_transactions` | Transactions filtered by `sinceDate`, `accountId`, `categoryId`, `payeeId`, `type` (`all`/`uncategorized`/`unapproved`) and `limit` (default 100). |
| `ynab_get_unapproved_transactions` | Unapproved transactions, optionally from `sinceDate` onward. |
| `ynab_suggest_categories` | Opt-in, read-only category previews for unapproved, uncategorized ordinary outflows. Deleted and categorized rows are dropped in default mode; approved, reconciled, balance-adjustment, transfer, split, and inflow rows are skipped as applicable. |

### Category suggestions (optional)

`ynab_suggest_categories` is off by default. To expose it, set both an
operator-owned `TYPESAFE_API_KEY` and `YNAB_AI_CATEGORIZATION=true`, then restart
the server. The API key is read from the environment (or a Worker secret), never
from a tool argument. Omit `transactionIds`, pass `null`, or pass an empty
array to fetch unapproved transactions and retain only uncategorized rows;
provide IDs to inspect only those transactions. In default mode, the tool
checks every retained row for deterministic eligibility and then applies
`limit` to the first eligible outflows in YNAB's returned order. Skipped rows
do not consume the limit.

The tool is a dry-run preview: it never writes to YNAB, approves a transaction,
or changes the behavior of `ynab_update_transaction`. It first handles exact
facts in code—dropping deleted rows and handling approved or reconciled rows,
YNAB balance adjustments, transfers, splits, inflows, existing categories, and
hidden/internal categories. In default mode, `transactions` contains only the
eligible rows inspected, `transaction_count` is that row count, and
`eligible_transaction_count` reports all eligible rows available before the
limit. The top-level `skipped` object reports `total_count` and a `count` plus
`transaction_ids` for each reason: `skipped_approved`, `skipped_reconciled`,
`skipped_balance_adjustment`, `skipped_transfer`, `skipped_split`,
`skipped_inflow`, and `skipped_already_categorized`. With explicit
`transactionIds`, every non-deleted fetched row remains an individual result,
including rows carrying a `skipped_*` status; deleted rows are omitted.
Payee history uses the latest 12 months, capped at 50 qualifying exact-payee
rows. The history rule applies only when at least three such rows all use the
same still-eligible category; every eligible row without that unanimous signal
goes to TypeSafe's pinned `jev-1.13.0` System One model in batches of ten. Any
disagreement between the history plurality and the model forces
`needs_review`. Every inspected eligible row includes a status, content
fingerprint, proposed category, confidence, winning probability, up to three
alternatives, and history summary. Applying a suggestion remains a separate
human decision using `ynab_update_transaction`.

Enabling this feature sends the transaction's display payee, imported/original
payee, memo, amount, date, and account name/type/on-budget status, plus visible
category group and category names, to **TypeSafe as a third-party processor**.
It does not send YNAB UUIDs, balances, goals, approval/cleared state, or raw
transaction history. TypeSafe's published Jev 1.13 price at the time of this
release is **$0.042 per million input tokens; output tokens are free**. The tool
returns preflight estimates, actual token usage, and projected cost on each run
and refuses requests over its per-call token/cost ceilings. Pricing and
provider limits can change; check <https://docs.typesafe.ai/models>.

The prototype is intentionally narrow and not default-on. Its supporting
98.3% exact-label, 98.9% top-three, and 60/60 expected-abstention results came
from 40 synthetic, single-evaluator fixtures—not a production accuracy claim.

### Reporting

Splits are counted through their subtransactions and transfers between your own
accounts are excluded, so these report spending rather than money movement.

| Tool | What it does |
| --- | --- |
| `ynab_spending_by_category` | Total spend per category over a date range, biggest first, with share of total. Defaults to the last 30 days. |
| `ynab_spending_by_payee` | The same, grouped by merchant. |
| `ynab_cash_flow` | Income vs spending per month with the running net, from YNAB's own monthly totals. Defaults to the last 6 months. |

### Writing

| Tool | What it does |
| --- | --- |
| `ynab_create_transaction` | Creates a transaction. Needs `date`, `amount`, an account (`accountId` or `accountName`) and a payee (`payeeId` or `payeeName`); category optional as `categoryId` or `categoryName`. |
| `ynab_update_transaction` | Updates any subset of an existing transaction's fields. |
| `ynab_delete_transaction` | Deletes a transaction. Not undoable. |
| `ynab_approve_transaction` | Approves (or un-approves) one transaction. |
| `ynab_bulk_approve_transactions` | Approves an array of transaction IDs in one API call. |
| `ynab_update_category_budget` | Sets the total budgeted amount for a category in a month. Not an increment. |
| `ynab_import_transactions` | Triggers an import from linked institutions, the same as hitting Import in the YNAB app. |
| `ynab_move_money` | Moves budgeted money between two categories in a month, for covering overspending. |
| `ynab_auto_assign` | Spreads Ready to Assign over categories with unmet monthly goals, largest shortfall first. `dryRun` to preview, `maxTotal` to cap it. |

#### Names instead of IDs

`ynab_create_transaction` accepts `accountName` and `categoryName` and matches
them loosely against the budget, so "ally checking" finds *Ally Checking*.
Closed accounts and hidden categories are never matched. If a name is ambiguous
or unrecognised the call fails and names the near misses rather than guessing,
and successful calls echo back `matchedAccount` / `matchedCategory` so a wrong
guess is visible.

#### Writes that can half-succeed

YNAB has no endpoint for moving money between categories, so `ynab_move_money`
rewrites both categories' budgeted amounts in two calls. It takes from the
source first, so a failure in between leaves the money in Ready to Assign rather
than double-counted. When that happens the response sets `partial: true` and
carries a `recovery` line with the original amount to restore. `ynab_auto_assign`
behaves the same way: on failure it reports which categories were already funded
and which were left alone.

Tools never throw at the protocol level. Failures come back as
`{ "success": false, "error": "..." }` in the text content.

## Development

```bash
npm run watch          # rebuild on change
npm test               # vitest (watch mode)
npm run test:run       # vitest, single run
npm run test:coverage  # coverage report
npm run typecheck      # typecheck both the node and Worker targets
npm run debug          # build, then open the MCP inspector
npm run dev:worker     # run the Worker locally with wrangler
npm run deploy         # deploy the Worker to Cloudflare
```

`dist/` is a build artifact and is not tracked in git; `npm run build` regenerates it.

### Releasing

Bump the version in `package.json` and update `CHANGELOG.md`, then merge to `main` and create a GitHub release tagged in the existing `0.2.0` style (without a `v` prefix). The workflow stages that release with npm; it does not make the package public. The maintainer must run `npm stage list`, review it, and run `npm stage approve` with 2FA to promote it live. Configure a Trusted Publisher on npmjs.com for `ynab-mcp-server`, pointing at GitHub repository `calebl/ynab-mcp-server` and the exact workflow filename `.github/workflows/publish.yml` (the filename must match exactly); under Allowed actions select only `npm stage publish`.

### Adding a tool

Each tool is a self-contained module in `src/tools/` exporting `name`,
`description`, `inputSchema` (a Zod shape) and `execute(input, api)`. See
`CLAUDE.md` for the full template, then add the module to the `tools` array in
`src/registry.ts` and write a test in `src/tests/`. Registering it there serves
it from both the stdio server and the Worker; mark `writes: true` if the tool
changes data, which is what `YNAB_READ_ONLY` filters on.

Useful references:
- YNAB SDK types: `node_modules/ynab/dist/index.d.ts`
- YNAB OpenAPI spec: <https://api.ynab.com/papi/open_api_spec.yaml>

## License

See [LICENSE](./LICENSE).
