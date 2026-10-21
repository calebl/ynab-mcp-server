import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, roundAmount, toDollars } from "./money.js";

export const name = "ynab_plan_summary";
export const description = "Get a summary of the plan for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well. Set budgetVsActuals to also compare assigned with actual spending that month: budgeted, activity, balance, variance (budgeted plus activity; below zero means more was spent than assigned) and percent used for every visible category, with subtotals per category group and overall totals. The totals add up every listed category, Credit Card Payments included, whose activity offsets purchases made on the card. YNAB's internal categories (group Internal Master Category) are left out: one of them, Inflow: Ready to Assign, has the month's income as its activity.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The plan month in ISO format (e.g. 2016-12-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
  budgetVsActuals: z.boolean().optional().describe("Add a budget_vs_actuals block comparing assigned with actual spending per category for the month, with group subtotals (default: false)"),
};

interface BudgetSummaryInput {
  planId?: string;
  budgetId?: string;
  month?: string;
  budgetVsActuals?: boolean;
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

interface Amounts {
  budgeted: number;
  activity: number;
  balance: number;
}

/** Spent as a percentage of budgeted, or null when nothing (or less than nothing) was assigned. */
function percentUsed({ budgeted, activity }: Amounts): number | null {
  return budgeted > 0 ? roundAmount((-activity / budgeted) * 100, 1) : null;
}

function compareAmounts(amounts: Amounts, decimalDigits: number) {
  return {
    budgeted: toDollars(amounts.budgeted, decimalDigits),
    activity: toDollars(amounts.activity, decimalDigits),
    balance: toDollars(amounts.balance, decimalDigits),
    variance: toDollars(amounts.budgeted + amounts.activity, decimalDigits),
    percent_used: percentUsed(amounts),
  };
}

function sumAmounts(categories: Amounts[]): Amounts {
  return categories.reduce(
    (sum, category) => ({
      budgeted: sum.budgeted + category.budgeted,
      activity: sum.activity + category.activity,
      balance: sum.balance + category.balance,
    }),
    { budgeted: 0, activity: 0, balance: 0 },
  );
}

/**
 * The month's categories include YNAB's internal ones. "Inflow: Ready to Assign"
 * (group "Internal Master Category") has the month's income as its activity and
 * a balance that accumulates across months, so it would swamp the totals.
 */
function isInternal(category: ynab.Category): boolean {
  return category.internal === true || category.category_group_name === "Internal Master Category";
}

/** Budgeted against actual per category, grouped in the order YNAB lists them. */
function budgetVsActuals(categories: ynab.Category[], decimalDigits: number) {
  const groups = new Map<string, ynab.Category[]>();
  for (const category of categories.filter((category) => !isInternal(category))) {
    const group = groups.get(category.category_group_id);
    if (group) group.push(category);
    else groups.set(category.category_group_id, [category]);
  }
  const listed = [...groups.values()];
  return {
    totals: compareAmounts(sumAmounts(listed.flat()), decimalDigits),
    groups: listed.map((group) => ({
      category_group_id: group[0].category_group_id,
      category_group_name: group[0].category_group_name ?? null,
      ...compareAmounts(sumAmounts(group), decimalDigits),
      categories: group.map((category) => ({
        id: category.id,
        name: category.name,
        ...compareAmounts(category, decimalDigits),
      })),
    })),
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
        ...(input.budgetVsActuals === true && { budget_vs_actuals: budgetVsActuals(categories, decimalDigits) }),
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
