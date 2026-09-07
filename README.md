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

The YNAB token stays a Worker secret and never reaches the client. GitHub is
used only to prove who you are: any account other than `ALLOWED_GITHUB_LOGIN` is
refused. This matters because the tool set can create and delete transactions —
an unauthenticated endpoint would hand the budget to anyone who found the URL.

Setting `YNAB_READ_ONLY` to `"true"` drops every write tool from the tool list,
which is worth considering for a connector you will mostly use on a phone.

## Tools

Every tool takes an optional `budgetId` that falls back to `YNAB_BUDGET_ID`.
All monetary values — in both directions — are plain currency amounts, never
YNAB's milliunits; conversion happens in `src/tools/money.ts`.

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
