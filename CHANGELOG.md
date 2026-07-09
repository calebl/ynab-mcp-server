# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-09

The npm-published `0.1.2` package predates this project's migration off
`mcp-framework` and still ships that older implementation, even though
`main` moved on some time ago. This release republishes `main` as-is so
npm and GitHub stop diverging.

### Fixed
- Fixed invalid MCP content type in tool error responses. The old
  `mcp-framework`-based implementation returned `{ type: "error", ... }`
  from failed tool calls, which is not a valid MCP content block type
  (valid types are `text`, `image`, `audio`, `resource_link`, `resource`).
  MCP clients rejected these responses with a schema validation error
  instead of surfacing the actual failure message, making it impossible
  to tell from the client side whether a mutating call like
  `create_transaction` succeeded or failed. Tools now return errors as
  `type: "text"` content carrying a JSON `{ success: false, error }`
  payload via the shared `getErrorMessage` helper.
- Fixed inaccurate generated input schemas for optional boolean fields
  (e.g. `cleared`, `approved` on `create_transaction`). The old
  `mcp-framework`-based JSON schema generation didn't unwrap
  `ZodOptional`, so these fields were reported as `type: "string"` to
  callers despite the underlying validator requiring real booleans.

### Changed
- Migrated from `mcp-framework` to the official `@modelcontextprotocol/sdk`
  for tool registration and the stdio transport.
- Renamed all tools with a `ynab_` prefix (e.g. `create_transaction` ->
  `ynab_create_transaction`) to avoid collisions with other MCP servers.
- Added consistent error handling across all tools via a shared
  `getErrorMessage` utility, including unwrapping YNAB API error
  response bodies.

### Added
- New tools: `ListCategories`, `ListAccounts`, `ListScheduledTransactions`,
  `ListMonths`, `ListPayees`, `GetTransactions`, `ImportTransactions`,
  `DeleteTransaction`, `UpdateTransaction`, `UpdateCategoryBudget`,
  `BulkApproveTransactions`.

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