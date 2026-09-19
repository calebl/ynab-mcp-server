import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";
import { mapSubtransactions } from "./splits.js";

export const name = "ynab_get_unapproved_transactions";
export const description = "Gets every unapproved transaction in a budget, optionally limited to those on or after a given date.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only return transactions on or after this date (ISO format: 2024-01-01). Omit to return all unapproved transactions."),
};

interface GetUnapprovedTransactionsInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
}


export async function execute(input: GetUnapprovedTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Getting unapproved transactions for budget ${budgetId}`);

    const response = await api.transactions.getTransactions(
      budgetId,
      input.sinceDate,
      undefined,
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