# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to ./dist
npm start            # Start the server in stdio mode (default)
npm run start:http   # Start the server in HTTP mode on port 3000
npm run watch        # Development build with file watching
npm run debug        # Debug with MCP inspector
npm test             # Run tests
npm run test:watch   # Run tests with file watching
npm run test:coverage # Run tests with coverage report
```

## Running the Server

### Stdio Mode (Local/Default)
The default mode runs the server using stdio transport for local MCP clients:
```bash
npm start
# or
node dist/index.js
```

### HTTP Mode (Remote Hosting)
Run as an HTTP server with SSE (Server-Sent Events) transport:
```bash
# Default port 3000
npm run start:http

# Custom port
node dist/index.js --http --port 8080
```

When running in HTTP mode, the following endpoints are available:
- `POST /sse` - MCP SSE endpoint for client connections
- `GET /health` - Health check endpoint
- `POST /message` - Message endpoint (handled by SSE transport)

### Docker Mode
Run as a Docker container (runs HTTP mode on port 80 by default):
```bash
# Build and run
docker build -t ynab-mcp-server .
docker run -d -p 80:80 -e YNAB_API_TOKEN=your_token --name ynab-mcp ynab-mcp-server

# Health check
curl http://localhost/health

# View logs
docker logs ynab-mcp

# Map to different host port
docker run -d -p 3000:80 -e YNAB_API_TOKEN=your_token --name ynab-mcp ynab-mcp-server
```

## Git Best Practices

ALWAYS use conventional commits format (Refer to https://www.conventionalcommits.org/en/v1.0.0/) when creating git commit messages.

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides AI tools for interacting with YNAB (You Need A Budget) budgets. Built with `@modelcontextprotocol/sdk`.

### Core Structure
- **Entry Point**: `src/index.ts` - Server setup and tool registration
- **Tools**: `src/tools/*.ts` - Each tool is a separate module exporting `name`, `description`, `inputSchema`, and `execute` function
- **Tests**: `src/tests/*.test.ts` - Vitest tests for each tool

### Tool Module Pattern
Each tool in `src/tools/` exports:
- `name`: Tool identifier (snake_case)
- `description`: Tool description
- `inputSchema`: Zod schema object for input validation
- `execute(input, api)`: Async handler receiving input and YNAB API client

Tools are registered in `src/index.ts` which passes the shared YNAB `api` instance to each handler.

### Environment Variables
- `YNAB_API_TOKEN` (required) - Personal Access Token from YNAB API
- `YNAB_BUDGET_ID` (optional) - Default budget ID

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

2. Register in `src/index.ts`:
```typescript
import * as MyTool from "./tools/MyTool.js";

server.registerTool(MyTool.name, {
  title: "My Tool",
  description: MyTool.description,
  inputSchema: MyTool.inputSchema,
}, async (input) => MyTool.execute(input, api));
```

3. Add test in `src/tests/MyTool.test.ts`

## YNAB API Reference
- YNAB SDK types: `node_modules/ynab/dist/index.d.ts`
- OpenAPI spec: https://api.ynab.com/papi/open_api_spec.yaml
- Amounts are in milliunits (multiply dollars by 1000)