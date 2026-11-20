import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars, toMilliunits } from "./money.js";
import {
  MAX_GROUP_NAME_LENGTH,
  describeResolution,
  exactKey,
  loadGroups,
  resolveGroup,
  validateGoal,
} from "./categoryGroups.js";

export const name = "ynab_create_category";
export const description = "Creates a category in an existing category group, given as categoryGroupId or categoryGroupName (names match exactly first, then loosely). Set createGroupIfMissing to create the group when no group has that name; a hidden, internal or ambiguous match is reported instead. Refuses a name already used in that group, which guards against accidental repeats but not concurrent calls. A goalTarget gives the category a YNAB target (YNAB makes it a 'needed for spending' goal). To rename, move or re-note a category, use ynab_update_category. Categories can't be hidden or deleted through the API.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  name: z.string().describe("The new category's name"),
  categoryGroupId: z.string().optional().describe("The id of the group to create the category in (optional if categoryGroupName is provided; wins if both are given)"),
  categoryGroupName: z.string().optional().describe("The name of the group to create the category in, matched exactly first, then loosely. Optional if categoryGroupId is provided."),
  createGroupIfMissing: z.boolean().optional().describe("Create the group named by categoryGroupName when no group has that name (default false). Only exact names count when this is set, so a near match never stands in for the group you meant to create."),
  note: z.string().optional().describe("A note for the category (optional)"),
  goalTarget: z.number().optional().describe("Target amount in dollars, zero or more (optional)"),
  goalTargetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Target date in ISO format (e.g. 2027-03-01), optional"),
};

interface CreateCategoryInput {
  planId?: string;
  budgetId?: string;
  name: string;
  categoryGroupId?: string;
  categoryGroupName?: string;
  createGroupIfMissing?: boolean;
  note?: string;
  goalTarget?: number;
  goalTargetDate?: string;
}

export async function execute(input: CreateCategoryInput, api: ynab.API) {
  let createdGroup: { id: string; name: string } | undefined;
  try {
    const planId = resolvePlanId(input);
    const categoryName = input.name.trim();
    if (!exactKey(categoryName)) throw new Error("name must contain a letter or number");
    if (input.categoryGroupId === undefined && input.categoryGroupName === undefined) {
      throw new Error("Either categoryGroupId or categoryGroupName must be provided");
    }
    const groupName = input.categoryGroupName?.trim();
    if (input.categoryGroupId === undefined && groupName && groupName.length > MAX_GROUP_NAME_LENGTH) {
      throw new Error(`categoryGroupName must be at most ${MAX_GROUP_NAME_LENGTH} characters`);
    }
    validateGoal(input.goalTarget, input.goalTargetDate);

    const groups = await loadGroups(planId, api);
    const lookup = input.categoryGroupId !== undefined ? { id: input.categoryGroupId } : { name: groupName };
    const createIfMissing = input.createGroupIfMissing === true && input.categoryGroupId === undefined;
    const resolution = resolveGroup(groups, lookup, { fuzzy: !createIfMissing });

    let groupId: string;
    let resolvedGroupName: string;
    if (resolution.kind === "found") {
      const existing = resolution.item.categories.find((category) => exactKey(category.name) === exactKey(categoryName));
      if (existing) throw new Error(`The group "${resolution.item.name}" already has a category named "${existing.name}" (id ${existing.id})`);
      groupId = resolution.item.id;
      resolvedGroupName = resolution.item.name;
    } else if (resolution.kind === "none" && createIfMissing) {
      const response = await api.categories.createCategoryGroup(planId, { category_group: { name: groupName! } });
      createdGroup = { id: response.data.category_group.id, name: response.data.category_group.name };
      groupId = createdGroup.id;
      resolvedGroupName = createdGroup.name;
    } else {
      throw new Error(describeResolution(resolution, "category group", groupName ?? input.categoryGroupId!));
    }

    const category: ynab.NewCategory = { name: categoryName, category_group_id: groupId };
    if (input.note !== undefined) category.note = input.note;
    if (input.goalTarget !== undefined) category.goal_target = toMilliunits(input.goalTarget);
    if (input.goalTargetDate !== undefined) category.goal_target_date = input.goalTargetDate;

    const [response, decimalDigits] = await Promise.all([
      api.categories.createCategory(planId, { category }),
      getDecimalDigits(api, planId),
    ]);
    const created = response.data.category;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          category: {
            id: created.id,
            name: created.name,
            category_group_id: created.category_group_id,
            category_group_name: resolvedGroupName,
            note: created.note ?? null,
            goal_type: created.goal_type ?? null,
            goal_target: created.goal_target != null ? toDollars(created.goal_target, decimalDigits) : null,
            goal_target_date: created.goal_target_date ?? null,
          },
          createdGroup: createdGroup ?? null,
          message: `Created ${created.name} in ${resolvedGroupName}${createdGroup ? " (new group)" : ""}`,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error creating category:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
          // The group stays even though the category failed; report it so it can be reused or removed.
          ...(createdGroup ? { createdGroup } : {}),
        }, null, 2),
      }],
    };
  }
}
