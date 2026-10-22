import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_cash_flow";
export const description = "Income versus spending, month by month, so you can see whether you are running a surplus. Uses YNAB's own monthly totals rather than re-adding transactions. For a projected balance, use ynab_balance_forecast.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  months: z.number().int().positive().optional().describe("How many of the most recent months to report on (default: 6)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only include months on or after this date (ISO format: 2024-01-01). Overrides the months count."),
};

interface CashFlowInput {
  planId?: string;
  budgetId?: string;
  months?: number;
  sinceDate?: string;
}


export async function execute(input: CashFlowInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    const [response, decimalDigits] = await Promise.all([
      api.months.getPlanMonths(budgetId),
      getDecimalDigits(api, budgetId),
    ]);
    const allMonths: ynab.MonthSummary[] = response.data.months
      .filter((month) => !month.deleted)
      .sort((a, b) => a.month.localeCompare(b.month));

    const selected = input.sinceDate
      ? allMonths.filter((month) => month.month >= input.sinceDate!)
      : allMonths.slice(-(input.months ?? 6));

    const months = selected.map((month) => ({
      month: month.month,
      income: toDollars(month.income, decimalDigits),
      spent: toDollars(-month.activity, decimalDigits),
      net: toDollars(month.income + month.activity, decimalDigits),
      budgeted: toDollars(month.budgeted, decimalDigits),
    }));

    const totalIncomeMilliunits = selected.reduce((sum, month) => sum + month.income, 0);
    const totalSpentMilliunits = selected.reduce((sum, month) => sum - month.activity, 0);
    const netMilliunits = totalIncomeMilliunits - totalSpentMilliunits;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          month_count: months.length,
          total_income: toDollars(totalIncomeMilliunits, decimalDigits),
          total_spent: toDollars(totalSpentMilliunits, decimalDigits),
          net: toDollars(netMilliunits, decimalDigits),
          average_monthly_net: months.length > 0
            ? toDollars(netMilliunits / months.length, decimalDigits)
            : 0,
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
