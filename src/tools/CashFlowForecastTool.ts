import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, milliUnitsToAmount, formatCurrency } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface CashFlowForecastInput {
  budgetId?: string;
  months?: number;
  accountId?: string;
  includeProjections?: boolean;
  response_format?: "json" | "markdown";
  limit?: number;
  offset?: number;
}

interface CashFlowProjection {
  month: string;
  projected_balance: number;
  projected_balance_dollars: number;
  income: number;
  income_dollars: number;
  expenses: number;
  expenses_dollars: number;
  net_cash_flow: number;
  net_cash_flow_dollars: number;
  confidence_level: 'high' | 'medium' | 'low';
}

interface CashFlowInsight {
  type: 'warning' | 'opportunity' | 'trend';
  message: string;
  severity: 'low' | 'medium' | 'high';
  month?: string;
  data: any;
}

interface CashFlowForecastResult {
  forecast_period: string;
  account_analyzed: string;
  current_balance: number;
  current_balance_dollars: number;
  projections: CashFlowProjection[];
  insights: CashFlowInsight[];
  summary: {
    projected_balance_end: number;
    total_income_projected: number;
    total_expenses_projected: number;
    net_cash_flow_total: number;
    months_until_negative: number | null;
    months_until_goal: number | null;
  };
  pagination: {
    total: number;
    count: number;
    offset: number;
    limit: number;
    has_more: boolean;
    next_offset: number | null;
  };
  note: string;
}

export default class CashFlowForecastTool {
  private api: ynab.API;
  private budgetId: string | undefined;

  constructor() {
    const token = process.env.YNAB_API_TOKEN;
    if (!token) {
      throw new Error("YNAB_API_TOKEN environment variable is required");
    }
    this.api = new ynab.API(token);
    this.budgetId = process.env.YNAB_BUDGET_ID;
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_cash_flow_forecast",
      description: "Generate cash flow projections for accounts based on historical income and expense patterns to forecast future balances.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to analyze (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          months: {
            type: "number",
            default: 6,
            description: "Number of months to forecast (default: 6, max: 12)",
          },
          accountId: {
            type: "string",
            description: "Specific account ID to forecast (optional, if not provided forecasts primary checking account)",
          },
          includeProjections: {
            type: "boolean",
            default: true,
            description: "Whether to include detailed monthly projections",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
          limit: {
            type: "number",
            default: 50,
            description: "Maximum number of projections to return (default: 50, max: 100)",
          },
          offset: {
            type: "number",
            default: 0,
            description: "Number of projections to skip (default: 0)",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Cash Flow Forecast",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: CashFlowForecastInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      const monthsToForecast = Math.min(input.months || 6, 12);
      const includeProjections = input.includeProjections !== false;
      console.error(`Generating cash flow forecast for budget ${budgetId} for ${monthsToForecast} months`);
      
      // Get accounts
      const accountsResponse = await createRetryableAPICall(
        () => this.api.accounts.getAccounts(budgetId),
        'Get accounts for cash flow forecast'
      );
      const accounts = accountsResponse.data.accounts.filter(
        account =>
          account.deleted === false &&
          account.closed === false &&
          account.on_budget === true
      );

      // Find target account
      let targetAccount = accounts.find(account => account.id === input.accountId);
      if (!targetAccount && input.accountId) {
        return {
          content: [
            {
              type: "text",
              text: `Account with ID ${input.accountId} not found. Use the budget_summary tool to see available accounts.`,
            },
          ],
        };
      }
      
      // If no specific account, use the primary checking account or first on-budget account
      if (!targetAccount) {
        targetAccount = accounts.find(account => 
          account.type === 'checking' || account.type === 'cash'
        ) || accounts[0];
      }

      if (!targetAccount) {
        return {
          content: [
            {
              type: "text",
              text: "No suitable account found for cash flow forecasting. Please specify an account ID or ensure you have on-budget accounts.",
            },
          ],
        };
      }

      // Get historical transaction data for the last 6 months to establish patterns
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(endDate.getMonth() - 6);

      const transactionsResponse = await createRetryableAPICall(
        () => this.api.transactions.getTransactionsByAccount(
          budgetId,
          targetAccount.id,
          startDate.toISOString().split('T')[0]
        ),
        'Get transactions for cash flow forecast'
      );

      const transactions = transactionsResponse.data.transactions.filter(
        t => t.deleted === false
      );

      // Analyze historical patterns
      const monthlyData: { [month: string]: { income: number; expenses: number } } = {};
      
      for (const transaction of transactions) {
        const month = transaction.date.substring(0, 7); // YYYY-MM
        if (!monthlyData[month]) {
          monthlyData[month] = { income: 0, expenses: 0 };
        }
        
        if (transaction.amount > 0) {
          monthlyData[month].income += transaction.amount;
        } else {
          monthlyData[month].expenses += Math.abs(transaction.amount);
        }
      }

      // Calculate average monthly income and expenses
      const monthlyValues = Object.values(monthlyData);
      const avgMonthlyIncome = monthlyValues.length > 0 ? 
        monthlyValues.reduce((sum, month) => sum + month.income, 0) / monthlyValues.length : 0;
      const avgMonthlyExpenses = monthlyValues.length > 0 ? 
        monthlyValues.reduce((sum, month) => sum + month.expenses, 0) / monthlyValues.length : 0;

      // Calculate variance for confidence levels
      const incomeVariance = monthlyValues.length > 1 ? 
        monthlyValues.reduce((sum, month) => sum + Math.pow(month.income - avgMonthlyIncome, 2), 0) / monthlyValues.length : 0;
      const expenseVariance = monthlyValues.length > 1 ? 
        monthlyValues.reduce((sum, month) => sum + Math.pow(month.expenses - avgMonthlyExpenses, 2), 0) / monthlyValues.length : 0;

      // Generate projections
      const projections: CashFlowProjection[] = [];
      const insights: CashFlowInsight[] = [];
      let currentBalance = targetAccount.balance;
      let totalIncomeProjected = 0;
      let totalExpensesProjected = 0;
      let monthsUntilNegative: number | null = null;
      let monthsUntilGoal: number | null = null;

      for (let i = 1; i <= monthsToForecast; i++) {
        const projectionDate = new Date();
        projectionDate.setMonth(projectionDate.getMonth() + i);
        const monthKey = projectionDate.toISOString().substring(0, 7);

        // Apply some seasonal variation (simplified)
        const seasonalFactor = 1 + (Math.sin((i - 1) * Math.PI / 6) * 0.1); // ±10% variation
        
        const projectedIncome = avgMonthlyIncome * seasonalFactor;
        const projectedExpenses = avgMonthlyExpenses * seasonalFactor;
        const netCashFlow = projectedIncome - projectedExpenses;
        
        currentBalance += netCashFlow;
        totalIncomeProjected += projectedIncome;
        totalExpensesProjected += projectedExpenses;

        // Determine confidence level based on variance
        let confidenceLevel: 'high' | 'medium' | 'low' = 'medium';
        const totalVariance = incomeVariance + expenseVariance;
        const avgAmount = (avgMonthlyIncome + avgMonthlyExpenses) / 2;
        
        if (totalVariance < avgAmount * 0.1) {
          confidenceLevel = 'high';
        } else if (totalVariance > avgAmount * 0.3) {
          confidenceLevel = 'low';
        }

        // Track when balance goes negative
        if (monthsUntilNegative === null && currentBalance < 0) {
          monthsUntilNegative = i;
        }

        // Track when balance reaches a reasonable goal (e.g., 3 months expenses)
        const goalAmount = avgMonthlyExpenses * 3;
        if (monthsUntilGoal === null && currentBalance >= goalAmount) {
          monthsUntilGoal = i;
        }

        projections.push({
          month: monthKey,
          projected_balance: currentBalance,
          projected_balance_dollars: Math.round(milliUnitsToAmount(currentBalance) * 100) / 100,
          income: projectedIncome,
          income_dollars: Math.round(milliUnitsToAmount(projectedIncome) * 100) / 100,
          expenses: projectedExpenses,
          expenses_dollars: Math.round(milliUnitsToAmount(projectedExpenses) * 100) / 100,
          net_cash_flow: netCashFlow,
          net_cash_flow_dollars: Math.round(milliUnitsToAmount(netCashFlow) * 100) / 100,
          confidence_level: confidenceLevel,
        });
      }

      // Generate insights
      if (includeProjections) {
        // Negative balance warning
        if (monthsUntilNegative !== null) {
          insights.push({
            type: 'warning',
            message: `Projected to go negative in ${monthsUntilNegative} months based on current patterns`,
            severity: 'high',
            month: projections[monthsUntilNegative - 1]?.month,
            data: { months_until_negative: monthsUntilNegative }
          });
        }

        // Emergency fund achievement
        if (monthsUntilGoal !== null) {
          insights.push({
            type: 'opportunity',
            message: `Could build 3-month emergency fund in ${monthsUntilGoal} months`,
            severity: 'low',
            month: projections[monthsUntilGoal - 1]?.month,
            data: { months_until_goal: monthsUntilGoal }
          });
        }

        // Cash flow trend
        const netCashFlowTotal = totalIncomeProjected - totalExpensesProjected;
        if (netCashFlowTotal > 0) {
          insights.push({
            type: 'trend',
            message: `Positive cash flow trend: +${formatCurrency(milliUnitsToAmount(netCashFlowTotal))} over ${monthsToForecast} months`,
            severity: 'low',
            data: { net_cash_flow_total: netCashFlowTotal }
          });
        } else {
          insights.push({
            type: 'warning',
            message: `Negative cash flow trend: -${formatCurrency(Math.abs(milliUnitsToAmount(netCashFlowTotal)))} over ${monthsToForecast} months`,
            severity: 'medium',
            data: { net_cash_flow_total: netCashFlowTotal }
          });
        }
      }

      // Apply pagination
      const limit = Math.min(input.limit || 50, 100);
      const offset = input.offset || 0;
      const total = projections.length;
      const paginatedProjections = projections.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      const nextOffset = hasMore ? offset + limit : null;

      const result: CashFlowForecastResult = {
        forecast_period: `${monthsToForecast} months starting ${new Date().toISOString().substring(0, 7)}`,
        account_analyzed: targetAccount.name,
        current_balance: targetAccount.balance,
        current_balance_dollars: Math.round(milliUnitsToAmount(targetAccount.balance) * 100) / 100,
        projections: paginatedProjections,
        insights: insights,
        summary: {
          projected_balance_end: Math.round(milliUnitsToAmount(currentBalance) * 100) / 100,
          total_income_projected: Math.round(milliUnitsToAmount(totalIncomeProjected) * 100) / 100,
          total_expenses_projected: Math.round(milliUnitsToAmount(totalExpensesProjected) * 100) / 100,
          net_cash_flow_total: Math.round(milliUnitsToAmount(totalIncomeProjected - totalExpensesProjected) * 100) / 100,
          months_until_negative: monthsUntilNegative,
          months_until_goal: monthsUntilGoal,
        },
        pagination: {
          total,
          count: paginatedProjections.length,
          offset,
          limit,
          has_more: hasMore,
          next_offset: nextOffset,
        },
        note: "All amounts are in dollars. Projections based on historical patterns and may not account for irregular income, large purchases, or lifestyle changes. Confidence levels reflect historical variance in income and expenses.",
      };

      const format = input.response_format || "markdown";
      let responseText: string;

      if (format === "json") {
        responseText = JSON.stringify(result, null, 2);
      } else {
        responseText = this.formatMarkdown(result);
      }

      const { text, wasTruncated } = truncateResponse(responseText, CHARACTER_LIMIT);

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error generating cash flow forecast: ${errorMessage}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: CashFlowForecastResult): string {
    let output = "# Cash Flow Forecast\n\n";

    output += "## Summary\n";
    output += `- **Forecast Period**: ${result.forecast_period}\n`;
    output += `- **Account Analyzed**: ${result.account_analyzed}\n`;
    output += `- **Showing**: ${result.pagination.count} projections (offset: ${result.pagination.offset}, limit: ${result.pagination.limit})\n`;
    output += `- **Current Balance**: ${formatCurrency(result.current_balance_dollars)}\n`;
    output += `- **Projected Balance (End)**: ${formatCurrency(result.summary.projected_balance_end)}\n`;
    output += `- **Total Income Projected**: ${formatCurrency(result.summary.total_income_projected)}\n`;
    output += `- **Total Expenses Projected**: ${formatCurrency(result.summary.total_expenses_projected)}\n`;
    output += `- **Net Cash Flow Total**: ${formatCurrency(result.summary.net_cash_flow_total)}\n`;
    if (result.summary.months_until_negative !== null) {
      output += `- **Months Until Negative**: ${result.summary.months_until_negative}\n`;
    }
    if (result.summary.months_until_goal !== null) {
      output += `- **Months Until Goal**: ${result.summary.months_until_goal}\n`;
    }
    output += "\n";

    if (result.projections.length > 0) {
      output += "## Monthly Projections\n\n";
      for (const projection of result.projections) {
        const confidenceEmoji = projection.confidence_level === 'high' ? '🟢' :
                               projection.confidence_level === 'medium' ? '🟡' : '🔴';
        output += `### ${projection.month} ${confidenceEmoji}\n`;
        output += `- **Projected Balance**: ${formatCurrency(projection.projected_balance_dollars)}\n`;
        output += `- **Income**: ${formatCurrency(projection.income_dollars)}\n`;
        output += `- **Expenses**: ${formatCurrency(projection.expenses_dollars)}\n`;
        output += `- **Net Cash Flow**: ${formatCurrency(projection.net_cash_flow_dollars)}\n`;
        output += `- **Confidence Level**: ${projection.confidence_level}\n\n`;
      }
    }

    if (result.insights.length > 0) {
      output += "## Insights\n\n";
      for (const insight of result.insights) {
        const emoji = insight.type === 'warning' ? '⚠️' :
                     insight.type === 'opportunity' ? '💡' : '📊';
        output += `${emoji} **${insight.severity.toUpperCase()}**: ${insight.message}\n`;
        if (insight.month) {
          output += `   _Month: ${insight.month}_\n`;
        }
        output += "\n";
      }
    }

    // Add pagination info
    output += "---\n\n";
    output += "## Pagination\n";
    output += `- **Total**: ${result.pagination.total}\n`;
    output += `- **Count**: ${result.pagination.count}\n`;
    output += `- **Offset**: ${result.pagination.offset}\n`;
    output += `- **Limit**: ${result.pagination.limit}\n`;
    output += `- **Has More**: ${result.pagination.has_more}\n`;
    if (result.pagination.next_offset !== null) {
      output += `- **Next Offset**: ${result.pagination.next_offset}\n`;
    }
    output += "\n";

    output += `## Note\n${result.note}\n`;

    return output;
  }
}
