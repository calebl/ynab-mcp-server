import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_list_budgets";
export const description = "Lists all available budgets from YNAB API";
export const inputSchema = {};

export async function execute(_input: Record<string, unknown>, api: ynab.API) {
  try {
    if (!process.env.YNAB_API_TOKEN) {
      return {
        content: [{ type: "text" as const, text: "YNAB API Token is not set" }]
      };
    }

    console.error("Listing budgets");
    const budgetsResponse = await api.budgets.getBudgets();
    console.error(`Found ${budgetsResponse.data.budgets.length} budgets`);

    const budgets = budgetsResponse.data.budgets.map((budget) => ({
      id: budget.id,
      name: budget.name,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(budgets, null, 2) }]
    };
  } catch (error: unknown) {
    console.error("Error listing budgets:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }]
    };
  }
}