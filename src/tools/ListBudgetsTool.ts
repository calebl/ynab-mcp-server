import { z } from "zod";
import * as ynab from "ynab";

export const name = "list_budgets";
export const description = "Lists all available budgets from YNAB API";
export const inputSchema = {};

export async function execute(_input: Record<string, unknown>, api: ynab.API) {
  try {
    if (!process.env.YNAB_API_TOKEN) {
      return {
        content: [{ type: "text" as const, text: "YNAB API Token is not set" }]
      };
    }

    console.log("Listing budgets");
    const budgetsResponse = await api.budgets.getBudgets();
    console.log(`Found ${budgetsResponse.data.budgets.length} budgets`);

    const budgets = budgetsResponse.data.budgets.map((budget) => ({
      id: budget.id,
      name: budget.name,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(budgets, null, 2) }]
    };
  } catch (error: unknown) {
    console.error(`Error listing budgets: ${JSON.stringify(error)}`);
    return {
      content: [{ type: "text" as const, text: `Error listing budgets: ${JSON.stringify(error)}` }]
    };
  }
}