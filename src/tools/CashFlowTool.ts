import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";
import { round2 } from "./spending.js";

export const name = "ynab_cash_flow";
export const description = "Income versus spending, month by month, so you can see whether you are running a surplus. Uses YNAB's own monthly totals rather than re-adding transactions.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  months: z.number().positive().optional().describe("How many of the most recent months to report on (default: 6)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only include months on or after this date (ISO format: 2024-01-01). Overrides the months count."),
};

interface CashFlowInput {
  budgetId?: string;
  months?: number;
  sinceDate?: string;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

export async function execute(input: CashFlowInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);

    const response = await api.months.getBudgetMonths(budgetId);
    const allMonths = response.data.months
      .filter((month) => !month.deleted)
      .sort((a, b) => a.month.localeCompare(b.month));

    const selected = input.sinceDate
      ? allMonths.filter((month) => month.month >= input.sinceDate!)
      : allMonths.slice(-(input.months ?? 6));

    const months = selected.map((month) => {
      const income = toDollars(month.income);
      // YNAB reports activity as a negative number for net outflow.
      const spent = toDollars(-month.activity);
      return {
        month: month.month,
        income,
        spent,
        net: round2(income - spent),
        budgeted: toDollars(month.budgeted),
      };
    });

    const totalIncome = round2(months.reduce((sum, m) => sum + m.income, 0));
    const totalSpent = round2(months.reduce((sum, m) => sum + m.spent, 0));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          month_count: months.length,
          total_income: totalIncome,
          total_spent: totalSpent,
          net: round2(totalIncome - totalSpent),
          average_monthly_net: months.length > 0 ? round2((totalIncome - totalSpent) / months.length) : 0,
          months,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting cash flow:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }
}
