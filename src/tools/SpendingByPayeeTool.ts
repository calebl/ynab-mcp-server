import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { collectSpending, daysAgo, describeWindow, groupSpending, MAX_MONTHS, monthlyWindow } from "./spending.js";

export const name = "ynab_spending_by_payee";
export const description = "Totals spending per payee over a date range, biggest spend first - where the money actually goes by merchant. Splits are counted through their subtransactions, and transfers between your own accounts are excluded. Totals are gross outflows: refunds and other inflows aren't netted, so they can differ from a category's activity in YNAB. With monthly: true, each payee also gets a month-by-month series, its mean over full months, and how its last full month compares with the earlier ones.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start of the range, inclusive (ISO format: 2024-01-01). Defaults to 30 days ago."),
  untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End of the range, inclusive (ISO format: 2024-01-31). Defaults to no end date, or to today with monthly: true."),
  limit: z.number().int().positive().optional().describe("Only return the top N payees by spend"),
  monthly: z.boolean().optional().describe(`true adds the top-level months list and, on each payee, monthly_totals (spend per month, aligned with months), average_monthly (mean over the full months) and change_pct (the last full month against the mean of the earlier full months). Months only partly in the range, or not over yet, are listed but left out of both figures. The range starts at sinceDate when given; otherwise it covers the number of calendar months set by months (default 6, at most ${MAX_MONTHS}), ending with untilDate or today. With many payees, pair it with limit.`),
  months: z.number().int().min(1).max(MAX_MONTHS).optional().describe("With monthly: true, how many calendar months to cover, ending with the month of untilDate or the current month (default 6). sinceDate overrides it. Ignored without monthly."),
};

interface SpendingByPayeeInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  untilDate?: string;
  limit?: number;
  monthly?: boolean;
  months?: number;
}


export async function execute(input: SpendingByPayeeInput, api: ynab.API) {
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
    const grouped = groupSpending(entries, (entry) => entry.payeeName, decimalDigits, window);
    const payees = input.limit ? grouped.slice(0, input.limit) : grouped;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          since_date: sinceDate,
          until_date: untilDate ?? null,
          total_spent: toDollars(entries.reduce((sum, entry) => sum + entry.amountMilliunits, 0), decimalDigits),
          transaction_count: entries.length,
          ...(window ? describeWindow(window) : {}),
          payee_count: grouped.length,
          payees,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting spending by payee:", error);
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
