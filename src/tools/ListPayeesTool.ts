import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_list_payees";
export const description = "Lists all payees in a plan. Useful for finding payee IDs when creating transactions.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
};

interface ListPayeesInput {
  planId?: string;
  budgetId?: string;
}


export async function execute(input: ListPayeesInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing payees for budget ${budgetId}`);
    const response = await api.payees.getPayees(budgetId);

    // Filter out deleted payees and format the response
    const payees = response.data.payees
      .filter((payee) => !payee.deleted)
      .map((payee) => ({
        id: payee.id,
        name: payee.name,
        transfer_account_id: payee.transfer_account_id,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          payees,
          payee_count: payees.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error listing payees:", error);
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
