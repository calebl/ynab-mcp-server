# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to ./dist
npm start            # Start the server
npm run watch        # Development build with file watching
npm run debug        # Debug with MCP inspector
npm test             # Run tests
npm run test:watch   # Run tests with file watching
npm run test:coverage # Run tests with coverage report
```

## Git Best Practices

ALWAYS use conventional commits format (Refer to https://www.conventionalcommits.org/en/v1.0.0/) when creating git commit messages.
Use squash merge for PRs that should trigger release automation so the commit that lands on `main` matches the PR title.
The PR title must be a releasable Conventional Commit such as `feat: ...`, `fix: ...`, `deps: ...`, or `revert: ...`.
Default all PR creation to `mossipcams/ynab-mcp-bridge`.
When using `gh pr create`, set `--repo mossipcams/ynab-mcp-bridge` unless the user explicitly names a different target repo.
Do not open PRs, create commits for, push to, or take any other action against Caleb's repo (`calebl/ynab-mcp-server`) unless the user explicitly asks for that target repo.

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides AI tools for interacting with YNAB plans. Built with `@modelcontextprotocol/sdk`.

### Core Structure
- **Server Factory**: `src/server.ts` - SDK-native `McpServer` creation and tool registration
- **HTTP Transport**: `src/httpServer.ts` - Streamable HTTP transport wiring and request handling
- **Stdio Transport**: `src/stdioServer.ts` - stdio transport wiring for local MCP clients
- **CLI Entry Point**: `src/index.ts` - runtime config resolution and transport selection
- **Tools**: `src/tools/*.ts` - Each tool is a separate module exporting `name`, `description`, `inputSchema`, and `execute` function
- **Tests**: `src/*.spec.ts` - Vitest specs colocated under `src/`

### Tool Module Pattern
Each tool in `src/tools/` exports:
- `name`: Tool identifier (snake_case)
- `description`: Tool description
- `inputSchema`: Zod schema object for input validation
- `execute(input, api)`: Async handler receiving input and YNAB API client

Tools are registered in `src/server.ts`, which passes the shared YNAB `api` instance to each handler.

### Environment Variables
- `YNAB_API_TOKEN` (required) - Personal Access Token from YNAB API
- `YNAB_PLAN_ID` (optional) - Default plan ID for tools that accept `planId`

## Adding New Tools

1. Create `src/tools/MyTool.ts`:
```typescript
import { z } from "zod";
import * as ynab from "ynab";

export const name = "my_tool";
export const description = "What this tool does";
export const inputSchema = {
  planId: z.string().optional().describe("Plan ID (optional, uses YNAB_PLAN_ID env var if not provided)"),
  requiredParam: z.string().describe("Description of required param"),
};

interface MyToolInput {
  planId?: string;
  requiredParam: string;
}

export async function execute(input: MyToolInput, api: ynab.API) {
  try {
    const result = await withResolvedPlan(input.planId, api as any, async (planId) =>
      api.someMethod(planId, input.requiredParam)
    );

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

2. Register in `src/server.ts`:
```typescript
import * as MyTool from "./tools/MyTool.js";

server.registerTool(MyTool.name, {
  title: "My Tool",
  description: MyTool.description,
  inputSchema: MyTool.inputSchema,
}, async (input) => MyTool.execute(input, api));
```

3. Add test in `src/myTool.spec.ts`

## YNAB API Reference
- YNAB SDK types: `node_modules/ynab/dist/index.d.ts`
- OpenAPI spec: https://api.ynab.com/papi/open_api_spec.yaml
- Amounts are in milliunits (multiply dollars by 1000)
