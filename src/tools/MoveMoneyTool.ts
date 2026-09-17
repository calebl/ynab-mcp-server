import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";

export const name = "ynab_move_money";
export const description = "Moves budgeted money from one category to another in a given month, typically to cover overspending. YNAB has no single move endpoint, so this reads both categories and rewrites their budgeted amounts; if the second write fails the response says exactly which half was applied.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).optional().describe("The budget month in ISO format (e.g. 2024-01-01, must be the first of the month), or 'current'. Defaults to 'current'."),
  fromCategoryId: z.string().describe("The ID of the category to take money from"),
  toCategoryId: z.string().describe("The ID of the category to give money to"),
  amount: z.number().positive().describe("The amount to move in dollars (e.g. 25.00). Must be positive."),
};

interface MoveMoneyInput {
  budgetId?: string;
  month?: string;
  fromCategoryId: string;
  toCategoryId: string;
  amount: number;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

export async function execute(input: MoveMoneyInput, api: ynab.API) {
  const month = input.month || "current";
  const amountMilliunits = toMilliunits(input.amount);

  let budgetId: string;
  let source: ynab.Category;
  let destination: ynab.Category;

  // Phase 1: everything that can fail without changing the budget.
  try {
    budgetId = getBudgetId(input.budgetId);

    if (input.fromCategoryId === input.toCategoryId) {
      throw new Error("fromCategoryId and toCategoryId must be different categories");
    }

    const [sourceResponse, destinationResponse] = await Promise.all([
      api.categories.getMonthCategoryById(budgetId, month, input.fromCategoryId),
      api.categories.getMonthCategoryById(budgetId, month, input.toCategoryId),
    ]);

    source = sourceResponse.data.category;
    destination = destinationResponse.data.category;
  } catch (error) {
    console.error("Error preparing money move:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          moved: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }

  // Phase 2: the two writes. Take from the source first - if the second write
  // then fails, the money is sitting in Ready to Assign rather than having been
  // double-counted in the destination.
  try {
    await api.categories.updateMonthCategory(budgetId, month, source.id, {
      category: { budgeted: source.budgeted - amountMilliunits },
    });
  } catch (error) {
    console.error("Error taking money from source category:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          moved: false,
          error: `Could not take $${input.amount.toFixed(2)} from ${source.name}: ${getErrorMessage(error)}`,
          note: "Nothing was changed.",
        }, null, 2),
      }],
    };
  }

  try {
    const updated = await api.categories.updateMonthCategory(budgetId, month, destination.id, {
      category: { budgeted: destination.budgeted + amountMilliunits },
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          moved: true,
          month,
          amount: input.amount,
          from: {
            id: source.id,
            name: source.name,
            budgeted: toDollars(source.budgeted - amountMilliunits),
          },
          to: {
            id: destination.id,
            name: destination.name,
            budgeted: toDollars(updated.data.category.budgeted),
            balance: toDollars(updated.data.category.balance),
          },
          message: `Moved $${input.amount.toFixed(2)} from ${source.name} to ${destination.name}`,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error giving money to destination category:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          moved: false,
          partial: true,
          error: getErrorMessage(error),
          message: `$${input.amount.toFixed(2)} was removed from ${source.name} but could not be added to ${destination.name}. The money is now in Ready to Assign.`,
          recovery: `To undo, set ${source.name} (${source.id}) back to a budgeted amount of $${toDollars(source.budgeted).toFixed(2)} for ${month}.`,
        }, null, 2),
      }],
    };
  }
}
