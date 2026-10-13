import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { formatCategory } from "./categoryFormat.js";

export const name = "ynab_list_categories";
export const description = "Lists categories grouped by category group, with goal info. Pass month for that month's budgeted/activity/balance, includeHidden for hidden groups and categories, or lastKnowledgeOfServer for only changes since an earlier server_knowledge (deleted and hidden rows included).";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).optional().describe("Return each category's budgeted, activity, balance and goal values for this plan month: ISO first-of-month date (e.g. 2024-01-01) or 'current'. Cannot be combined with lastKnowledgeOfServer."),
  includeHidden: z.boolean().optional().describe("Include hidden category groups and hidden categories (default false)"),
  lastKnowledgeOfServer: z.number().int().nonnegative().optional().describe("Delta sync: the server_knowledge value from an earlier response of this tool. Only rows changed since then are returned, deleted rows included with deleted: true."),
};

interface ListCategoriesInput {
  planId?: string;
  budgetId?: string;
  month?: string;
  includeHidden?: boolean;
  lastKnowledgeOfServer?: number;
}


export async function execute(input: ListCategoriesInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing categories for budget ${budgetId}`);
    const delta = input.lastKnowledgeOfServer !== undefined;
    if (input.month !== undefined && delta) {
      throw new Error("month cannot be combined with lastKnowledgeOfServer: YNAB has no delta request for a single month");
    }

    const [response, monthResponse] = await Promise.all([
      api.categories.getCategories(budgetId, input.lastKnowledgeOfServer),
      input.month !== undefined ? api.months.getPlanMonth(budgetId, input.month) : Promise.resolve(undefined),
    ]);

    const monthCategories = monthResponse
      ? new Map(monthResponse.data.month.categories.map((c) => [c.id, c]))
      : undefined;
    // Delta responses are a change set: removals and hide/unhide are changes, so nothing is filtered.
    const keep = (row: { deleted: boolean; hidden: boolean }) =>
      delta || (!row.deleted && (input.includeHidden === true || !row.hidden));

    // Format the response with category groups and their categories
    const categoryGroups = response.data.category_groups
      .filter(keep)
      .map((group) => ({
        id: group.id,
        name: group.name,
        hidden: group.hidden,
        deleted: group.deleted,
        categories: group.categories
          .map((cat) => (monthCategories ? monthCategories.get(cat.id) : cat))
          .filter((cat): cat is ynab.Category => cat !== undefined)
          .filter(keep)
          .map(formatCategory),
      }));

    const totalCategories = categoryGroups.reduce(
      (sum, group) => sum + group.categories.length,
      0
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          month: monthResponse?.data.month.month,
          category_groups: categoryGroups,
          group_count: categoryGroups.length,
          category_count: totalCategories,
          server_knowledge: monthResponse ? undefined : response.data.server_knowledge,
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
