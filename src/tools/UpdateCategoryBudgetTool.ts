import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";

export const name = "ynab_update_category_budget";
export const description = "Updates the budgeted amount for a category in a specific month. Use this to allocate funds to categories or move money between categories.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The budget month in ISO format (e.g. 2024-01-01). Must be the first day of the month."),
  categoryId: z.string().describe("The ID of the category to update"),
  budgeted: z.number().describe("The amount to budget in dollars (e.g. 500.00). This sets the total budgeted amount, not an increment."),
};

interface UpdateCategoryBudgetInput {
  planId?: string;
  budgetId?: string;
  month: string;
  categoryId: string;
  budgeted: number;
}


export async function execute(input: UpdateCategoryBudgetInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const budgetedMilliunits = toMilliunits(input.budgeted);

    const response = await api.categories.updateMonthCategory(
      budgetId,
      input.month,
      input.categoryId,
      {
        category: {
          budgeted: budgetedMilliunits,
        },
      }
    );

    if (!response.data.category) {
      throw new Error("Failed to update category - no category data returned");
    }

    const category = response.data.category;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          category: {
            id: category.id,
            name: category.name,
            budgeted: toDollars(category.budgeted),
            activity: toDollars(category.activity),
            balance: toDollars(category.balance),
          },
          message: `Successfully updated ${category.name} budget to $${toDollars(category.budgeted).toFixed(2)}`,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error updating category budget:", error);
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
