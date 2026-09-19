import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_approve_transaction";
export const description = "Approves an existing transaction in your YNAB plan.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  transactionId: z.string().describe("The id of the transaction to approve"),
  approved: z.boolean().optional().default(true).describe("Whether the transaction should be marked as approved"),
};

interface ApproveTransactionInput {
  planId?: string;
  budgetId?: string;
  transactionId: string;
  approved?: boolean;
}


export async function execute(input: ApproveTransactionInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    // First, get the existing transaction to ensure we don't lose any data
    const existingTransaction = await api.transactions.getTransactionById(budgetId, input.transactionId);

    if (!existingTransaction.data.transaction) {
      throw new Error("Transaction not found");
    }

    const existingTransactionData = existingTransaction.data.transaction;

    const transaction: ynab.PutTransactionWrapper = {
      transaction: {
        approved: input.approved ?? true,
      }
    };

    const response = await api.transactions.updateTransaction(
      budgetId,
      existingTransactionData.id,
      transaction
    );

    if (!response.data.transaction) {
      throw new Error("Failed to update transaction - no transaction data returned");
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: true,
        transactionId: response.data.transaction.id,
        message: "Transaction updated successfully",
      }, null, 2) }]
    };
  } catch (error) {
    console.error("Error approving transaction:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }]
    };
  }
}