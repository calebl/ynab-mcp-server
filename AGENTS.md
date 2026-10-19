# AGENTS.md

This is the shared instructions file for coding agents working in this repository (CLAUDE.md points here).

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

This is a **Model Context Protocol (MCP) server** that provides AI tools for interacting with YNAB (You Need A Budget) plans. Built with `@modelcontextprotocol/sdk`.

### Core Structure
- **Tool registry**: `src/registry.ts` - the single list of tools, shared by both entry points
- **stdio entry**: `src/index.ts` - local server for Claude Code / Claude Desktop
- **Worker entry**: `src/worker/` - Cloudflare Worker serving the same tools over HTTP behind GitHub OAuth (see `DEPLOY.md`)
- **Auto-budget service**: `src/worker/autobudget/` - Worker-only scheduled job and its MCP tools, with D1 schema in `migrations/` (see `DEPLOY.md`)
- **Tools**: `src/tools/*.ts` - Each tool is a separate module exporting `name`, `description`, `inputSchema`, and `execute` function
- **Tests**: `src/tests/*.test.ts` - Vitest tests for each tool

### Tool Module Pattern
Each tool in `src/tools/` exports:
- `name`: Tool identifier (snake_case)
- `description`: Tool description
- `inputSchema`: Zod schema object for input validation
- `execute(input, api)`: Async handler receiving input and YNAB API client

Tools are listed in `src/registry.ts`; `registerAll` passes the shared YNAB `api` instance to each handler.

### Before adding a tool
Check whether the behavior fits as an option on an existing tool (a new filter, date bound, or output mode) before creating a new one. Add a new tool only when no existing tool covers the same data and intent, and say in the PR which existing tools were considered and why they didn't fit. Overlapping tools make the model more likely to pick the wrong one.

### Environment Variables

The user-facing configuration is owned by the environment-variable table in
`README.md` and the Worker-specific settings in `DEPLOY.md`.

The tool modules read `process.env` directly. The Worker has no ambient
environment, so `src/worker/mcp.ts` mirrors its bindings onto `process.env`
before building the server.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
