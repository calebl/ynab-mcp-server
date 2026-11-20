import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { formatCategory } from "./categoryFormat.js";

export const name = "ynab_goal_summary";
export const description = "Summarizes the goals of one plan month: number of categories with a goal, total target, total under-funded, average percentage complete, a per-goal-type breakdown, and every under-funded category (largest shortfall first). Deleted, hidden (unless includeHidden) and goal-less categories are skipped and counted.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The plan month in ISO format (e.g. 2024-01-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
  includeHidden: z.boolean().default(false).describe("Include hidden categories in the summary (default false)"),
};

interface GoalSummaryInput {
  planId?: string;
  budgetId?: string;
  month?: string;
  includeHidden?: boolean;
}

export async function execute(input: GoalSummaryInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const [response, decimalDigits] = await Promise.all([
      api.months.getPlanMonth(planId, input.month ?? "current"),
      getDecimalDigits(api, planId),
    ]);
    const m = response.data.month;
    const included = m.categories.filter(
      (c) => !c.deleted && (input.includeHidden || !c.hidden) && c.goal_type != null,
    );
    const shortfall = (c: ynab.Category) => Math.max(c.goal_under_funded ?? 0, 0);

    let totalTarget = 0;
    let totalUnderFunded = 0;
    const byType: Record<string, { count: number; underFunded: number }> = {};
    for (const c of included) {
      totalTarget += c.goal_target ?? 0;
      totalUnderFunded += shortfall(c);
      const t = (byType[c.goal_type as string] ??= { count: 0, underFunded: 0 });
      t.count += 1;
      t.underFunded += shortfall(c);
    }

    const percentages = included.map((c) => c.goal_percentage_complete).filter((p): p is number => p != null);
    const average = percentages.length
      ? Math.round((percentages.reduce((a, b) => a + b, 0) / percentages.length) * 10) / 10
      : null;

    const by_goal_type = Object.fromEntries(
      Object.entries(byType).map(([type, t]) => [type, { count: t.count, under_funded: toDollars(t.underFunded, decimalDigits) }]),
    );
    const underfunded = included
      .filter((c) => shortfall(c) > 0)
      .sort((a, b) => shortfall(b) - shortfall(a) || a.name.localeCompare(b.name))
      .map((c) => {
        const f = formatCategory(c, decimalDigits);
        return {
          id: f.id,
          name: f.name,
          category_group_name: f.category_group_name,
          goal_type: f.goal_type,
          goal_target: f.goal_target,
          goal_target_date: f.goal_target_date,
          goal_percentage_complete: f.goal_percentage_complete,
          goal_under_funded: f.goal_under_funded,
        };
      });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          month: m.month,
          goal_count: included.length,
          total_target: toDollars(totalTarget, decimalDigits),
          total_under_funded: toDollars(totalUnderFunded, decimalDigits),
          average_percentage_complete: average,
          by_goal_type,
          underfunded,
          skipped_count: m.categories.length - included.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting goal summary:", error);
    return toolError(getErrorMessage(error));
  }
}
