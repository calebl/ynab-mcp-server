# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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