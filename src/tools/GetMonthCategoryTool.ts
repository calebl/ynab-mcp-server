import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { formatCategory } from "./categoryFormat.js";

export const name = "ynab_get_month_category";
export const description = "Gets one category's budgeted, activity, balance and goal fields for a specific plan month.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The plan month in ISO format (e.g. 2024-01-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
  categoryId: z.string().describe("The ID of the category"),
};

interface GetMonthCategoryInput {
  planId?: string;
  budgetId?: string;
  month?: string;
  categoryId: string;
}

export async function execute(input: GetMonthCategoryInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.categories.getMonthCategoryById(planId, input.month ?? "current", input.categoryId);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ category: formatCategory(response.data.category) }, null, 2) }],
    };
  } catch (error) {
    console.error("Error getting month category:", error);
    return toolError(getErrorMessage(error));
  }
}
