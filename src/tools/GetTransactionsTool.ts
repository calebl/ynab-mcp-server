import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { mapSubtransactions } from "./splits.js";

export const name = "ynab_get_transactions";
export const description = "Gets transactions from a plan, optionally on or after a start date (there is no end-date filter) and by type (all, uncategorized or unapproved). Filter by at most one of account, category or payee: they cannot be combined, and if several are given only the first in that order is applied.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only return transactions on or after this date (ISO format: 2024-01-01)"),
  type: z.enum(["all", "uncategorized", "unapproved"]).optional().describe("Filter by transaction type. Defaults to 'all'."),
  accountId: z.string().optional().describe("Filter to only transactions in this account"),
  categoryId: z.string().optional().describe("Filter to only transactions in this category"),
  payeeId: z.string().optional().describe("Filter to only transactions with this payee"),
  limit: z.number().int().positive().max(1000).optional().describe("Maximum number of transactions to return (default: 100)"),
};

interface GetTransactionsInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  type?: "all" | "uncategorized" | "unapproved";
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  limit?: number;
}


function mapTransactionType(type?: string): ynab.GetTransactionsTypeEnum | undefined {
  switch (type) {
    case "uncategorized":
      return ynab.GetTransactionsTypeEnum.Uncategorized;
    case "unapproved":
      return ynab.GetTransactionsTypeEnum.Unapproved;
    default:
      return undefined;
  }
}

interface TransactionData {
  id: string;
  date: string;
  amount: number;
  memo?: string | null;
  approved: boolean;
  cleared: string;
  account_name?: string | null;
  payee_name?: string | null;
  category_name?: string | null;
  flag_color?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  matched_transaction_id?: string | null;
  import_id?: string | null;
  subtransactions?: ynab.SubTransaction[];
  deleted: boolean;
}

export async function execute(input: GetTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const limit = input.limit || 100;

    const decimalDigitsLookup = getDecimalDigits(api, budgetId);
    let rawTransactions: TransactionData[];

    // Use the appropriate API method based on filters
    if (input.accountId) {
      const response = await api.transactions.getTransactionsByAccount(
        budgetId,
        input.accountId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type) as ynab.GetTransactionsByAccountTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.categoryId) {
      const response = await api.transactions.getTransactionsByCategory(
        budgetId,
        input.categoryId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type) as ynab.GetTransactionsByCategoryTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.payeeId) {
      const response = await api.transactions.getTransactionsByPayee(
        budgetId,
        input.payeeId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type) as ynab.GetTransactionsByPayeeTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else {
      const response = await api.transactions.getTransactions(
        budgetId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type)
      );
      rawTransactions = response.data.transactions;
    }

    const decimalDigits = await decimalDigitsLookup;

    // Filter out deleted and apply limit
    const transactions = rawTransactions
      .filter((txn) => !txn.deleted)
      .slice(0, limit)
      .map((txn) => ({
        id: txn.id,
        date: txn.date,
        amount: toDollars(txn.amount, decimalDigits),
        memo: txn.memo,
        approved: txn.approved,
        cleared: txn.cleared,
        account_name: txn.account_name,
        payee_name: txn.payee_name,
        category_name: txn.category_name,
        flag_color: txn.flag_color,
        transfer_account_id: txn.transfer_account_id,
        transfer_transaction_id: txn.transfer_transaction_id,
        matched_transaction_id: txn.matched_transaction_id,
        import_id: txn.import_id,
        // Present only on splits, whose parent row is categorised "Split".
        subtransactions: mapSubtransactions(txn.subtransactions, decimalDigits),
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          transactions,
          transaction_count: transactions.length,
          total_available: rawTransactions.filter((t) => !t.deleted).length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting transactions:", error);
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
