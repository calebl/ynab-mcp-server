import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_list_payees";
export const description = "Lists all payees in a budget. Useful for finding payee IDs when creating transactions.";
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
        console.error(`Listing payees for budget ${budgetId}`);
        const response = await api.payees.getPayees(budgetId);
        // Filter out deleted payees and format the response
        const payees = response.data.payees
            .filter((payee) => !payee.deleted)
            .map((payee) => ({
            id: payee.id,
            name: payee.name,
            transfer_account_id: payee.transfer_account_id,
        }));
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        payees,
                        payee_count: payees.length,
                    }, null, 2),
                }],
        };
    }
    catch (error) {
        console.error("Error listing payees:", error);
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
