import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_import_transactions";
export const description = "Imports available transactions on all linked accounts for the budget. This triggers an import from connected financial institutions (equivalent to clicking 'Import' in the YNAB app).";
export const inputSchema = {
    budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
};
function getBudgetId(inputBudgetId) {
    const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
    if (!budgetId) {
        throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
    }
    return budgetId;
}
export async function execute(input, api) {
    try {
        const budgetId = getBudgetId(input.budgetId);
        console.error(`Importing transactions for budget ${budgetId}`);
        const response = await api.transactions.importTransactions(budgetId);
        return {
            content: [{
                    type: "text",
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
    }
    catch (error) {
        console.error("Error importing transactions:", error);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: getErrorMessage(error),
                    }, null, 2),
                }],
        };
    }
}
