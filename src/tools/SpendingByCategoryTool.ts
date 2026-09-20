import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { collectSpending, daysAgo, groupSpending, round2 } from "./spending.js";

export const name = "ynab_spending_by_category";
export const description = "Totals spending per category over a date range, biggest spend first. Splits are counted through their subtransactions, and transfers between your own accounts are excluded.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start of the range, inclusive (ISO format: 2024-01-01). Defaults to 30 days ago."),
  untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End of the range, inclusive (ISO format: 2024-01-31). Defaults to no end date."),
  limit: z.number().int().positive().optional().describe("Only return the top N categories by spend"),
};

interface SpendingByCategoryInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  untilDate?: string;
  limit?: number;
}


export async function execute(input: SpendingByCategoryInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const sinceDate = input.sinceDate || daysAgo(30);

    const response = await api.transactions.getTransactions(budgetId, sinceDate);
    const entries = collectSpending(response.data.transactions, input.untilDate);
    const grouped = groupSpending(entries, (entry) => entry.categoryName);
    const categories = input.limit ? grouped.slice(0, input.limit) : grouped;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          since_date: sinceDate,
          until_date: input.untilDate ?? null,
          total_spent: round2(entries.reduce((sum, entry) => sum + entry.amount, 0)),
          transaction_count: entries.length,
          category_count: grouped.length,
          categories,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting spending by category:", error);
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
