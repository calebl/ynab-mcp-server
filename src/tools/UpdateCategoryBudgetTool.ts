import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_update_category_budget";
export const description = "Updates the budgeted amount for a category in a specific month. Use this to allocate funds to categories or move money between categories.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The budget month in ISO format (e.g. 2024-01-01). Must be the first day of the month."),
  categoryId: z.string().describe("The ID of the category to update"),
  budgeted: z.number().describe("The amount to budget in dollars (e.g. 500.00). This sets the total budgeted amount, not an increment."),
};

interface UpdateCategoryBudgetInput {
  budgetId?: string;
  month: string;
  categoryId: string;
  budgeted: number;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

export async function execute(input: UpdateCategoryBudgetInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);
    const budgetedMilliunits = Math.round(input.budgeted * 1000);

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
            budgeted: (category.budgeted / 1000).toFixed(2),
            activity: (category.activity / 1000).toFixed(2),
            balance: (category.balance / 1000).toFixed(2),
          },
          message: `Successfully updated ${category.name} budget to $${(category.budgeted / 1000).toFixed(2)}`,
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
