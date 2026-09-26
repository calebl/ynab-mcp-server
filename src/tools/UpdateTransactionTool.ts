import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";
import {
  buildSubtransactions,
  mapSubtransactions,
  subtransactionsSchema,
  type SubtransactionData,
} from "./splits.js";

export const name = "ynab_update_transaction";
export const description = "Updates an existing transaction. All fields except transactionId are optional - only provide fields you want to change. Pass subtransactions to split an ordinary transaction across categories; YNAB cannot re-split a transaction that is already split.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  transactionId: z.string().describe("The ID of the transaction to update"),
  accountId: z.string().optional().describe("Move transaction to a different account"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("The date of the transaction in ISO format (e.g. 2024-03-24)"),
  amount: z.number().optional().describe("The amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  payeeId: z.string().optional().describe("The ID of the payee"),
  payeeName: z.string().optional().describe("The name of the payee (creates new payee if doesn't exist)"),
  categoryId: z.string().optional().describe("The category ID for the transaction"),
  memo: z.string().optional().describe("A memo/note for the transaction"),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional().describe("The cleared status"),
  approved: z.boolean().optional().describe("Whether the transaction is approved"),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple", ""]).optional().describe("The transaction flag color, or an empty string to clear the flag"),
  subtransactions: subtransactionsSchema.optional().describe("Splits an ordinary transaction across categories, in the same shape ynab_get_transactions returns. Needs at least two entries summing to amount (or the current amount if amount is omitted); omit categoryId. Not allowed on a transaction that is already split."),
};

interface UpdateTransactionInput {
  planId?: string;
  budgetId?: string;
  transactionId: string;
  accountId?: string;
  date?: string;
  amount?: number;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  cleared?: "cleared" | "uncleared" | "reconciled";
  approved?: boolean;
  flagColor?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "";
  subtransactions?: SubtransactionData[];
}


function mapClearedStatus(cleared: string): ynab.TransactionClearedStatus {
  switch (cleared) {
    case "cleared":
      return ynab.TransactionClearedStatus.Cleared;
    case "reconciled":
      return ynab.TransactionClearedStatus.Reconciled;
    default:
      return ynab.TransactionClearedStatus.Uncleared;
  }
}

export async function execute(input: UpdateTransactionInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    // Build the update object with only provided fields
    const transactionUpdate: ynab.ExistingTransaction = {};

    if (input.accountId !== undefined) {
      transactionUpdate.account_id = input.accountId;
    }
    if (input.date !== undefined) {
      transactionUpdate.date = input.date;
    }
    if (input.amount !== undefined) {
      transactionUpdate.amount = toMilliunits(input.amount);
    }
    if (input.payeeId !== undefined) {
      transactionUpdate.payee_id = input.payeeId;
    }
    if (input.payeeName !== undefined) {
      transactionUpdate.payee_name = input.payeeName;
    }
    if (input.categoryId !== undefined) {
      transactionUpdate.category_id = input.categoryId;
    }
    if (input.memo !== undefined) {
      transactionUpdate.memo = input.memo;
    }
    if (input.cleared !== undefined) {
      transactionUpdate.cleared = mapClearedStatus(input.cleared);
    }
    if (input.approved !== undefined) {
      transactionUpdate.approved = input.approved;
    }
    if (input.flagColor !== undefined) {
      transactionUpdate.flag_color = input.flagColor;
    }

    let matchedSplitCategories: (string | undefined)[] | undefined;
    if (input.subtransactions?.length) {
      if (input.categoryId !== undefined) {
        throw new Error("Give categories on the subtransactions, not on a split transaction itself");
      }

      // YNAB ignores subtransactions sent for an existing split, so refuse
      // rather than report a re-split that never happened.
      const existing = (await api.transactions.getTransactionById(budgetId, input.transactionId)).data.transaction;
      if (mapSubtransactions(existing.subtransactions)) {
        throw new Error(
          "This transaction is already split, and YNAB does not support changing an existing split. Delete and recreate it with the new splits instead."
        );
      }

      const split = await buildSubtransactions(
        input.subtransactions,
        transactionUpdate.amount ?? existing.amount,
        budgetId,
        api
      );
      // YNAB documents null here for a split; the SDK type omits null but passes it through.
      transactionUpdate.category_id = null as unknown as string;
      transactionUpdate.subtransactions = split.subtransactions;
      matchedSplitCategories = split.matchedCategories;
    }

    const response = await api.transactions.updateTransaction(
      budgetId,
      input.transactionId,
      { transaction: transactionUpdate }
    );

    if (!response.data.transaction) {
      throw new Error("Failed to update transaction - no transaction data returned");
    }

    const txn = response.data.transaction;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          transaction: {
            id: txn.id,
            date: txn.date,
            amount: toDollars(txn.amount),
            payee_name: txn.payee_name,
            category_name: txn.category_name,
            memo: txn.memo,
            cleared: txn.cleared,
            approved: txn.approved,
            account_name: txn.account_name,
            flag_color: txn.flag_color,
            subtransactions: mapSubtransactions(txn.subtransactions),
          },
          matchedSplitCategories,
          message: "Transaction updated successfully",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error updating transaction:", error);
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
