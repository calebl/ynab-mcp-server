import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as ynab from "ynab";

// Import all tools
import ListBudgetsTool from "./tools/ListBudgetsTool.js";
import BudgetSummaryTool from "./tools/BudgetSummaryTool.js";
import CreateTransactionTool from "./tools/CreateTransactionTool.js";
import GetUnapprovedTransactionsTool from "./tools/GetUnapprovedTransactionsTool.js";
import ApproveTransactionTool from "./tools/ApproveTransactionTool.js";
import HandleOverspendingTool from "./tools/HandleOverspendingTool.js";
import AutoDistributeFundsTool from "./tools/AutoDistributeFundsTool.js";
import BulkApproveTransactionsTool from "./tools/BulkApproveTransactionsTool.js";
import MoveFundsBetweenCategoriesTool from "./tools/MoveFundsBetweenCategoriesTool.js";
import NetWorthAnalysisTool from "./tools/NetWorthAnalysisTool.js";
import AnalyzeSpendingPatternsTool from "./tools/AnalyzeSpendingPatternsTool.js";
import GoalProgressReportTool from "./tools/GoalProgressReportTool.js";
import CashFlowForecastTool from "./tools/CashFlowForecastTool.js";
import CategoryPerformanceReviewTool from "./tools/CategoryPerformanceReviewTool.js";
import SetCategoryGoalsTool from "./tools/SetCategoryGoalsTool.js";
import BudgetFromHistoryTool from "./tools/BudgetFromHistoryTool.js";
import ReconcileAccountTool from "./tools/ReconcileAccountTool.js";
import ListTransactionsTool from "./tools/ListTransactionsTool.js";

const server = new Server(
  {
    name: "ynab-mcp-server",
    version: "0.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize tools
const listBudgetsTool = new ListBudgetsTool();
const budgetSummaryTool = new BudgetSummaryTool();
const createTransactionTool = new CreateTransactionTool();
const getUnapprovedTransactionsTool = new GetUnapprovedTransactionsTool();
const approveTransactionTool = new ApproveTransactionTool();
const handleOverspendingTool = new HandleOverspendingTool();
const autoDistributeFundsTool = new AutoDistributeFundsTool();
const bulkApproveTransactionsTool = new BulkApproveTransactionsTool();
const moveFundsBetweenCategoriesTool = new MoveFundsBetweenCategoriesTool();
const netWorthAnalysisTool = new NetWorthAnalysisTool();
const analyzeSpendingPatternsTool = new AnalyzeSpendingPatternsTool();
const goalProgressReportTool = new GoalProgressReportTool();
const cashFlowForecastTool = new CashFlowForecastTool();
const categoryPerformanceReviewTool = new CategoryPerformanceReviewTool();
const setCategoryGoalsTool = new SetCategoryGoalsTool();
const budgetFromHistoryTool = new BudgetFromHistoryTool();
const reconcileAccountTool = new ReconcileAccountTool();
const listTransactionsTool = new ListTransactionsTool();

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      listBudgetsTool.getToolDefinition(),
      budgetSummaryTool.getToolDefinition(),
      createTransactionTool.getToolDefinition(),
      getUnapprovedTransactionsTool.getToolDefinition(),
      approveTransactionTool.getToolDefinition(),
      handleOverspendingTool.getToolDefinition(),
      autoDistributeFundsTool.getToolDefinition(),
      bulkApproveTransactionsTool.getToolDefinition(),
      moveFundsBetweenCategoriesTool.getToolDefinition(),
      netWorthAnalysisTool.getToolDefinition(),
      analyzeSpendingPatternsTool.getToolDefinition(),
      goalProgressReportTool.getToolDefinition(),
      cashFlowForecastTool.getToolDefinition(),
      categoryPerformanceReviewTool.getToolDefinition(),
      setCategoryGoalsTool.getToolDefinition(),
      budgetFromHistoryTool.getToolDefinition(),
      reconcileAccountTool.getToolDefinition(),
      listTransactionsTool.getToolDefinition(),
    ],
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Note: We use 'as any' here because MCP protocol provides arguments as Record<string, unknown>
    // but each tool has its own specific input interface. The tools themselves validate inputs
    // at runtime via their inputSchema definitions. This is the standard pattern for MCP servers.
    const toolArgs = (args ?? {}) as any;

    switch (name) {
      case "ynab_list_budgets":
        return await listBudgetsTool.execute(toolArgs);
      case "ynab_budget_summary":
        return await budgetSummaryTool.execute(toolArgs);
      case "ynab_create_transaction":
        return await createTransactionTool.execute(toolArgs);
      case "ynab_get_unapproved_transactions":
        return await getUnapprovedTransactionsTool.execute(toolArgs);
      case "ynab_approve_transaction":
        return await approveTransactionTool.execute(toolArgs);
      case "ynab_handle_overspending":
        return await handleOverspendingTool.execute(toolArgs);
      case "ynab_auto_distribute_funds":
        return await autoDistributeFundsTool.execute(toolArgs);
      case "ynab_bulk_approve_transactions":
        return await bulkApproveTransactionsTool.execute(toolArgs);
      case "ynab_move_funds_between_categories":
        return await moveFundsBetweenCategoriesTool.execute(toolArgs);
      case "ynab_net_worth_analysis":
        return await netWorthAnalysisTool.execute(toolArgs);
      case "ynab_analyze_spending_patterns":
        return await analyzeSpendingPatternsTool.execute(toolArgs);
      case "ynab_goal_progress_report":
        return await goalProgressReportTool.execute(toolArgs);
      case "ynab_cash_flow_forecast":
        return await cashFlowForecastTool.execute(toolArgs);
      case "ynab_category_performance_review":
        return await categoryPerformanceReviewTool.execute(toolArgs);
      case "ynab_set_category_goals":
        return await setCategoryGoalsTool.execute(toolArgs);
      case "ynab_budget_from_history":
        return await budgetFromHistoryTool.execute(toolArgs);
      case "ynab_reconcile_account":
        return await reconcileAccountTool.execute(toolArgs);
      case "ynab_list_transactions":
        return await listTransactionsTool.execute(toolArgs);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
    };
  }
});

// Environment validation
function validateEnvironment() {
  if (!process.env.YNAB_API_TOKEN) {
    console.error("ERROR: YNAB_API_TOKEN environment variable is required");
    console.error("Please set YNAB_API_TOKEN to your YNAB Personal Access Token");
    console.error("You can get one from: https://app.ynab.com/settings/developer");
    process.exit(1);
  }

  console.error("✓ YNAB_API_TOKEN is set");

  if (process.env.YNAB_BUDGET_ID) {
    console.error(`✓ YNAB_BUDGET_ID is set: ${process.env.YNAB_BUDGET_ID}`);
  } else {
    console.error("⚠ YNAB_BUDGET_ID is not set (optional, can be provided per-request)");
  }
}

// Start the server
async function main() {
  validateEnvironment();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("YNAB MCP Server running on stdio");
}

// Handle shutdown
process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
