import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_import_transactions";
export const description = "Imports available transactions on all linked accounts for the plan. This triggers an import from connected financial institutions (equivalent to clicking 'Import' in the YNAB app).";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
};

interface ImportTransactionsInput {
  planId?: string;
  budgetId?: string;
}


export async function execute(input: ImportTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Importing transactions for budget ${budgetId}`);
    const response = await api.transactions.importTransactions(budgetId);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          transaction_ids: response.data.transaction_ids,
          imported_count: response.data.transaction_ids.length,
          message: response.data.transaction_ids.length > 0
            ? `Successfully imported ${response.data.transaction_ids.length} transaction(s)`
            : "No new transactions to import",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error importing transactions:", error);
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
