import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_list_scheduled_transactions";
export const description = "Lists all scheduled (recurring) transactions in a budget.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
};

interface ListScheduledTransactionsInput {
  planId?: string;
  budgetId?: string;
}


export async function execute(input: ListScheduledTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing scheduled transactions for budget ${budgetId}`);
    const response = await api.scheduledTransactions.getScheduledTransactions(budgetId);

    // Filter and format scheduled transactions
    const scheduledTransactions = response.data.scheduled_transactions
      .filter((txn) => !txn.deleted)
      .map((txn) => ({
        id: txn.id,
        date_first: txn.date_first,
        date_next: txn.date_next,
        frequency: txn.frequency,
        amount: toDollars(txn.amount),
        memo: txn.memo,
        flag_color: txn.flag_color,
        account_id: txn.account_id,
        account_name: txn.account_name,
        payee_id: txn.payee_id,
        payee_name: txn.payee_name,
        category_id: txn.category_id,
        category_name: txn.category_name,
        transfer_account_id: txn.transfer_account_id,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          scheduled_transactions: scheduledTransactions,
          count: scheduledTransactions.length,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error listing scheduled transactions:", error);
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
