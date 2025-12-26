import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_list_scheduled_transactions";
export const description = "Lists all scheduled (recurring) transactions in a budget.";
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
            amount: (txn.amount / 1000).toFixed(2),
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
                    type: "text",
                    text: JSON.stringify({
                        scheduled_transactions: scheduledTransactions,
                        count: scheduledTransactions.length,
                    }, null, 2),
                }],
        };
    }
    catch (error) {
        console.error("Error listing scheduled transactions:", error);
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
