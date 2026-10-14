import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_plan_summary";
export const description = "Get a summary of the plan for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The plan month in ISO format (e.g. 2016-12-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
};

interface BudgetSummaryInput {
  planId?: string;
  budgetId?: string;
  month?: string;
}


function summarizeCategory(category: ynab.Category, decimalDigits: number) {
  return {
    id: category.id,
    name: category.name,
    category_group_name: category.category_group_name,
    budgeted: toDollars(category.budgeted, decimalDigits),
    activity: toDollars(category.activity, decimalDigits),
    balance: toDollars(category.balance, decimalDigits),
  };
}

export async function execute(input: BudgetSummaryInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const month = input.month || "current";

    console.error(`Getting accounts and categories for plan ${budgetId} and month ${month}`);
    const [accountsResponse, decimalDigits] = await Promise.all([
      api.accounts.getAccounts(budgetId),
      getDecimalDigits(api, budgetId),
    ]);
    const accounts = accountsResponse.data.accounts
      .filter((account) => account.deleted === false && account.closed === false)
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        on_budget: account.on_budget,
        balance: toDollars(account.balance, decimalDigits),
      }));

    const monthResponse = await api.months.getPlanMonth(budgetId, month);
    const monthBudget = monthResponse.data.month;

    const categories: ynab.Category[] = monthBudget.categories.filter(
      (category) => category.deleted === false && category.hidden === false
    );

    // Overspent categories are the ones needing attention, worst first.
    const overspent = categories
      .filter((category) => category.balance < 0)
      .sort((a, b) => a.balance - b.balance)
      .map((category) => summarizeCategory(category, decimalDigits));

    // Categories with a funding goal that hasn't been met this month.
    const underfunded = categories
      .filter((category) => (category.goal_under_funded ?? 0) > 0)
      .sort((a, b) => (b.goal_under_funded ?? 0) - (a.goal_under_funded ?? 0))
      .map((category) => ({
        ...summarizeCategory(category, decimalDigits),
        goal_target: category.goal_target ? toDollars(category.goal_target, decimalDigits) : null,
        goal_under_funded: toDollars(category.goal_under_funded ?? 0, decimalDigits),
      }));

    const positiveBalance = categories
      .filter((category) => category.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .map((category) => summarizeCategory(category, decimalDigits));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        month: monthBudget.month,
        currency: "All amounts are in the plan's currency, not milliunits.",
        income: toDollars(monthBudget.income, decimalDigits),
        budgeted: toDollars(monthBudget.budgeted, decimalDigits),
        activity: toDollars(monthBudget.activity, decimalDigits),
        ready_to_assign: toDollars(monthBudget.to_be_budgeted, decimalDigits),
        age_of_money: monthBudget.age_of_money,
        overspent,
        underfunded,
        positive_balance: positiveBalance,
        accounts,
      }, null, 2) }]
    };
  } catch (error: unknown) {
    console.error("Error getting plan summary:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }]
    };
  }
}
