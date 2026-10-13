import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_update_payee";
export const description = "Renames a payee. Transfer payees cannot be renamed; YNAB rejects that and the error is returned.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  payeeId: z.string().describe("The ID of the payee to rename"),
  // 500 = SavePayee.name.maxLength in the YNAB OpenAPI spec.
  name: z.string().min(1).max(500).describe("The new payee name (1-500 characters)"),
};

interface UpdatePayeeInput {
  planId?: string;
  budgetId?: string;
  payeeId: string;
  name: string;
}

export async function execute(input: UpdatePayeeInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.payees.updatePayee(planId, input.payeeId, { payee: { name: input.name } });
    const payee = response.data.payee;

    const result = {
      success: true,
      payee: {
        id: payee.id,
        name: payee.name,
        transfer_account_id: payee.transfer_account_id ?? null,
      },
      message: `Payee renamed to "${payee.name}"`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    console.error("Error updating payee:", error);
    return toolError(getErrorMessage(error));
  }
}
