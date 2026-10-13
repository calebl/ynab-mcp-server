import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { toMilliunits } from "./money.js";
import { formatCategory } from "./categoryFormat.js";

export const name = "ynab_update_category";
export const description = "Updates a category's name, note, category group, or goal target. Only the fields you provide change. goalTarget is in dollars; setting it on a category without a goal creates a monthly goal (YNAB defaults the goal type). Goals cannot be removed with this tool.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  categoryId: z.string().describe("The ID of the category to update"),
  name: z.string().min(1).optional().describe("New category name"),
  note: z.string().optional().describe("New category note; an empty string clears it"),
  categoryGroupId: z.string().optional().describe("Move the category to this category group ID (internal groups are rejected by YNAB)"),
  goalTarget: z.number().nonnegative().optional().describe("Goal target amount in dollars (e.g. 250.00). Creates a monthly goal if the category has none."),
  goalTargetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Goal target date in ISO format (e.g. 2026-12-01)"),
  goalNeedsWholeAmount: z.boolean().optional().describe("NEED goals only: true = 'Set aside another…', false = 'Refill up to…'"),
};

interface UpdateCategoryInput {
  planId?: string;
  budgetId?: string;
  categoryId: string;
  name?: string;
  note?: string;
  categoryGroupId?: string;
  goalTarget?: number;
  goalTargetDate?: string;
  goalNeedsWholeAmount?: boolean;
}

export async function execute(input: UpdateCategoryInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const category: ynab.ExistingCategory = {};
    if (input.name !== undefined) category.name = input.name;
    if (input.note !== undefined) category.note = input.note;
    if (input.categoryGroupId !== undefined) category.category_group_id = input.categoryGroupId;
    if (input.goalTarget !== undefined) category.goal_target = toMilliunits(input.goalTarget);
    if (input.goalTargetDate !== undefined) category.goal_target_date = input.goalTargetDate;
    if (input.goalNeedsWholeAmount !== undefined) category.goal_needs_whole_amount = input.goalNeedsWholeAmount;
    if (Object.keys(category).length === 0) {
      throw new Error("Provide at least one field to update: name, note, categoryGroupId, goalTarget, goalTargetDate, goalNeedsWholeAmount");
    }

    const response = await api.categories.updateCategory(planId, input.categoryId, { category });
    const updated = formatCategory(response.data.category);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ success: true, category: updated, message: `Updated category ${updated.name}` }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error updating category:", error);
    return toolError(getErrorMessage(error));
  }
}
