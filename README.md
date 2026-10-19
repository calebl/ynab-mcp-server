# ynab-mcp-server

A Model Context Protocol (MCP) server for interacting with your YNAB plans at https://ynab.com

In order to have an AI interact with this tool, you will need to get your Personal Access Token
from YNAB: https://api.ynab.com/#personal-access-tokens. When adding this MCP server to any
client, you will need to provide your personal access token as YNAB_API_TOKEN. **This token
is never directly sent to the LLM.** It is stored privately in an environment variable for
use with the YNAB api.

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI
assistant read and modify a [YNAB](https://ynab.com) plan.

The server talks to the YNAB API through the official
[`ynab` SDK](https://github.com/ynab/ynab-sdk-js). Your Personal Access Token
lives in an environment variable and is never sent to the model.

It runs two ways from one codebase:

- **Local (stdio)** — a child process of Claude Code or Claude Desktop on your
  own machine. Simplest, but only works on that machine while it is running.
- **Remote (Cloudflare Worker)** — deployed behind GitHub sign-in and added to
  claude.ai as a custom connector, so it works from the web and the mobile app
  with your computer switched off. See [DEPLOY.md](./DEPLOY.md).

Both entry points register the shared tools from `src/registry.ts`. The Worker
can also run an optional scheduled auto-budget service that records what it
would categorize, approve and assign without changing your plan and delivers
spending alerts; see
[Auto-budget service](./DEPLOY.md#auto-budget-service-optional).

Other providers:

<a href="https://glama.ai/mcp/servers/@calebl/ynab-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@calebl/ynab-mcp-server/badge" alt="YNAB Server MCP server" />
</a>

[![LightNow](https://lightnow.ai/badge/io.github.calebl/ynab-mcp-server)](https://lightnow.ai/servers/io.github.calebl/ynab-mcp-server)


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
| `YNAB_PLAN_ID` | no | Default plan, so tools can omit `planId`. Find it with `ynab_list_plans`. |
| `TYPESAFE_API_KEY` | no | Operator-owned TypeSafe credential. Required, but not sufficient, to enable category suggestions. |
| `YNAB_AI_CATEGORIZATION` | no | Set to `"true"` together with `TYPESAFE_API_KEY` to expose the opt-in suggestion tool. |
| `YNAB_AI_TYPICAL_PAYEES` | no | Set to `"true"` to send each category's most frequent payee names from the last 12 months with each model request. Off by default because it discloses aggregated payee history to TypeSafe. |
| `YNAB_READ_ONLY` | no | Set to `"true"` (case-insensitive; surrounding whitespace is ignored) to remove tools that write to YNAB, in both the stdio server and the Worker. |

### Local: Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp-server/dist/index.js"],
      "env": {
        "YNAB_API_TOKEN": "your-token",
        "YNAB_PLAN_ID": "your-plan-id"
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

1. Copy `wrangler.example.jsonc` to the git-ignored `wrangler.jsonc`, remove
   the optional placeholder `AUTOBUDGET_DB` block unless you are configuring
   the [auto-budget service](./DEPLOY.md#auto-budget-service-optional), run
   `npx wrangler login`, then create the `OAUTH_KV` namespace
2. `npm run deploy` once to learn your `*.workers.dev` hostname
3. Create a GitHub OAuth app whose callback is `https://<host>/callback`
4. Use `npx wrangler secret put` for `ALLOWED_GITHUB_LOGIN`, `YNAB_API_TOKEN`,
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `TYPESAFE_API_KEY`
5. Run `npm run deploy` again
6. Add `https://<host>/mcp` as a custom connector in claude.ai

The YNAB token stays a Worker secret and never reaches the client. GitHub sign-in
controls **who may connect** to the remote Worker; the YNAB Personal Access
Token controls **which YNAB account it reaches**. They answer different
questions, and neither substitutes for the other. The Worker uses one
server-wide YNAB token, so anyone admitted through the GitHub gate reaches the
deployer's YNAB account, money, and every plan available to that token—not
their own YNAB account.
`ynab_list_plans` lists all of those plans, and a caller-supplied `planId`
overrides the optional `YNAB_PLAN_ID` default. Any GitHub account other than
`ALLOWED_GITHUB_LOGIN` is refused. This matters because the tool set can create
and delete transactions—an unauthenticated endpoint would grant access to those
plans to anyone who found the URL.

The Worker is not tied to Claude. Any MCP client that supports remote servers
with OAuth can connect, for example Claude (claude.ai, desktop, and mobile),
ChatGPT connectors, Claude Code, or the MCP Inspector. Because clients register
themselves, every permitted sign-in shows an approval page naming the client
and the exact address the grant will be sent to; approve only a sign-in you
just started. To restrict which clients can connect at all, set
`ALLOWED_REDIRECT_URIS` to their exact callback URIs (loopback redirects for
local clients stay allowed). See
[Approving MCP clients](./DEPLOY.md#approving-mcp-clients) for example callback
URIs.

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

Setting `YNAB_READ_ONLY` to `"true"` drops every YNAB write tool from the tool
list, which is worth considering for a connector you will mostly use on a phone.

## Tools

Plan-scoped tools take an optional `planId` that falls back to
`YNAB_PLAN_ID`. Optional tool inputs may be `null`; the server treats `null`
the same as omitting that input. All monetary values — in both directions — are
plain currency amounts, never YNAB's milliunits. Reported amounts use the
plan currency's precision (three decimals for currencies such as the Kuwaiti
dinar) and fall back to two decimals if its settings cannot be read; conversion
happens in `src/tools/money.ts`.

### Reading

| Tool | What it does |
| --- | --- |
| `ynab_list_plans` | Every plan on the account. Run this first to find a plan ID. |
| `ynab_plan_summary` | A month at a glance: income, budgeted, activity, Ready to Assign, plus categories split into `overspent`, `underfunded` (goal not yet met) and `positive_balance`. Hidden and deleted categories are excluded. |
| `ynab_list_accounts` | Accounts with balances. `includeClosedAccounts` to see closed ones. |
| `ynab_list_categories` | Categories grouped by category group, with goal info. |
| `ynab_list_payees` | Payees, for resolving payee IDs. |
| `ynab_list_months` | Every plan month since the plan began, with raw income, budgeted, activity, Ready to Assign, age-of-money and note fields. For recent income versus spending, use `ynab_cash_flow`. |
| `ynab_list_scheduled_transactions` | Scheduled/recurring transactions. |
| `ynab_get_transactions` | Transactions optionally filtered from `sinceDate` onward (no end-date filter), by `type` (`all`/`uncategorized`/`unapproved`), and by at most one of `accountId`, `categoryId` or `payeeId` (the first in that order wins). `limit` defaults to 100. |
| `ynab_get_unapproved_transactions` | Unapproved transactions, optionally from `sinceDate` onward. |
| `ynab_suggest_categories` | Opt-in, read-only category previews for unapproved, uncategorized ordinary outflows. Deleted and categorized rows are dropped in default mode; approved, reconciled, balance-adjustment, transfer, split, and inflow rows are skipped as applicable. |

### Category suggestions (optional)

`ynab_apply_category_suggestions` is a separate write tool that is available
without enabling the TypeSafe preview. Provide up to 25 explicit
`transaction_id`, `category_id`, and `expected_content_fingerprint` rows. The
tool refetches each transaction and rejects stale or ineligible changes; a retry
whose category is already applied is a no-op. It supports validation-only dry
runs and returns a pre-write undo manifest, but does not perform the undo. It
never auto-applies suggestions, calls TypeSafe, or approves transactions.

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
Payee history uses the latest 12 months, capped at 50 qualifying rows. When the
payee has no qualifying rows with the same payee ID, history falls back to rows
from payees with a similar name: after Unicode NFC normalization, lowercasing,
and removing everything except letters and numbers, one name begins the other
and the shorter is at least six characters, so a truncated bank payee such as
"Better Bl" draws on "Better Blend" history. Each history summary reports
`match` (`payee`, `similar_payee_name`, or `null`) and
`matched_payee_names`.

Each eligible row is then routed in this order, and `source` names the step
that answered:

1. **Exact-payee history (`history_rule`).** When at least one qualifying row
   has the same payee ID and every such row uses the same still-eligible
   category, that category is `suggested`. When those rows disagree, the row is
   `needs_review` and proposes the most recently used category, with the
   others as `top_alternatives` carrying their `history_count`. No model call is
   made for either case.
2. **Personal prior (`personal_prior`).** A naive-Bayes classifier is trained
   for each request on the plan's own categorized ordinary outflows from the
   same 12-month history, using payee and bank-import name tokens, the account,
   and a coarse amount bucket. It is used when history contains categorized
   rows across at least two categories; a single-category prior cannot rank
   alternatives. Name tokens never seen in training are ignored rather than
   scored. When its top category reaches probability 0.9, the row is
   `suggested` without a model call. The probability is reported under
   `personal_prior.ranking`, never as `model_confidence`. Below 0.9 the prior
   only ranks: its top three appear on the model's row for comparison.
3. **Model (`jev`).** Every remaining row goes to TypeSafe's pinned
   `jev-1.13.0` System One model in batches of ten. A model answer is a ranked
   shortlist, never a suggestion: every answer that names a category is
   `needs_review`, while an explicit model abstention is `left_uncategorized`.
   The pinned model's stored review threshold is therefore 0; thresholds stay
   model-specific because confidence scales differ between models.

Similar-name history is never a rule; when a row reaches the model, it is
included as suggestive evidence. The history summary's `reference_category_id` is the category a
proposal is compared with: the most recently used one for exact-payee history,
and the plurality for similar-name history. A similar-name disagreement is
reported as `conflict` but does not change the status, because a prefix match
does not establish merchant identity. Every inspected eligible row includes a
status, source, content fingerprint, proposed category, model confidence and
winning probability (model rows only), up to three alternatives, the history
summary, and the personal-prior ranking where one was computed. The response's
`thresholds` object reports the values in force, and `personal_prior` reports
how many rows trained the prior and whether it was available for routing.
Applying a suggestion remains a separate, explicit human decision using
`ynab_apply_category_suggestions` (or the general `ynab_update_transaction`
tool).

Why this order: households file payees their own way, such as restaurants
under a groceries category or clinics under a savings category. A
general-purpose model cannot know that, but the plan's own history encodes it.
On real household history, history rules and the personal prior were much more
accurate than a model on the same rows. The model's high-confidence answers
were wrong far more often than on synthetic fixtures, which is why they are
review-only. To evaluate your own plan, or a local model, see
[Evaluating categorization and local decision models](./docs/local-decision-model.md).

Enabling this feature sends the transaction's display payee, imported/original
payee, memo, amount, date, and account name/type/on-budget status, plus visible
category group and category names, to **TypeSafe as a third-party processor**.
For model-bound rows with similar-name matches, it also sends the matched payee
names and per-category key, group, name, and count. When
`YNAB_AI_TYPICAL_PAYEES=true`, each model request also lists up to eight of each
category's most frequent payee names from the last 12 months
(`typical_payees`), and the response sets
`typical_payees_sent: true`. This makes the model noticeably more accurate on a
household's own filing habits, but it discloses aggregated payee history, so it
is off by default. It does not send YNAB UUIDs, balances, goals,
approval/cleared state, or raw transaction history. Rows answered by history or
the personal prior are never sent. TypeSafe's published
Jev 1.13 price at the time of this release is **$0.042 per million input tokens;
output tokens are free**. The tool returns preflight estimates, actual token
usage, and projected cost on each run
and refuses requests over its per-call token/cost ceilings. Pricing and
provider limits can change; check <https://docs.typesafe.ai/models>.

The prototype is intentionally narrow and not default-on. Its original
98.3% exact-label, 98.9% top-three, and 60/60 expected-abstention results came
from 40 synthetic, single-evaluator fixtures, not a production accuracy claim.
Real household history is much harder, as described above.

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
| `ynab_create_transaction` | Creates a transaction. Needs `date`, `amount`, an account (`accountId` or `accountName`) and a payee (`payeeId` or `payeeName`); category optional as `categoryId` or `categoryName`, or `subtransactions` to split it. |
| `ynab_update_transaction` | Updates any subset of an existing transaction's fields, or splits an unsplit one with `subtransactions`. |
| `ynab_delete_transaction` | Deletes a transaction. Not undoable. |
| `ynab_approve_transaction` | Approves (or un-approves) one transaction. |
| `ynab_bulk_approve_transactions` | Approves an array of transaction IDs in one API call. |
| `ynab_apply_category_suggestions` | Applies up to 25 explicit category suggestions with refetch and stale-data checks, dry-run support, and a pre-write undo manifest. Never auto-applies or approves transactions. |
| `ynab_update_category_budget` | Sets the total budgeted amount for one category in a month. Not an increment; use `ynab_move_money` to move money between categories. |
| `ynab_import_transactions` | Triggers an import from linked institutions, the same as hitting Import in the YNAB app. |
| `ynab_move_money` | Moves budgeted money between two categories in a month, for covering overspending. |
| `ynab_auto_assign` | Spreads Ready to Assign over categories with unmet monthly goals, largest shortfall first. `dryRun` to preview, `maxTotal` to cap it. |

#### Names instead of IDs

`ynab_create_transaction` accepts `accountName` and `categoryName` and matches
them loosely against the plan, so "ally checking" finds *Ally Checking*.
Closed accounts and hidden categories are never matched. If a name is ambiguous
or unrecognised the call fails and names the near misses rather than guessing,
and successful calls echo back `matchedAccount` / `matchedCategory` so a wrong
guess is visible.

#### Split transactions

`ynab_create_transaction` and `ynab_update_transaction` split a transaction
across categories when given `subtransactions`: two or more entries of
`{ amount, category_name, payee_name, memo }`, the same shape
`ynab_get_transactions` returns for a split. Amounts are in dollars and must add
up to the transaction amount exactly (on update, the new `amount` if given,
otherwise the current one); categories go on the splits, not on the parent.
Split category names are matched like `categoryName` and echoed back as
`matchedSplitCategories`.

YNAB cannot change the splits of a transaction that is already split, so
`ynab_update_transaction` refuses rather than silently dropping the change.
Delete and recreate the transaction to re-split it.

#### Writes that can half-succeed

YNAB has no endpoint for moving money between categories, so `ynab_move_money`
rewrites both categories' budgeted amounts in two calls. It takes from the
source first, so a failure in between leaves the money in Ready to Assign rather
than double-counted. When that happens the response sets `partial: true` and
carries a `recovery` line with the original amount to restore. `ynab_auto_assign`
behaves the same way: on failure it reports which categories were already funded
and which were left alone.

Tools never throw at the protocol level. Failures come back as an MCP error
result (`isError: true`) with `{ "success": false, "error": "..." }` in the
text content, so a failed write is never mistaken for a successful one.

#### Tool annotations

Every tool advertises MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) alongside its schema. Tools that change
neither YNAB nor the Worker's service state are `readOnlyHint: true`; among the
YNAB writing tools, only `ynab_delete_transaction` sets `destructiveHint: true`.
A client may use these hints to decide which calls need a confirmation prompt.

#### `cleared` and `flagColor`

`ynab_create_transaction` and `ynab_update_transaction` accept `cleared` as
one of `cleared`, `uncleared`, or `reconciled`, and `flagColor` as one of
`red`, `orange`, `yellow`, `green`, `blue`, `purple`, or `""` to clear an
existing flag.

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

## Contributing

Pull requests are welcome. For a new tool or a larger change, please open an
issue first so we can agree on the scope.

1. Fork the repository and create a branch from `main`.
2. Make your change and add or update tests in `src/tests/`. New tools follow
   the pattern in [Adding a tool](#adding-a-tool).
3. Run `npm run test:run` and `npm run typecheck`.
4. Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
   for commit messages and the pull request title.
5. Open a pull request against `main`.

Every pull request runs the test suite on Node.js 22, 24 and 26 and receives an
automated code review. Both checks must pass and review conversations must be
resolved before the pull request can be merged.

## Compatibility

`ynab_list_budgets` and `ynab_budget_summary` remain accepted aliases for the
plan-named tools. `budgetId` and `YNAB_BUDGET_ID` are deprecated but still
accepted; there is no removal date. Use `planId` and `YNAB_PLAN_ID` for new
integrations.

## License

See [LICENSE](./LICENSE).
