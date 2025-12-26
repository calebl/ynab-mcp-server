import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_bulk_approve_transactions";
export const description = "Approves multiple transactions at once. Provide an array of transaction IDs to approve them all in a single API call.";
export const inputSchema = {
    budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
    transactionIds: z.array(z.string()).describe("Array of transaction IDs to approve"),
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
        if (!input.transactionIds || input.transactionIds.length === 0) {
            throw new Error("No transaction IDs provided");
        }
        // Build the update transactions array
        const transactions = input.transactionIds.map((id) => ({
            id,
            approved: true,
        }));
        const response = await api.transactions.updateTransactions(budgetId, {
            transactions,
        });
        if (!response.data.transactions) {
            throw new Error("Failed to update transactions - no transaction data returned");
        }
        const updatedTransactions = response.data.transactions.map((txn) => ({
            id: txn.id,
            date: txn.date,
            amount: (txn.amount / 1000).toFixed(2),
            payee_name: txn.payee_name,
            approved: txn.approved,
        }));
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        approved_count: updatedTransactions.length,
                        transactions: updatedTransactions,
                        message: `Successfully approved ${updatedTransactions.length} transaction(s)`,
                    }, null, 2),
                }],
        };
    }
    catch (error) {
        console.error("Error bulk approving transactions:", error);
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
