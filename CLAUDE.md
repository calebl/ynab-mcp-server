# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Install dependencies
npm install

# Build the project (compiles TypeScript with official MCP SDK)
npm run build

# Start the server
npm start

# Development build with file watching
npm run watch

# Debug the MCP server with inspector
npm run debug

# Run tests
npm test

# Run tests with file watching
npm test:watch

# Run tests with coverage report
npm test:coverage
```

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides 17 comprehensive AI tools for interacting with YNAB (You Need A Budget) budgets. The architecture uses the official MCP SDK and follows MCP best practices:

### Core Structure
- **Entry Point**: `src/index.ts` - Server setup using official `@modelcontextprotocol/sdk` with environment validation
- **Tools Directory**: `src/tools/` - Contains all 17 MCP tools as individual TypeScript classes
- **Utilities**: `src/utils/` - Common utilities for amount conversion, date formatting, error handling
- **Framework**: Built with official `@modelcontextprotocol/sdk` v1.20.1 for proper MCP protocol handling

### Tool Architecture Pattern
Each tool in `src/tools/` follows this pattern:
- Implements `getToolDefinition()` method returning MCP Tool definition with `ynab_` prefix
- Implements `execute()` method returning MCP content array format
- Uses YNAB SDK client initialized with `process.env.YNAB_API_TOKEN`
- Supports both JSON and Markdown response formats via `response_format` parameter
- Includes MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
- Returns standardized MCP response format: `{ content: [{ type: "text", text: "..." }] }`
- Sets `isError: true` flag for error responses
- Applies 25,000 character limit with graceful truncation

### Available Tools (17 Total)

All tools follow the `ynab_*` naming convention for compatibility with multiple MCP servers.

#### **Core Foundation (5 Tools)**
- **ynab_list_budgets**: Lists available YNAB budgets
- **ynab_budget_summary**: Provides budget month summaries with categories and accounts
- **ynab_get_unapproved_transactions**: Retrieves pending transactions
- **ynab_create_transaction**: Creates new transactions
- **ynab_approve_transaction**: Approves existing transactions

#### **Workflow Automation (4 Tools)**
- **ynab_handle_overspending**: Automatically resolve overspent categories by moving funds
- **ynab_auto_distribute_funds**: Intelligently allocate "Ready to Assign" money based on goals
- **ynab_bulk_approve_transactions**: Approve multiple transactions matching criteria in one call
- **ynab_move_funds_between_categories**: Transfer budgeted amounts between categories

#### **Analytics & Insights (4 Tools)**
- **ynab_analyze_spending_patterns**: Analyze spending patterns to detect trends and anomalies
- **ynab_goal_progress_report**: Generate comprehensive goal progress reports with performance ratings
- **ynab_cash_flow_forecast**: Generate cash flow projections based on historical patterns
- **ynab_category_performance_review**: Review category budget performance with ratings and recommendations

#### **Additional Tools (4 Tools)**
- **ynab_net_worth_analysis**: Analyze current net worth across all accounts
- **ynab_set_category_goals**: Set or update category goals (target, monthly funding, etc.)
- **ynab_budget_from_history**: Create budget allocations based on historical spending patterns
- **ynab_reconcile_account**: Reconcile account balances with bank statements

### Environment Variables
- `YNAB_API_TOKEN` (required) - Personal Access Token from YNAB API. Server validates this at startup.
- `YNAB_BUDGET_ID` (optional) - Default budget ID to use. Can be provided per-request via `budgetId` parameter.

## Development Guidelines

### Adding New Tools
1. Create new tool class in `src/tools/` extending `MCPTool`
2. Reference YNAB SDK types from `node_modules/ynab/dist/index.d.ts`
3. Use YNAB OpenAPI spec at `https://api.ynab.com/papi/open_api_spec.yaml` for API reference
4. Follow existing pattern: initialize YNAB API client in constructor
5. Framework auto-discovers new tools - no manual registration needed
6. Add a test coverage file to `src/tools`

### Tool Development Pattern
```typescript
import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, formatCurrency } from "../utils/commonUtils.js";

interface ToolInput {
  budgetId?: string;
  response_format?: "json" | "markdown";
  // other parameters
}

class NewTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_tool_name",  // Always use ynab_ prefix
      description: "Tool description",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "Budget ID (optional)"
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable, 'markdown' for human-readable (default: markdown)"
          }
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Tool Title",
        readOnlyHint: true,  // true for read-only, false for write
        destructiveHint: false,  // true only for delete operations
        idempotentHint: true,  // true for read-only, false for write
        openWorldHint: true,  // true for external API interaction
      },
    };
  }

  async execute(input: ToolInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      // Implementation
      const result = { success: true, data: "result" };

      const format = input.response_format || "markdown";
      let responseText: string;

      if (format === "json") {
        responseText = JSON.stringify(result, null, 2);
      } else {
        responseText = this.formatMarkdown(result);
      }

      const { text } = truncateResponse(responseText, CHARACTER_LIMIT);

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,  // Always set this flag for errors
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: any): string {
    // Format result as markdown for human readability
    return `# Result\n\n${JSON.stringify(result, null, 2)}`;
  }
}

export default NewTool;
```

### Error Handling
- Environment validation at server startup checks for `YNAB_API_TOKEN`
- Use try/catch blocks for YNAB API calls
- Use `console.error` for server-side logging (never log to stdout with stdio transport)
- Return descriptive error messages in MCP content array format
- Always return proper MCP response structure even for errors
- Set `isError: true` flag in error responses per MCP best practices
- Use `getBudgetId()` utility which throws descriptive errors for missing budget IDs

### Testing
- Tests run with Vitest (274 tests, 251 passing - 91.6% pass rate)
- Test files follow pattern: `**/*.{test,spec}.{ts,js}`
- Coverage reports available via `npm run test:coverage`
- Tests should be put into the `src/tests` folder
- All 17 tools have test coverage
- Test files: 17 total (12 fully passing, 5 with partial failures in complex tools)
- When any code is modified, update the test coverage to account for the change

### TypeScript Configuration
- Target: ESNext with Node module resolution
- Strict mode enabled
- Output to `./dist` directory
- Base URL set to `./src` for clean imports
- Uses official MCP SDK types for proper protocol compliance

## Utilities

The `src/utils/` directory contains shared utilities:

### commonUtils.ts
- `normalizeMonth()` - Convert "current" or date strings to ISO format
- `milliUnitsToAmount()` / `amountToMilliUnits()` - Currency conversion utilities
- `getBudgetId()` - Budget ID resolution with error handling
- `formatCurrency()` / `formatDate()` - Display formatting
- `truncateResponse()` - Response truncation with 25,000 character limit
- `CHARACTER_LIMIT` constant

### contextOptimizer.ts
- `optimizeCategories()` - Compress category data for context efficiency
- `optimizeAccounts()` - Compress account data
- `withContextOptimization()` - Apply optimization to responses

### apiErrorHandler.ts
- `analyzeAPIError()` - Detect rate limiting, auth errors, anti-bot protection
- `handleAPIError()` - Retry logic with exponential backoff
- `createRetryableAPICall()` - Wrapper for retryable API operations

## MCP Best Practices Compliance

This server follows all MCP best practices:
- ✅ **Tool Naming**: All tools use `ynab_*` prefix to avoid conflicts
- ✅ **Tool Annotations**: All tools include proper hint annotations
- ✅ **Response Formats**: All tools support both JSON and Markdown formats
- ✅ **Character Limits**: All responses respect 25,000 character limit with truncation
- ✅ **Error Handling**: All errors include `isError: true` flag
- ✅ **Environment Validation**: Server validates required environment variables at startup
- ✅ **Type Safety**: Proper TypeScript types throughout (with documented `as any` usage in MCP handler)

## Project Status
- **Version**: 0.1.3
- **Status**: Production ready with 17 comprehensive tools
- **Framework**: Official @modelcontextprotocol/sdk v1.20.1
- **Test Coverage**: 274 tests (251 passing, 91.6% pass rate) across 17 test files
- **MCP Compliance**: Fully compliant with MCP best practices
- **Pagination**: Supported on 6 list-type tools
- **Error Handling**: apiErrorHandler with retry logic on all 17 tools
- **Architecture**: Manual tool registration with proper MCP protocol handling