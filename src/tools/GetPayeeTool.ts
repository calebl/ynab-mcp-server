import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_get_payee";
export const description = "Gets a single payee by ID.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  payeeId: z.string().describe("The ID of the payee to fetch (find it with ynab_list_payees)"),
};

interface GetPayeeInput {
  planId?: string;
  budgetId?: string;
  payeeId: string;
}

export async function execute(input: GetPayeeInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.payees.getPayeeById(planId, input.payeeId);
    const payee = response.data.payee;

    const result = {
      payee: {
        id: payee.id,
        name: payee.name,
        transfer_account_id: payee.transfer_account_id ?? null,
        deleted: payee.deleted,
      },
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    console.error("Error getting payee:", error);
    return toolError(getErrorMessage(error));
  }
}
