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
import * as UpdateCategoryBudgetTool from "./tools/UpdateCategoryBudgetTool.js";
import * as UpdateTransactionTool from "./tools/UpdateTransactionTool.js";
import * as BulkApproveTransactionsTool from "./tools/BulkApproveTransactionsTool.js";
import * as ListPayeesTool from "./tools/ListPayeesTool.js";
import * as GetTransactionsTool from "./tools/GetTransactionsTool.js";
import * as DeleteTransactionTool from "./tools/DeleteTransactionTool.js";
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
// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("YNAB MCP server running on stdio");
}
main().catch(console.error);
