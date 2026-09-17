import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_budget_summary";
export const description = "Get a summary of the budget for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget to get a summary for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The budget month in ISO format (e.g. 2016-12-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
};

interface BudgetSummaryInput {
  budgetId?: string;
  month?: string;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

function summarizeCategory(category: ynab.Category) {
  return {
    id: category.id,
    name: category.name,
    category_group_name: category.category_group_name,
    budgeted: toDollars(category.budgeted),
    activity: toDollars(category.activity),
    balance: toDollars(category.balance),
  };
}

export async function execute(input: BudgetSummaryInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);
    const month = input.month || "current";

    console.error(`Getting accounts and categories for budget ${budgetId} and month ${month}`);
    const accountsResponse = await api.accounts.getAccounts(budgetId);
    const accounts = accountsResponse.data.accounts
      .filter((account) => account.deleted === false && account.closed === false)
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        on_budget: account.on_budget,
        balance: toDollars(account.balance),
      }));

    const monthResponse = await api.months.getBudgetMonth(budgetId, month);
    const monthBudget = monthResponse.data.month;

    const categories = monthBudget.categories.filter(
      (category) => category.deleted === false && category.hidden === false
    );

    // Overspent categories are the ones needing attention, worst first.
    const overspent = categories
      .filter((category) => category.balance < 0)
      .sort((a, b) => a.balance - b.balance)
      .map(summarizeCategory);

    // Categories with a funding goal that hasn't been met this month.
    const underfunded = categories
      .filter((category) => (category.goal_under_funded ?? 0) > 0)
      .sort((a, b) => (b.goal_under_funded ?? 0) - (a.goal_under_funded ?? 0))
      .map((category) => ({
        ...summarizeCategory(category),
        goal_target: category.goal_target ? toDollars(category.goal_target) : null,
        goal_under_funded: toDollars(category.goal_under_funded ?? 0),
      }));

    const positiveBalance = categories
      .filter((category) => category.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .map(summarizeCategory);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        month: monthBudget.month,
        currency: "All amounts are in the budget's currency, not milliunits.",
        income: toDollars(monthBudget.income),
        budgeted: toDollars(monthBudget.budgeted),
        activity: toDollars(monthBudget.activity),
        ready_to_assign: toDollars(monthBudget.to_be_budgeted),
        age_of_money: monthBudget.age_of_money,
        overspent,
        underfunded,
        positive_balance: positiveBalance,
        accounts,
      }, null, 2) }]
    };
  } catch (error: unknown) {
    console.error("Error getting budget summary:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }]
    };
  }
}
