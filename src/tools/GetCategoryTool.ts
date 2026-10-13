import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { formatCategory } from "./categoryFormat.js";

export const name = "ynab_get_category";
export const description = "Gets one category by ID, including hidden categories, with its current-month budgeted, activity, balance and goal fields.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  categoryId: z.string().describe("The ID of the category"),
};

interface GetCategoryInput {
  planId?: string;
  budgetId?: string;
  categoryId: string;
}

export async function execute(input: GetCategoryInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.categories.getCategoryById(planId, input.categoryId);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ category: formatCategory(response.data.category) }, null, 2) }],
    };
  } catch (error) {
    console.error("Error getting category:", error);
    return toolError(getErrorMessage(error));
  }
}
