import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_update_transaction";
export const description = "Updates an existing transaction. All fields except transactionId are optional - only provide fields you want to change.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  transactionId: z.string().describe("The ID of the transaction to update"),
  accountId: z.string().optional().describe("Move transaction to a different account"),
  date: z.string().optional().describe("The date of the transaction in ISO format (e.g. 2024-03-24)"),
  amount: z.number().optional().describe("The amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  payeeId: z.string().optional().describe("The ID of the payee"),
  payeeName: z.string().optional().describe("The name of the payee (creates new payee if doesn't exist)"),
  categoryId: z.string().optional().describe("The category ID for the transaction"),
  memo: z.string().optional().describe("A memo/note for the transaction"),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional().describe("The cleared status"),
  approved: z.boolean().optional().describe("Whether the transaction is approved"),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).optional().describe("The transaction flag color"),
};

interface UpdateTransactionInput {
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
  flagColor?: "red" | "orange" | "yellow" | "green" | "blue" | "purple";
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
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
    const budgetId = getBudgetId(input.budgetId);

    // Build the update object with only provided fields
    const transactionUpdate: ynab.SaveTransactionWithOptionalFields = {};

    if (input.accountId !== undefined) {
      transactionUpdate.account_id = input.accountId;
    }
    if (input.date !== undefined) {
      transactionUpdate.date = input.date;
    }
    if (input.amount !== undefined) {
      transactionUpdate.amount = Math.round(input.amount * 1000);
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
      transactionUpdate.flag_color = input.flagColor as ynab.TransactionFlagColor;
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
            amount: (txn.amount / 1000).toFixed(2),
            payee_name: txn.payee_name,
            category_name: txn.category_name,
            memo: txn.memo,
            cleared: txn.cleared,
            approved: txn.approved,
            account_name: txn.account_name,
            flag_color: txn.flag_color,
          },
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
