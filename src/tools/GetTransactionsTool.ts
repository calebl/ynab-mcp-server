import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";
import { mapSubtransactions } from "./splits.js";

export const name = "ynab_get_transactions";
export const description = "Gets transactions from a plan with optional filters. Can filter by date range, account, category, payee, or approval status. Pass lastKnowledgeOfServer (server_knowledge from an earlier response) for only transactions changed since then, deleted ones included with deleted: true. If transaction_count is below total_available the result was truncated by limit; raise limit before storing server_knowledge.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only return transactions on or after this date (ISO format: 2024-01-01)"),
  type: z.enum(["all", "uncategorized", "unapproved"]).optional().describe("Filter by transaction type. Defaults to 'all'."),
  accountId: z.string().optional().describe("Filter to only transactions in this account"),
  categoryId: z.string().optional().describe("Filter to only transactions in this category"),
  payeeId: z.string().optional().describe("Filter to only transactions with this payee"),
  limit: z.number().int().positive().max(1000).optional().describe("Maximum number of transactions to return (default: 100)"),
  lastKnowledgeOfServer: z.number().int().nonnegative().optional().describe("Delta sync: the server_knowledge value from an earlier response of this tool. Only rows changed since then are returned, deleted rows included with deleted: true."),
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
  lastKnowledgeOfServer?: number;
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
  subtransactions?: ynab.SubTransaction[];
  deleted: boolean;
}

export async function execute(input: GetTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const limit = input.limit || 100;

    let rawTransactions: TransactionData[];
    let serverKnowledge: number | undefined;

    // Use the appropriate API method based on filters
    if (input.accountId) {
      const response = await api.transactions.getTransactionsByAccount(
        budgetId,
        input.accountId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type) as ynab.GetTransactionsByAccountTypeEnum,
        input.lastKnowledgeOfServer
      );
      rawTransactions = response.data.transactions;
      serverKnowledge = response.data.server_knowledge;
    } else if (input.categoryId) {
      const response = await api.transactions.getTransactionsByCategory(
        budgetId,
        input.categoryId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type) as ynab.GetTransactionsByCategoryTypeEnum,
        input.lastKnowledgeOfServer
      );
      rawTransactions = response.data.transactions;
      serverKnowledge = response.data.server_knowledge;
    } else if (input.payeeId) {
      const response = await api.transactions.getTransactionsByPayee(
        budgetId,
        input.payeeId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type) as ynab.GetTransactionsByPayeeTypeEnum,
        input.lastKnowledgeOfServer
      );
      rawTransactions = response.data.transactions;
      serverKnowledge = response.data.server_knowledge;
    } else {
      const response = await api.transactions.getTransactions(
        budgetId,
        input.sinceDate,
        undefined,
        mapTransactionType(input.type),
        input.lastKnowledgeOfServer
      );
      rawTransactions = response.data.transactions;
      serverKnowledge = response.data.server_knowledge;
    }

    const delta = input.lastKnowledgeOfServer !== undefined;
    const visible = rawTransactions.filter((txn) => delta || !txn.deleted);

    // Filter out deleted and apply limit
    const transactions = visible
      .slice(0, limit)
      .map((txn) => ({
        id: txn.id,
        date: txn.date,
        amount: toDollars(txn.amount),
        memo: txn.memo,
        approved: txn.approved,
        cleared: txn.cleared,
        account_name: txn.account_name,
        payee_name: txn.payee_name,
        category_name: txn.category_name,
        flag_color: txn.flag_color,
        transfer_account_id: txn.transfer_account_id,
        // Present only on splits, whose parent row is categorised "Split".
        subtransactions: mapSubtransactions(txn.subtransactions),
        deleted: txn.deleted,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          transactions,
          transaction_count: transactions.length,
          total_available: visible.length,
          server_knowledge: serverKnowledge,
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
