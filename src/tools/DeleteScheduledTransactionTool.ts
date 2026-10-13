import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_delete_scheduled_transaction";
export const description = "Deletes a scheduled transaction from the plan. This action cannot be undone.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  scheduledTransactionId: z.string().describe("The ID of the scheduled transaction to delete"),
};

interface DeleteScheduledTransactionInput {
  planId?: string;
  budgetId?: string;
  scheduledTransactionId: string;
}

export async function execute(input: DeleteScheduledTransactionInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);

    const response = await api.scheduledTransactions.deleteScheduledTransaction(
      planId,
      input.scheduledTransactionId
    );

    if (!response.data.scheduled_transaction) {
      throw new Error("Failed to delete scheduled transaction - no scheduled transaction data returned");
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          scheduledTransactionId: response.data.scheduled_transaction.id,
          message: "Scheduled transaction deleted successfully",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error deleting scheduled transaction:", error);
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
