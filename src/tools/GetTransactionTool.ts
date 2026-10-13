import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { mapTransaction } from "./GetTransactionsTool.js";

export const name = "ynab_get_transaction";
export const description = "Gets a single transaction by ID, including account, payee and category IDs and the legs of a split.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  transactionId: z.string().describe("The ID of the transaction to get"),
};

interface GetTransactionInput {
  planId?: string;
  budgetId?: string;
  transactionId: string;
}

export async function execute(input: GetTransactionInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);

    const response = await api.transactions.getTransactionById(planId, input.transactionId);
    const txn = response.data.transaction;
    if (!txn) {
      throw new Error(`Transaction not found: ${input.transactionId}`);
    }

    // A deleted transaction is returned rather than filtered: the caller asked for this ID.
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          transaction: { ...mapTransaction(txn), deleted: txn.deleted },
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting transaction:", error);
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
