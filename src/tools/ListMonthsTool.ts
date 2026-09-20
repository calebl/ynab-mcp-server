import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_list_months";
export const description = "Lists all plan months. Each month contains summary information about budgeting status.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
};

interface ListMonthsInput {
  planId?: string;
  budgetId?: string;
}


export async function execute(input: ListMonthsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing months for budget ${budgetId}`);
    const response = await api.months.getPlanMonths(budgetId);

    // Format the months
    const months = response.data.months.map((month: ynab.MonthSummary) => ({
      month: month.month,
      note: month.note,
      income: toDollars(month.income),
      budgeted: toDollars(month.budgeted),
      activity: toDollars(month.activity),
      to_be_budgeted: toDollars(month.to_be_budgeted),
      age_of_money: month.age_of_money,
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          months,
          month_count: months.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error listing months:", error);
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
