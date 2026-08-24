import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_create_split_transaction";
export const description = "Creates a new split transaction in your YNAB budget, dividing the total across multiple categories. Either payeeId or payeeName must be provided. At least 2 subtransactions are required.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The id of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  accountId: z.string().describe("The id of the account to create the transaction in"),
  date: z.string().describe("The date of the transaction in ISO format (e.g. 2024-03-24)"),
  payeeId: z.string().optional().describe("The id of the payee (optional if payeeName is provided)"),
  payeeName: z.string().optional().describe("The name of the payee (optional if payeeId is provided)"),
  memo: z.string().optional().describe("A memo/note for the overall transaction (optional)"),
  cleared: z.boolean().optional().describe("Whether the transaction is cleared (optional, defaults to false)"),
  approved: z.boolean().optional().describe("Whether the transaction is approved (optional, defaults to false)"),
  flagColor: z.string().optional().describe("The transaction flag color (red, orange, yellow, green, blue, purple) (optional)"),
  subtransactions: z.array(z.object({
    amount: z.number().describe("The subtransaction amount in dollars (e.g. 10.99)"),
    categoryId: z.string().optional().describe("The category id for this split (optional)"),
    memo: z.string().optional().describe("A memo for this split (optional)"),
    payeeId: z.string().optional().describe("Override payee id for this split (optional)"),
    payeeName: z.string().optional().describe("Override payee name for this split (optional)"),
  })).min(2).describe("Array of split entries (minimum 2). Amounts in dollars; totals become the transaction amount."),
};

interface SubtransactionInput {
  amount: number;
  categoryId?: string;
  memo?: string;
  payeeId?: string;
  payeeName?: string;
}

interface CreateSplitTransactionInput {
  budgetId?: string;
  accountId: string;
  date: string;
  payeeId?: string;
  payeeName?: string;
  memo?: string;
  cleared?: boolean;
  approved?: boolean;
  flagColor?: string;
  subtransactions: SubtransactionInput[];
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

export async function execute(input: CreateSplitTransactionInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);

    if (!input.payeeId && !input.payeeName) {
      throw new Error("Either payeeId or payeeName must be provided");
    }

    if (input.subtransactions.length < 2) {
      throw new Error("At least 2 subtransactions are required for a split transaction");
    }

    const subtransactions = input.subtransactions.map((s) => ({
      amount: Math.round(s.amount * 1000),
      category_id: s.categoryId,
      memo: s.memo,
      payee_id: s.payeeId,
      payee_name: s.payeeName,
    }));

    const totalMilliunits = subtransactions.reduce((sum, s) => sum + s.amount, 0);

    const transaction: ynab.PostTransactionsWrapper = {
      transaction: {
        account_id: input.accountId,
        date: input.date,
        amount: totalMilliunits,
        payee_id: input.payeeId,
        payee_name: input.payeeName,
        category_id: null,
        memo: input.memo,
        cleared: input.cleared ? ynab.TransactionClearedStatus.Cleared : ynab.TransactionClearedStatus.Uncleared,
        approved: input.approved ?? false,
        flag_color: input.flagColor as ynab.TransactionFlagColor,
        subtransactions,
      },
    };

    const response = await api.transactions.createTransaction(budgetId, transaction);

    if (!response.data.transaction) {
      throw new Error("Failed to create split transaction - no transaction data returned");
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: true,
        transactionId: response.data.transaction.id,
        totalAmount: (totalMilliunits / 1000).toFixed(2),
        subtransactionCount: subtransactions.length,
        message: "Split transaction created successfully",
      }, null, 2) }],
    };
  } catch (error) {
    console.error("Error creating split transaction:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }],
    };
  }
}
