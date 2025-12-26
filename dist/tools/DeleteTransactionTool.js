import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_delete_transaction";
export const description = "Deletes a transaction from the budget. This action cannot be undone.";
export const inputSchema = {
    budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
    transactionId: z.string().describe("The ID of the transaction to delete"),
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
        const response = await api.transactions.deleteTransaction(budgetId, input.transactionId);
        if (!response.data.transaction) {
            throw new Error("Failed to delete transaction - no transaction data returned");
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        transactionId: response.data.transaction.id,
                        message: "Transaction deleted successfully",
                    }, null, 2),
                }],
        };
    }
    catch (error) {
        console.error("Error deleting transaction:", error);
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
