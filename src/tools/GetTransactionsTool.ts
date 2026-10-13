import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";
import { mapSubtransactions } from "./splits.js";

export const name = "ynab_get_transactions";
export const description = "Gets transactions from a plan with optional filters. Can filter by date range, month, account, category, payee, transaction type, or approval status.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only return transactions on or after this date (ISO format: 2024-01-01)"),
  untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only return transactions on or before this date (ISO format: 2024-01-31)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-01)$/).optional().describe("Only return transactions in this plan month: the first day of the month (e.g. 2024-03-01) or 'current'. Cannot be combined with accountId, categoryId, or payeeId; can be combined with sinceDate/untilDate."),
  type: z.enum(["all", "uncategorized", "unapproved"]).optional().describe("Filter by transaction type. Defaults to 'all'."),
  accountId: z.string().optional().describe("Filter to only transactions in this account"),
  categoryId: z.string().optional().describe("Filter to only transactions in this category"),
  payeeId: z.string().optional().describe("Filter to only transactions with this payee"),
  approved: z.boolean().optional().describe("Only return approved (true) or unapproved (false) transactions. Applied in code after fetching, before limit."),
  limit: z.number().int().positive().max(1000).optional().describe("Maximum number of transactions to return (default: 100)"),
};

interface GetTransactionsInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  untilDate?: string;
  month?: string;
  type?: "all" | "uncategorized" | "unapproved";
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  approved?: boolean;
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

export interface TransactionData {
  id: string;
  date: string;
  amount: number;
  memo?: string | null;
  approved: boolean;
  cleared: string;
  account_id: string;
  payee_id?: string | null;
  category_id?: string | null;
  import_id?: string | null;
  account_name?: string | null;
  payee_name?: string | null;
  category_name?: string | null;
  flag_color?: string | null;
  transfer_account_id?: string | null;
  subtransactions?: ynab.SubTransaction[];
  deleted: boolean;
}

export function mapTransaction(txn: TransactionData) {
  return {
    id: txn.id,
    date: txn.date,
    amount: toDollars(txn.amount),
    memo: txn.memo,
    approved: txn.approved,
    cleared: txn.cleared,
    account_id: txn.account_id,
    account_name: txn.account_name,
    payee_id: txn.payee_id,
    payee_name: txn.payee_name,
    category_id: txn.category_id,
    category_name: txn.category_name,
    flag_color: txn.flag_color,
    transfer_account_id: txn.transfer_account_id,
    import_id: txn.import_id,
    // Present only on splits, whose parent row is categorised "Split".
    subtransactions: mapSubtransactions(txn.subtransactions),
  };
}

export async function execute(input: GetTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const limit = input.limit || 100;

    let rawTransactions: TransactionData[];

    // Use the appropriate API method based on filters. The untilDate slot is
    // always passed so type never lands in it (SDK 4.x signature).
    if (
      input.month !== undefined &&
      (input.accountId !== undefined || input.categoryId !== undefined || input.payeeId !== undefined)
    ) {
      throw new Error("month cannot be combined with accountId, categoryId, or payeeId");
    }

    if (input.month) {
      const response = await api.transactions.getTransactionsByMonth(
        budgetId,
        input.month,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByMonthTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.accountId) {
      const response = await api.transactions.getTransactionsByAccount(
        budgetId,
        input.accountId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByAccountTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.categoryId) {
      const response = await api.transactions.getTransactionsByCategory(
        budgetId,
        input.categoryId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByCategoryTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.payeeId) {
      const response = await api.transactions.getTransactionsByPayee(
        budgetId,
        input.payeeId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByPayeeTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else {
      const response = await api.transactions.getTransactions(
        budgetId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type)
      );
      rawTransactions = response.data.transactions;
    }

    // Drop deleted rows and apply the approval filter before limit, so
    // total_available counts every matching row.
    const visible = rawTransactions
      .filter((txn) => !txn.deleted)
      .filter((txn) => input.approved === undefined || txn.approved === input.approved);
    const transactions = visible.slice(0, limit).map(mapTransaction);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          transactions,
          transaction_count: transactions.length,
          total_available: visible.length,
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
