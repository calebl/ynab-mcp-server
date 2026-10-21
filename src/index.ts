#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as ynab from "ynab";

import { isReadOnly, registerAll } from "./registry.js";

const server = new McpServer({
  name: "ynab-mcp-server",
  version: "0.6.0",
});

// Initialize YNAB API
const api = new ynab.API(process.env.YNAB_API_TOKEN || "");

const readOnly = isReadOnly(process.env.YNAB_READ_ONLY);
registerAll(server, api, { readOnly });

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`YNAB MCP server running on stdio${readOnly ? " (read-only)" : ""}`);
}

main().catch(console.error);
