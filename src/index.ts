#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as ynab from "ynab";

// Import all tools
import * as ListBudgetsTool from "./tools/ListBudgetsTool.js";
import * as GetUnapprovedTransactionsTool from "./tools/GetUnapprovedTransactionsTool.js";
import * as BudgetSummaryTool from "./tools/BudgetSummaryTool.js";
import * as CreateTransactionTool from "./tools/CreateTransactionTool.js";
import * as ApproveTransactionTool from "./tools/ApproveTransactionTool.js";

const server = new McpServer({
  name: "ynab-mcp-server",
  version: "0.1.2",
});

// Initialize YNAB API
const api = new ynab.API(process.env.YNAB_API_TOKEN || "");

// Register all tools
server.registerTool(ListBudgetsTool.name, {
  title: "List Budgets",
  description: ListBudgetsTool.description,
  inputSchema: ListBudgetsTool.inputSchema,
}, async (input) => ListBudgetsTool.execute(input, api));

server.registerTool(GetUnapprovedTransactionsTool.name, {
  title: "Get Unapproved Transactions",
  description: GetUnapprovedTransactionsTool.description,
  inputSchema: GetUnapprovedTransactionsTool.inputSchema,
}, async (input) => GetUnapprovedTransactionsTool.execute(input, api));

server.registerTool(BudgetSummaryTool.name, {
  title: "Budget Summary",
  description: BudgetSummaryTool.description,
  inputSchema: BudgetSummaryTool.inputSchema,
}, async (input) => BudgetSummaryTool.execute(input, api));

server.registerTool(CreateTransactionTool.name, {
  title: "Create Transaction",
  description: CreateTransactionTool.description,
  inputSchema: CreateTransactionTool.inputSchema,
}, async (input) => CreateTransactionTool.execute(input, api));

server.registerTool(ApproveTransactionTool.name, {
  title: "Approve Transaction",
  description: ApproveTransactionTool.description,
  inputSchema: ApproveTransactionTool.inputSchema,
}, async (input) => ApproveTransactionTool.execute(input, api));

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("YNAB MCP server running on stdio");
}

main().catch(console.error);
