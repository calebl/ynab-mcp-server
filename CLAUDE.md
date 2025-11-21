# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Install dependencies
npm install

# Build the project (compiles TypeScript and runs mcp-build)
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

This is a **Model Context Protocol (MCP) server** that provides AI tools for interacting with YNAB (You Need A Budget) budgets. The architecture follows the official MCP SDK pattern:

### Core Structure
- **Entry Point**: `src/index.ts` - Complete server implementation using `@modelcontextprotocol/sdk`
- **Framework**: Built with the official `@modelcontextprotocol/sdk` TypeScript SDK
- **All Tools**: Registered directly in the main server file for simplicity

### Tool Architecture Pattern
Each tool is registered using the SDK's `registerTool()` method:
- Direct function-based registration with the server
- Defines `title`, `description`, and `inputSchema` properties
- Implements async handler function for tool logic
- Uses YNAB SDK client initialized with `process.env.YNAB_API_TOKEN`

### Available Tools
- **list_budgets**: Lists available YNAB budgets
- **budget_summary**: Provides budget month summaries with categories and accounts
- **get_unapproved_transactions**: Retrieves pending transactions
- **create_transaction**: Creates new transactions
- **approve_transaction**: Approves existing transactions

### Environment Variables
- `YNAB_API_TOKEN` (required) - Personal Access Token from YNAB API
- `YNAB_BUDGET_ID` (optional) - Default budget ID to use

## Development Guidelines

### Adding New Tools
1. Add tool registration directly in `src/index.ts`
2. Reference YNAB SDK types from `node_modules/ynab/dist/index.d.ts`
3. Use YNAB OpenAPI spec at `https://api.ynab.com/papi/open_api_spec.yaml` for API reference
4. Use the existing `api` instance (YNAB API client) available in the main file
5. Follow the tool registration pattern used by existing tools
6. Add test coverage in the `src/tests` folder

### Tool Development Pattern
```typescript
// Register new tool in src/index.ts
server.registerTool("tool_name", {
  title: "Tool Title",
  description: "Tool description",
  inputSchema: {
    type: "object",
    properties: {
      budgetId: {
        type: "string",
        description: "Budget ID (optional)"
      },
      // other properties
    },
    required: ["requiredParam1", "requiredParam2"], // optional
    additionalProperties: false,
  },
}, async (input) => {
  try {
    const budgetId = getBudgetId(input.budgetId);

    // Tool implementation using the global `api` instance
    const result = await api.someYnabMethod(budgetId, input.someParam);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    console.error("Error in tool_name:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }]
    };
  }
});
```

### Error Handling
- Check for `YNAB_API_TOKEN` presence
- Use try/catch blocks for YNAB API calls
- Use `console.log`/`console.error` for logging (logs to stderr)
- Return descriptive error messages in MCP response format
- All tools should return `{ content: [{ type: "text", text: "..." }] }` format

### Testing
- Tests run with Vitest
- Test files follow pattern: `**/*.{test,spec}.{ts,js}`
- Coverage reports available via `npm run test:coverage`
- Tests should be put into the `src/tests` folder
- when any code is modified, update the test coverage to account for the change

### TypeScript Configuration
- Target: ESNext with Node module resolution
- Strict mode enabled
- Output to `./dist` directory
- Base URL set to `./src` for clean imports