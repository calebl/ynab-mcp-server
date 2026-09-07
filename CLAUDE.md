# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to ./dist
npm start            # Start the server
npm run watch        # Development build with file watching
npm run debug        # Debug with MCP inspector
npm test             # Run tests (watch mode)
npm run test:run     # Run tests once
npm run typecheck    # Typecheck both node and Worker targets
npm run dev:worker   # Run the Cloudflare Worker locally
npm run deploy       # Deploy the Worker
npm run test:watch   # Run tests with file watching
npm run test:coverage # Run tests with coverage report
```

## Git Best Practices

ALWAYS use conventional commits format (Refer to https://www.conventionalcommits.org/en/v1.0.0/) when creating git commit messages.

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides AI tools for interacting with YNAB (You Need A Budget) budgets. Built with `@modelcontextprotocol/sdk`.

### Core Structure
- **Tool registry**: `src/registry.ts` - the single list of tools, shared by both entry points
- **stdio entry**: `src/index.ts` - local server for Claude Code / Claude Desktop
- **Worker entry**: `src/worker/` - Cloudflare Worker serving the same tools over HTTP behind GitHub OAuth (see `DEPLOY.md`)
- **Tools**: `src/tools/*.ts` - Each tool is a separate module exporting `name`, `description`, `inputSchema`, and `execute` function
- **Tests**: `src/tests/*.test.ts` - Vitest tests for each tool

### Tool Module Pattern
Each tool in `src/tools/` exports:
- `name`: Tool identifier (snake_case)
- `description`: Tool description
- `inputSchema`: Zod schema object for input validation
- `execute(input, api)`: Async handler receiving input and YNAB API client

Tools are listed in `src/registry.ts`; `registerAll` passes the shared YNAB `api` instance to each handler.

### Environment Variables
- `YNAB_API_TOKEN` (required) - Personal Access Token from YNAB API
- `YNAB_BUDGET_ID` (optional) - Default budget ID
- `YNAB_READ_ONLY` (optional, Worker) - `"true"` serves only the read-only tools

The tool modules read `process.env` directly. The Worker has no ambient
environment, so `src/worker/mcp.ts` mirrors its bindings onto `process.env`
before building the server.

## Adding New Tools

1. Create `src/tools/MyTool.ts`:
```typescript
import { z } from "zod";
import * as ynab from "ynab";

export const name = "my_tool";
export const description = "What this tool does";
export const inputSchema = {
  budgetId: z.string().optional().describe("Budget ID (optional, uses YNAB_BUDGET_ID env var if not provided)"),
  requiredParam: z.string().describe("Description of required param"),
};

interface MyToolInput {
  budgetId?: string;
  requiredParam: string;
}

export async function execute(input: MyToolInput, api: ynab.API) {
  try {
    const budgetId = input.budgetId || process.env.YNAB_BUDGET_ID;
    if (!budgetId) throw new Error("No budget ID provided");

    const result = await api.someMethod(budgetId, input.requiredParam);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }]
    };
  }
}
```

2. Register in `src/registry.ts` — import the module and add it to the `tools`
   array. Both entry points build from this one list, so registering here serves
   the tool from the stdio server and the Cloudflare Worker alike.

```typescript
import * as MyTool from "./tools/MyTool.js";

export const tools: ToolEntry[] = [
  // ...
  { title: "My Tool", module: MyTool, writes: false },
];
```

   Set `writes: true` for any tool that changes data in YNAB. `YNAB_READ_ONLY`
   filters on that flag, so a mislabelled tool would be exposed in a deployment
   meant to be read-only.

3. Add test in `src/tests/MyTool.test.ts`

## YNAB API Reference
- YNAB SDK types: `node_modules/ynab/dist/index.d.ts`
- OpenAPI spec: https://api.ynab.com/papi/open_api_spec.yaml
- The API works in milliunits; tools expose plain currency amounts instead. Convert with `toDollars`/`toMilliunits` from `src/tools/money.ts` rather than open-coding `* 1000`.