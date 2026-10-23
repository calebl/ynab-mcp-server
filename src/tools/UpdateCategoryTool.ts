import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars, toMilliunits } from "./money.js";
import {
  describeResolution,
  exactKey,
  loadGroups,
  resolveCategory,
  resolveGroup,
  validateGoal,
} from "./categoryGroups.js";

export const name = "ynab_update_category";
export const description = "Renames a category, moves it to another group, or changes its note or target. Give the category as categoryId or categoryName (hidden categories included); prefer categoryId when repeating a call, since a rename changes what a name matches. Only the fields you pass change; note \"\" clears the note. Moving never creates a group - use ynab_create_category for that. To change the amount assigned in a month, use ynab_update_category_budget. Categories can't be hidden or deleted through the API.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  categoryId: z.string().optional().describe("The id of the category to change (optional if categoryName is provided; wins if both are given)"),
  categoryName: z.string().optional().describe("The name of the category to change, matched exactly first, then loosely. Optional if categoryId is provided."),
  name: z.string().optional().describe("The category's new name (optional)"),
  note: z.string().optional().describe("The category's new note; an empty string clears it (optional)"),
  categoryGroupId: z.string().optional().describe("The id of the group to move the category into (optional)"),
  categoryGroupName: z.string().optional().describe("The name of the group to move the category into, matched exactly first, then loosely (optional; ignored if categoryGroupId is provided)"),
  goalTarget: z.number().optional().describe("New target amount in dollars, zero or more (optional)"),
  goalTargetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("New target date in ISO format (e.g. 2027-03-01), optional"),
};

interface UpdateCategoryInput {
  planId?: string;
  budgetId?: string;
  categoryId?: string;
  categoryName?: string;
  name?: string;
  note?: string;
  categoryGroupId?: string;
  categoryGroupName?: string;
  goalTarget?: number;
  goalTargetDate?: string;
}

function summarize(category: ynab.Category, groupName: string, decimalDigits: number) {
  return {
    name: category.name,
    category_group_id: category.category_group_id,
    category_group_name: groupName,
    note: category.note ?? null,
    goal_target: category.goal_target != null ? toDollars(category.goal_target, decimalDigits) : null,
    goal_target_date: category.goal_target_date ?? null,
  };
}

export async function execute(input: UpdateCategoryInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    if (input.categoryId === undefined && input.categoryName === undefined) {
      throw new Error("Either categoryId or categoryName must be provided");
    }
    const newName = input.name?.trim();
    if (newName !== undefined && !exactKey(newName)) throw new Error("name must contain a letter or number");
    const moving = input.categoryGroupId !== undefined || input.categoryGroupName !== undefined;
    if (newName === undefined && input.note === undefined && !moving && input.goalTarget === undefined && input.goalTargetDate === undefined) {
      throw new Error("Nothing to change: pass at least one of name, note, categoryGroupId, categoryGroupName, goalTarget or goalTargetDate");
    }
    validateGoal(input.goalTarget, input.goalTargetDate);

    const groups = await loadGroups(planId, api);
    const categoryLookup = input.categoryId !== undefined ? { id: input.categoryId } : { name: input.categoryName };
    const match = resolveCategory(groups, categoryLookup);
    if (match.kind !== "found") throw new Error(describeResolution(match, "category", input.categoryName ?? input.categoryId!));
    const category = match.item;

    const patch: ynab.ExistingCategory = {};
    let targetGroup = category.group;
    if (moving) {
      const groupLookup = input.categoryGroupId !== undefined ? { id: input.categoryGroupId } : { name: input.categoryGroupName?.trim() };
      const group = resolveGroup(groups, groupLookup);
      if (group.kind !== "found") throw new Error(describeResolution(group, "category group", input.categoryGroupName ?? input.categoryGroupId!));
      targetGroup = group.item;
      if (targetGroup.id !== category.category_group_id) patch.category_group_id = targetGroup.id;
    }
    const finalName = newName ?? category.name;
    const clash = targetGroup.categories.find((other) => other.id !== category.id && exactKey(other.name) === exactKey(finalName));
    if (clash) throw new Error(`The group "${targetGroup.name}" already has a category named "${clash.name}" (id ${clash.id})`);

    if (newName !== undefined) patch.name = newName;
    if (input.note !== undefined) patch.note = input.note;
    if (input.goalTarget !== undefined) patch.goal_target = toMilliunits(input.goalTarget);
    if (input.goalTargetDate !== undefined) patch.goal_target_date = input.goalTargetDate;

    const [response, decimalDigits] = await Promise.all([
      api.categories.updateCategory(planId, category.id, { category: patch }),
      getDecimalDigits(api, planId),
    ]);
    const updated = response.data.category;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          matchedCategory: category.name,
          category_id: category.id,
          before: summarize(category, category.group.name, decimalDigits),
          after: summarize(updated, targetGroup.name, decimalDigits),
          message: `Updated ${updated.name}`,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error updating category:", error);
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
