import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { collectSpending, daysAgo, describeWindow, groupSpending, MAX_MONTHS, monthlyWindow } from "./spending.js";

export const name = "ynab_spending_by_category";
export const description = "Totals spending per category over a date range, biggest spend first. Splits are counted through their subtransactions, and transfers between your own accounts are excluded. With monthly: true, each category also gets a month-by-month series, its mean over full months, and how its last full month compares with the earlier ones.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start of the range, inclusive (ISO format: 2024-01-01). Defaults to 30 days ago."),
  untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End of the range, inclusive (ISO format: 2024-01-31). Defaults to no end date, or to today with monthly: true."),
  limit: z.number().int().positive().optional().describe("Only return the top N categories by spend"),
  monthly: z.boolean().optional().describe(`true adds monthly (spend per calendar month), average_monthly (mean over the full months) and change_pct (the last full month against the mean of the earlier full months) to each category. A partial first or last month is listed but left out of both figures. The range then defaults to the last months (default 6) calendar months through today, at most ${MAX_MONTHS}.`),
  months: z.number().int().min(1).max(MAX_MONTHS).optional().describe("With monthly: true, how many calendar months to cover, ending with the month of untilDate or the current month (default 6). sinceDate overrides it. Ignored without monthly."),
};

interface SpendingByCategoryInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  untilDate?: string;
  limit?: number;
  monthly?: boolean;
  months?: number;
}


export async function execute(input: SpendingByCategoryInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const window = input.monthly === true ? monthlyWindow(input) : undefined;
    const sinceDate = window?.sinceDate ?? (input.sinceDate || daysAgo(30));
    const untilDate = window?.untilDate ?? input.untilDate;

    const [response, decimalDigits] = await Promise.all([
      api.transactions.getTransactions(budgetId, sinceDate),
      getDecimalDigits(api, budgetId),
    ]);
    const entries = collectSpending(response.data.transactions, untilDate, decimalDigits);
    const grouped = groupSpending(entries, (entry) => entry.categoryName, decimalDigits, window);
    const categories = input.limit ? grouped.slice(0, input.limit) : grouped;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          since_date: sinceDate,
          until_date: untilDate ?? null,
          total_spent: toDollars(entries.reduce((sum, entry) => sum + entry.amountMilliunits, 0), decimalDigits),
          transaction_count: entries.length,
          ...(window ? describeWindow(window) : {}),
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
