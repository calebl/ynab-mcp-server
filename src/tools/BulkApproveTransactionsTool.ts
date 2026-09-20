import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_bulk_approve_transactions";
export const description = "Approves multiple transactions at once. Provide an array of transaction IDs to approve them all in a single API call.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  transactionIds: z.array(z.string()).min(1).max(500).describe("Array of transaction IDs to approve"),
};

interface BulkApproveTransactionsInput {
  planId?: string;
  budgetId?: string;
  transactionIds: string[];
}


export async function execute(input: BulkApproveTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    if (!input.transactionIds || input.transactionIds.length === 0) {
      throw new Error("No transaction IDs provided");
    }

    // Build the update transactions array
    const transactions: ynab.SaveTransactionWithIdOrImportId[] = input.transactionIds.map((id) => ({
      id,
      approved: true,
    }));

    const response = await api.transactions.updateTransactions(budgetId, {
      transactions,
    });

    if (!response.data.transactions) {
      throw new Error("Failed to update transactions - no transaction data returned");
    }

    const updatedTransactions = response.data.transactions.map((txn) => ({
      id: txn.id,
      date: txn.date,
      amount: toDollars(txn.amount),
      payee_name: txn.payee_name,
      approved: txn.approved,
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          approved_count: updatedTransactions.length,
          transactions: updatedTransactions,
          message: `Successfully approved ${updatedTransactions.length} transaction(s)`,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error bulk approving transactions:", error);
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
