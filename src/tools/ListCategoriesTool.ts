import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_list_categories";
export const description = "Lists all categories in a budget, grouped by category group. Useful for finding category IDs when creating transactions or updating budgets.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
};

interface ListCategoriesInput {
  budgetId?: string;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

export async function execute(input: ListCategoriesInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);

    console.error(`Listing categories for budget ${budgetId}`);
    const response = await api.categories.getCategories(budgetId);

    // Format the response with category groups and their categories
    const categoryGroups = response.data.category_groups
      .filter((group) => !group.deleted && !group.hidden)
      .map((group) => ({
        id: group.id,
        name: group.name,
        hidden: group.hidden,
        categories: group.categories
          .filter((cat) => !cat.deleted && !cat.hidden)
          .map((cat) => ({
            id: cat.id,
            name: cat.name,
            budgeted: (cat.budgeted / 1000).toFixed(2),
            activity: (cat.activity / 1000).toFixed(2),
            balance: (cat.balance / 1000).toFixed(2),
            goal_type: cat.goal_type,
            goal_target: cat.goal_target ? (cat.goal_target / 1000).toFixed(2) : null,
            goal_percentage_complete: cat.goal_percentage_complete,
          })),
      }));

    const totalCategories = categoryGroups.reduce(
      (sum, group) => sum + group.categories.length,
      0
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          category_groups: categoryGroups,
          group_count: categoryGroups.length,
          category_count: totalCategories,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error listing categories:", error);
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
