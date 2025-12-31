#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { Command } from "commander";
import * as ynab from "ynab";

// Import all tools
import * as ListBudgetsTool from "./tools/ListBudgetsTool.js";
import * as GetUnapprovedTransactionsTool from "./tools/GetUnapprovedTransactionsTool.js";
import * as BudgetSummaryTool from "./tools/BudgetSummaryTool.js";
import * as CreateTransactionTool from "./tools/CreateTransactionTool.js";
import * as ApproveTransactionTool from "./tools/ApproveTransactionTool.js";
import * as UpdateCategoryBudgetTool from "./tools/UpdateCategoryBudgetTool.js";
import * as UpdateTransactionTool from "./tools/UpdateTransactionTool.js";
import * as BulkApproveTransactionsTool from "./tools/BulkApproveTransactionsTool.js";
import * as ListPayeesTool from "./tools/ListPayeesTool.js";
import * as GetTransactionsTool from "./tools/GetTransactionsTool.js";
import * as DeleteTransactionTool from "./tools/DeleteTransactionTool.js";
import * as ListCategoriesTool from "./tools/ListCategoriesTool.js";
import * as ListAccountsTool from "./tools/ListAccountsTool.js";
import * as ListScheduledTransactionsTool from "./tools/ListScheduledTransactionsTool.js";
import * as ImportTransactionsTool from "./tools/ImportTransactionsTool.js";
import * as ListMonthsTool from "./tools/ListMonthsTool.js";

const VERSION = "0.1.2";

// Initialize YNAB API
const api = new ynab.API(process.env.YNAB_API_TOKEN || "");

// Function to register all tools on a server instance
function registerTools(server: McpServer) {
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

  server.registerTool(UpdateCategoryBudgetTool.name, {
    title: "Update Category Budget",
    description: UpdateCategoryBudgetTool.description,
    inputSchema: UpdateCategoryBudgetTool.inputSchema,
  }, async (input) => UpdateCategoryBudgetTool.execute(input, api));

  server.registerTool(UpdateTransactionTool.name, {
    title: "Update Transaction",
    description: UpdateTransactionTool.description,
    inputSchema: UpdateTransactionTool.inputSchema,
  }, async (input) => UpdateTransactionTool.execute(input, api));

  server.registerTool(BulkApproveTransactionsTool.name, {
    title: "Bulk Approve Transactions",
    description: BulkApproveTransactionsTool.description,
    inputSchema: BulkApproveTransactionsTool.inputSchema,
  }, async (input) => BulkApproveTransactionsTool.execute(input, api));

  server.registerTool(ListPayeesTool.name, {
    title: "List Payees",
    description: ListPayeesTool.description,
    inputSchema: ListPayeesTool.inputSchema,
  }, async (input) => ListPayeesTool.execute(input, api));

  server.registerTool(GetTransactionsTool.name, {
    title: "Get Transactions",
    description: GetTransactionsTool.description,
    inputSchema: GetTransactionsTool.inputSchema,
  }, async (input) => GetTransactionsTool.execute(input, api));

  server.registerTool(DeleteTransactionTool.name, {
    title: "Delete Transaction",
    description: DeleteTransactionTool.description,
    inputSchema: DeleteTransactionTool.inputSchema,
  }, async (input) => DeleteTransactionTool.execute(input, api));

  server.registerTool(ListCategoriesTool.name, {
    title: "List Categories",
    description: ListCategoriesTool.description,
    inputSchema: ListCategoriesTool.inputSchema,
  }, async (input) => ListCategoriesTool.execute(input, api));

  server.registerTool(ListAccountsTool.name, {
    title: "List Accounts",
    description: ListAccountsTool.description,
    inputSchema: ListAccountsTool.inputSchema,
  }, async (input) => ListAccountsTool.execute(input, api));

  server.registerTool(ListScheduledTransactionsTool.name, {
    title: "List Scheduled Transactions",
    description: ListScheduledTransactionsTool.description,
    inputSchema: ListScheduledTransactionsTool.inputSchema,
  }, async (input) => ListScheduledTransactionsTool.execute(input, api));

  server.registerTool(ImportTransactionsTool.name, {
    title: "Import Transactions",
    description: ImportTransactionsTool.description,
    inputSchema: ImportTransactionsTool.inputSchema,
  }, async (input) => ImportTransactionsTool.execute(input, api));

  server.registerTool(ListMonthsTool.name, {
    title: "List Months",
    description: ListMonthsTool.description,
    inputSchema: ListMonthsTool.inputSchema,
  }, async (input) => ListMonthsTool.execute(input, api));
}

// Start server in stdio mode
async function startStdioServer() {
  const server = new McpServer({
    name: "ynab-mcp-server",
    version: VERSION,
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("YNAB MCP server running on stdio");
}

// Start server in HTTP mode
async function startHttpServer(port: number) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  // SSE endpoint for MCP
  app.post('/sse', async (req, res) => {
    console.error("New SSE connection");

    const server = new McpServer({
      name: "ynab-mcp-server",
      version: VERSION,
    });

    registerTools(server);

    const transport = new SSEServerTransport('/message', res);
    await server.connect(transport);

    // Handle client disconnect
    req.on('close', () => {
      console.error("SSE connection closed");
    });
  });

  // Message endpoint for client requests
  app.post('/message', async (req, res) => {
    // This is handled by the SSE transport
    res.status(405).json({ error: 'Use SSE endpoint' });
  });

  const httpServer = app.listen(port, () => {
    console.error(`YNAB MCP server running on http://localhost:${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
    console.error(`Health check: http://localhost:${port}/health`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.error('SIGTERM received, shutting down gracefully');
    httpServer.close(() => {
      console.error('Server closed');
      process.exit(0);
    });
  });
}

// Main entry point with CLI
async function main() {
  const program = new Command();

  program
    .name('ynab-mcp-server')
    .description('YNAB MCP Server - provides AI tools for interacting with YNAB budgets')
    .version(VERSION);

  program
    .option('--http', 'Run as HTTP server with SSE transport')
    .option('-p, --port <port>', 'Port for HTTP server', '3000')
    .parse(process.argv);

  const options = program.opts();

  if (options.http) {
    await startHttpServer(parseInt(options.port));
  } else {
    await startStdioServer();
  }
}

main().catch(console.error);
