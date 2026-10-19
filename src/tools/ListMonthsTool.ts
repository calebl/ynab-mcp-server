import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_list_months";
export const description = "Lists every plan month since the plan began, with raw summary fields: income, budgeted, activity, Ready to Assign, age of money and the month note. For income-versus-spending questions over recent months, use ynab_cash_flow instead.";
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
    const [response, decimalDigits] = await Promise.all([
      api.months.getPlanMonths(budgetId),
      getDecimalDigits(api, budgetId),
    ]);

    // Format the months
    const months = response.data.months.map((month: ynab.MonthSummary) => ({
      month: month.month,
      note: month.note,
      income: toDollars(month.income, decimalDigits),
      budgeted: toDollars(month.budgeted, decimalDigits),
      activity: toDollars(month.activity, decimalDigits),
      to_be_budgeted: toDollars(month.to_be_budgeted, decimalDigits),
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
