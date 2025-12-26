import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_list_accounts";
export const description = "Lists all accounts in a budget. Useful for finding account IDs when creating transactions.";
export const inputSchema = {
    budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
    includeClosedAccounts: z.boolean().optional().describe("Include closed accounts in the list (default: false)"),
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
        const includeClosedAccounts = input.includeClosedAccounts ?? false;
        console.error(`Listing accounts for budget ${budgetId}`);
        const response = await api.accounts.getAccounts(budgetId);
        // Filter and format accounts
        const accounts = response.data.accounts
            .filter((account) => !account.deleted && (includeClosedAccounts || !account.closed))
            .map((account) => ({
            id: account.id,
            name: account.name,
            type: account.type,
            on_budget: account.on_budget,
            closed: account.closed,
            balance: (account.balance / 1000).toFixed(2),
            cleared_balance: (account.cleared_balance / 1000).toFixed(2),
            uncleared_balance: (account.uncleared_balance / 1000).toFixed(2),
            transfer_payee_id: account.transfer_payee_id,
        }));
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        accounts,
                        account_count: accounts.length,
                    }, null, 2),
                }],
        };
    }
    catch (error) {
        console.error("Error listing accounts:", error);
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
