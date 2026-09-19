import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_list_categories";
export const description = "Lists all categories in a budget, grouped by category group. Useful for finding category IDs when creating transactions or updating budgets.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
};

interface ListCategoriesInput {
  planId?: string;
  budgetId?: string;
}


export async function execute(input: ListCategoriesInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

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
            budgeted: toDollars(cat.budgeted),
            activity: toDollars(cat.activity),
            balance: toDollars(cat.balance),
            goal_type: cat.goal_type,
            goal_target: cat.goal_target ? toDollars(cat.goal_target) : null,
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
