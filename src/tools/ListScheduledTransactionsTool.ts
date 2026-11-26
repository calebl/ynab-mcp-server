import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_list_scheduled_transactions";
export const description = "Lists the scheduled transactions set up in YNAB, optionally only those in one account with accountId. Pass scheduledTransactionId to fetch just one (accountId is then ignored). To find recurring charges in transaction history, including ones that are not scheduled, use ynab_detect_recurring. For a projected balance, use ynab_balance_forecast.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  scheduledTransactionId: z.string().optional().describe("Return only this scheduled transaction (optional)"),
  accountId: z.string().optional().describe("Only return scheduled transactions in this account (optional; ignored when scheduledTransactionId is given)"),
};

interface ListScheduledTransactionsInput {
  planId?: string;
  budgetId?: string;
  scheduledTransactionId?: string;
  accountId?: string;
}


export async function execute(input: ListScheduledTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing scheduled transactions for budget ${budgetId}`);
    const [rows, decimalDigits] = await Promise.all([
      input.scheduledTransactionId
        ? api.scheduledTransactions
            .getScheduledTransactionById(budgetId, input.scheduledTransactionId)
            .then((r) => [r.data.scheduled_transaction])
        : api.scheduledTransactions.getScheduledTransactions(budgetId).then((r) => r.data.scheduled_transactions),
      getDecimalDigits(api, budgetId),
    ]);

    // Filter and format scheduled transactions
    const scheduledTransactions = rows
      .filter((txn) => !txn.deleted)
      .filter((txn) => input.scheduledTransactionId || input.accountId === undefined || txn.account_id === input.accountId)
      .map((txn) => ({
        id: txn.id,
        date_first: txn.date_first,
        date_next: txn.date_next,
        frequency: txn.frequency,
        amount: toDollars(txn.amount, decimalDigits),
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
