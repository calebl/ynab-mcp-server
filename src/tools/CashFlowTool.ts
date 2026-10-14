import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, roundAmount, toDollars } from "./money.js";

export const name = "ynab_cash_flow";
export const description = "Income versus spending, month by month, so you can see whether you are running a surplus. Uses YNAB's own monthly totals rather than re-adding transactions.";
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

    const months = selected.map((month) => {
      const income = toDollars(month.income, decimalDigits);
      // YNAB reports activity as a negative number for net outflow.
      const spent = toDollars(-month.activity, decimalDigits);
      return {
        month: month.month,
        income,
        spent,
        net: roundAmount(income - spent, decimalDigits),
        budgeted: toDollars(month.budgeted, decimalDigits),
      };
    });

    const totalIncome = roundAmount(months.reduce((sum, m) => sum + m.income, 0), decimalDigits);
    const totalSpent = roundAmount(months.reduce((sum, m) => sum + m.spent, 0), decimalDigits);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          month_count: months.length,
          total_income: totalIncome,
          total_spent: totalSpent,
          net: roundAmount(totalIncome - totalSpent, decimalDigits),
          average_monthly_net: months.length > 0 ? roundAmount((totalIncome - totalSpent) / months.length, decimalDigits) : 0,
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
