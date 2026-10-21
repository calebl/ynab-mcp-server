# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-10-21

### Security
- Updated `@modelcontextprotocol/server` (the Worker's MCP SDK) from 2.0.0 to 2.3.1 in response to GHSA-jm63-cq47-j5jp (shared transport or server instances could deliver one HTTP client's messages to another), GHSA-46jr-4wx8-v453 (one HTTP request could exhaust memory during validation) and GHSA-rvq5-wwqv-78pq (SDK bearer authentication accepted tokens issued for another service). The Worker was not exposed to the first or third issue: it builds a new server for every request, and its OAuth provider validates access tokens before the MCP handler instead of using the SDK's bearer authentication. To enable the validation-exhaustion safeguards, the Worker now limits MCP request bodies to 1 MiB and tool inputs to 10,000 elements. The single-client stdio entry uses `@modelcontextprotocol/sdk` 1.32.1 rather than the affected HTTP server package and has no HTTP body or bearer-authentication path.

### Added
- `ynab_get_transactions` can search: `untilDate`, `payeeContains`, `memoContains`, `minAmount`, `maxAmount` and `direction` filter the rows, and any of them (or `totalsOnly: true`) adds a `totals` block with `count`, `inflow`, `outflow` and `net` over every match, unaffected by `limit`; transfers between accounts count. `totalsOnly` returns just the totals. Without `categoryId` or `payeeId`, split transactions are matched leg by leg, and the totals count only the matching legs. With `categoryId` or `payeeId`, rows are matched as YNAB returns them, so a split's parent row in the payee listing counts at its full amount. When the `payeeId` listing returns both a split and some of its legs, a matching split is counted once, through its parent row. Without these options (or with only `direction: "any"` or `totalsOnly: false`), no rows are filtered out and no totals are returned.
- `ynab_get_transactions` rows that are split legs listed on their own (from the `categoryId` and `payeeId` listings) carry `parent_transaction_id`.
- The Worker logs a warning with GitHub's `error` and `error_description` when the GitHub OAuth token exchange fails, adding the HTTP status for non-2xx responses and logging the status with `unknown` for malformed responses. The code, state and secrets are never logged.

### Changed
- Clarified the descriptions of `ynab_update_category_budget` (points to `ynab_move_money` for moving money), `ynab_get_transactions` (account, category and payee filters are mutually exclusive), `ynab_list_months` (raw month list; points to `ynab_cash_flow`) and `ynab_autobudget_plan` (how it differs from `ynab_auto_assign` with `dryRun`).
- `ynab_bulk_approve_transactions` accepts `approved` (default `true`); `false` un-approves the listed transactions.
- `ynab_get_transactions` rows also include `transfer_transaction_id`, `matched_transaction_id` and `import_id`.
- `ynab_get_unapproved_transactions` is now an alias of `ynab_get_transactions` with `type: "unapproved"` and no row limit. Its rows now also carry `cleared` and `flag_color`, and the response adds `total_available`.
- `ynab_approve_transaction` is now an alias of `ynab_bulk_approve_transactions` for a single transaction. It no longer reads the transaction before updating it, and returns the bulk response (`approved_count` when approving or `unapproved_count` when un-approving, plus a `transactions` list) instead of a top-level `transactionId`.

### Deprecated
- The tool aliases `ynab_list_budgets`, `ynab_budget_summary`, `ynab_get_unapproved_transactions` and `ynab_approve_transaction` are deprecated and their descriptions now say `Deprecated alias of <tool>; use that instead`. They will be removed in the release after 0.6.0. Use `ynab_list_plans`, `ynab_plan_summary`, `ynab_get_transactions` and `ynab_bulk_approve_transactions`.

### Fixed
- Non-JSON or invalid-shape responses from GitHub's token endpoint now show the sign-in failure page instead of raising an unhandled Worker exception.

## [0.5.0] - 2026-10-18

### Security
- Updated `@modelcontextprotocol/sdk` from 1.30.0 to 1.32.1, which fixes a high-severity advisory in which the SDK's OAuth client could send credentials to an authorization server chosen by the MCP server (fixed upstream in 1.31.0). The lockfile also resolves the development-only dependencies `sharp` to 0.35.5 (librsvg CVE-2026-96889) and `shell-quote` to 1.12.0 (`quote()` command injection), neither of which ships in the npm package.

### Added
- `ynab_suggest_categories` learns a personal prior from the plan's own categorized outflows on each request. This is a naive-Bayes classifier over payee and bank-import name tokens, the account, and an amount bucket. When training history spans at least two categories, a pick at probability 0.9 or higher is returned as `suggested` with `source: "personal_prior"` and no model call. Name tokens never seen in training are ignored. Lower picks only rank, under each model row's new `personal_prior.ranking`. The response reports the prior's training size under `personal_prior`.
- Optional `YNAB_AI_TYPICAL_PAYEES=true` setting (stdio and Worker) that adds each eligible category's most frequent payee names to the model request as `typical_payees`, reported by the new `typical_payees_sent` response field. It is off by default because it discloses aggregated payee history to TypeSafe.
- [Evaluating categorization and local decision models](docs/local-decision-model.md): how to build a labeled set from your own history, measure baselines, and evaluate a local decision model that speaks the same request shape.
- Optional auto-budget service in the Cloudflare Worker, run by the existing hourly cron trigger. It keeps a D1 mirror of transactions and accounts with delta requests, records shadow decisions in an audit log, and sends immediate alerts and a daily digest through Pushover. This version never writes to YNAB; `YNAB_READ_ONLY` keeps it in shadow mode. Off unless `AUTOBUDGET_MODE` and an `AUTOBUDGET_DB` binding are set; see DEPLOY.md for its alert policy and setup.
- Worker-only MCP tools `ynab_autobudget_status`, `ynab_autobudget_plan` (dry run) and `ynab_autobudget_pause`, served when `AUTOBUDGET_DB` is bound.

### Changed
- `ynab_suggest_categories` now routes rows to exact-payee history, then the personal prior, then the model.
- The exact-payee history rule suggests from a single prior row when every exact-payee row agrees (it needed three).
- Disagreeing exact-payee history no longer goes to the model. The row is `needs_review` with source `history_rule`, proposing the most recently used category, with the others as `top_alternatives` carrying `history_count` and `probability: null`.
- History summaries add `reference_category_id`: the last-used category for exact-payee history, or the plurality for similar-name history. Agreement and `conflict` are now judged against it; `dominant_category_id` is still reported.
- Model answers are never `suggested`. Every answer naming a category is `needs_review`; only an explicit model abstention is `left_uncategorized`. Review thresholds are stored per pinned model and the current model's is 0, matching that behavior. The response's `thresholds.suggested_at_or_above` is now `null`, and new fields report the model, history-rule floor and personal-prior settings.

### Fixed
- When `YNAB_PLAN_ID` names a plan the token cannot access, calls that rely on it now say so and list the plans the token can see, instead of failing with YNAB's bare "Resource not found".

## [0.4.2] - 2026-10-14

### Security
- Fixed [GHSA-rf2m-h377-hhmg](https://github.com/calebl/ynab-mcp-server/security/advisories/GHSA-rf2m-h377-hhmg) (moderate) in the npm package's stdio server, which ignored `YNAB_READ_ONLY` in versions 0.2.0 to 0.4.1, so write tools were exposed even when read-only mode was set. Cloudflare Worker deployments already honored the setting. One shared parser now reads the value case-insensitively for both the stdio server and the Worker, the stdio startup line reports "(read-only)" when it applies, and the README documents the setting for both.

### Fixed
- Amounts keep the precision of the plan's currency, such as three decimals for Kuwaiti dinar, instead of always rounding to two. Inflows and outflows now round the same way.

## [0.4.1] - 2026-10-04

### Security
- Fixed [GHSA-h64q-xp38-pgwr](https://github.com/calebl/ynab-mcp-server/security/advisories/GHSA-h64q-xp38-pgwr) (high) in the Cloudflare Worker deployment, versions 0.2.0 to 0.4.0. A crafted link could make the Worker issue an MCP grant to an attacker-registered redirect URI. Every sign-in now stops at an approval page that shows the client's name and the full redirect URI. The pending request is stored server-side, bound to the browser session, and no longer trusted from the OAuth `state`. The npm package does not include the Worker and was not affected.

### Added
- Optional `ALLOWED_REDIRECT_URIS` Worker setting that restricts which exact callback URIs can receive grants. Loopback redirects stay allowed. It can be set as a plain var or a secret.

### Changed
- `ynab_suggest_categories` falls back to categorization history from payees with similar names when a payee has no history of its own, such as names a bank feed has truncated. Exact-payee history still takes precedence.
- Updated vulnerable development dependencies and dropped end-of-life Node.js 23 from the supported engines.

## [0.4.0] - 2026-10-02

### Added
- Added `ynab_apply_category_suggestions` for explicit, guarded bulk application with dry-run and undo manifests.
- `ynab_create_transaction` and `ynab_update_transaction` accept `subtransactions` to split a transaction, in the same shape transaction listings return. Update refuses to re-split an already-split transaction, which YNAB does not support.

## [0.3.0] - 2026-09-20

### Added
- Added the opt-in read-only `ynab_suggest_categories` preview tool with TypeSafe Jev eligibility rules and skip summaries.
- Added MCP tool annotations.
- Added plan-named tools `ynab_list_plans` and `ynab_plan_summary` with `planId` and `YNAB_PLAN_ID`.

### Changed
- Upgraded the `ynab` SDK from 2.10 to 4.5, including its budget-to-plan internal rename.
- Reported tool failures as MCP error results and restored field descriptions in advertised schemas.
- Used YNAB enums for create-transaction cleared/flagColor values, including reconciled and flag clearing.
- Tightened input validation, allowed null optional inputs, and pinned the MCP inspector dev dependency.

### Deprecated
- `ynab_list_budgets`, `ynab_budget_summary`, `budgetId`, and `YNAB_BUDGET_ID` remain accepted aliases. `YNAB_BUDGET_ID` is deprecated and still accepted, with no removal date stated.

### Fixed
- Fixed transaction-listing filter argument order after the SDK upgrade.
- Accepted empty or null `transactionIds`.

## [0.2.1] - 2026-09-17

### Changed
- Verified compatibility across Node.js 22, 24, and 26 in the CI matrix. Node.js 22 reaches end of life on April 30, 2027, and Node.js 24 reaches end of life on April 30, 2028, according to the Node.js release schedule.
- Bumped `@types/node` to the Node.js 22 line.
- Credited the 0.2.0 release contributors by GitHub username and profile URL.

## [0.2.0] - 2026-09-17

### Added
- Added money movement, auto-assignment, spending-by-category and spending-by-payee reporting, and cash-flow reporting tools.
- Added account and category name matching for transaction creation, including near-miss feedback and matched-name echoes.
- Added a Cloudflare Worker remote entry point with GitHub OAuth and a read-only deployment mode.
- Added tools for listing categories, accounts, scheduled transactions, months, payees and transactions, importing transactions, bulk approval, and transaction updates/deletion.
- Added split-transaction category exposure and improved budget summaries.

### Changed
- **Breaking:** all tool names now carry the `ynab_` prefix; clients must update tool references.
- **Breaking:** upgraded to Zod 4 and MCP SDK 1.30; integrations should verify schemas and SDK compatibility.
- **Breaking:** transaction creation now supports (and may resolve) account/category names, while monetary inputs and outputs consistently use plain currency amounts rather than milliunits.
- **Breaking:** the remote Worker requires Cloudflare and GitHub OAuth configuration; local stdio remains available.
- Improved error handling so failures are returned consistently through the protocol.

### Fixed
- Excluded transfers from spending reports and categorization reminders.
- npm publishing now uses npm Trusted Publishing (OIDC) and staged publishing: the maintainer reviews with `npm stage list` and promotes with `npm stage approve` (2FA). The package does not become public until approval.
- Categorization reminders now focus on the current month and run at a randomized hour.

## [0.1.2] - 2024-03-26

### Added
- New `ApproveTransaction` tool for approving existing transactions in YNAB
  - Can approve/unapprove transactions by ID
  - Works in conjunction with GetUnapprovedTransactions tool
  - Preserves existing transaction data when updating approval status
- Added Cursor rules for YNAB API development
  - New `.cursor/rules/ynabapi.mdc` file
  - Provides guidance for working with YNAB types and API endpoints
  - Helps maintain consistency in tool development

### Changed
- Updated project structure documentation to include `.cursor/rules` directory
- Enhanced README with documentation for the new ApproveTransaction tool 