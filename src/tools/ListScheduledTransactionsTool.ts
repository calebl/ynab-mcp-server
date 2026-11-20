import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_list_scheduled_transactions";
export const description = "Lists the scheduled transactions set up in YNAB. To find recurring charges in transaction history, including ones that are not scheduled, use ynab_detect_recurring. For a projected balance, use ynab_balance_forecast. Pass lastKnowledgeOfServer (the server_knowledge from an earlier call) to get only rows changed since; deleted rows then come back with deleted: true.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  lastKnowledgeOfServer: z.number().int().nonnegative().optional().describe("Delta sync: the server_knowledge value from an earlier response of this tool. Only rows changed since then are returned, deleted rows included with deleted: true."),
};

interface ListScheduledTransactionsInput {
  planId?: string;
  budgetId?: string;
  lastKnowledgeOfServer?: number;
}


export async function execute(input: ListScheduledTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing scheduled transactions for budget ${budgetId}`);
    const [response, decimalDigits] = await Promise.all([
      api.scheduledTransactions.getScheduledTransactions(budgetId, input.lastKnowledgeOfServer),
      getDecimalDigits(api, budgetId),
    ]);

    // Delta mode keeps deleted rows so callers can apply the removal
    const delta = input.lastKnowledgeOfServer !== undefined;
    // Filter and format scheduled transactions
    const scheduledTransactions = response.data.scheduled_transactions
      .filter((txn) => delta || !txn.deleted)
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
        deleted: txn.deleted,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          scheduled_transactions: scheduledTransactions,
          count: scheduledTransactions.length,
          server_knowledge: response.data.server_knowledge,
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
