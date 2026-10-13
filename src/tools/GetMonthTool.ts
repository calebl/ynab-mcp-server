import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { toDollars } from "./money.js";
import { formatCategory } from "./categoryFormat.js";

export const name = "ynab_get_month";
export const description = "Gets one plan month: income, budgeted, activity, Ready to Assign and age of money, plus every non-deleted category's values for that month (hidden categories included and flagged).";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The plan month in ISO format (e.g. 2024-01-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
};

interface GetMonthInput {
  planId?: string;
  budgetId?: string;
  month?: string;
}

export async function execute(input: GetMonthInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.months.getPlanMonth(planId, input.month ?? "current");
    const m = response.data.month;
    const categories = m.categories.filter((c) => !c.deleted).map(formatCategory);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          month: m.month,
          note: m.note ?? null,
          income: toDollars(m.income),
          budgeted: toDollars(m.budgeted),
          activity: toDollars(m.activity),
          to_be_budgeted: toDollars(m.to_be_budgeted),
          age_of_money: m.age_of_money ?? null,
          categories,
          category_count: categories.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting month:", error);
    return toolError(getErrorMessage(error));
  }
}
