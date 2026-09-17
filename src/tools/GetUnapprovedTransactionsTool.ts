import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";
import { mapSubtransactions } from "./splits.js";

export const name = "ynab_get_unapproved_transactions";
export const description = "Gets every unapproved transaction in a budget, optionally limited to those on or after a given date.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget to fetch transactions for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
  sinceDate: z.string().optional().describe("Only return transactions on or after this date (ISO format: 2024-01-01). Omit to return all unapproved transactions."),
};

interface GetUnapprovedTransactionsInput {
  budgetId?: string;
  sinceDate?: string;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

export async function execute(input: GetUnapprovedTransactionsInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);

    console.error(`Getting unapproved transactions for budget ${budgetId}`);

    const response = await api.transactions.getTransactions(
      budgetId,
      input.sinceDate,
      ynab.GetTransactionsTypeEnum.Unapproved
    );

    // Transform the transactions to a more readable format
    const transactions = response.data.transactions
      .filter((transaction) => !transaction.deleted)
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        amount: toDollars(transaction.amount),
        memo: transaction.memo,
        approved: transaction.approved,
        account_name: transaction.account_name,
        payee_name: transaction.payee_name,
        category_name: transaction.category_name,
        // Present only on splits, whose parent row is categorised "Split".
        subtransactions: mapSubtransactions(transaction.subtransactions),
        transfer_account_id: transaction.transfer_account_id,
        transfer_transaction_id: transaction.transfer_transaction_id,
        matched_transaction_id: transaction.matched_transaction_id,
        import_id: transaction.import_id,
      }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        transactions,
        transaction_count: transactions.length,
      }, null, 2) }]
    };
  } catch (error) {
    console.error("Error getting unapproved transactions:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }]
    };
  }
}