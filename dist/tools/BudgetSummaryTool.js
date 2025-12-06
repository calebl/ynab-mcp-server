import { z } from "zod";
export const name = "budget_summary";
export const description = "Get a summary of the budget for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well.";
export const inputSchema = {
    budgetId: z.string().optional().describe("The ID of the budget to get a summary for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
    month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The budget month in ISO format (e.g. 2016-12-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
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
        const month = input.month || "current";
        console.log(`Getting accounts and categories for budget ${budgetId} and month ${month}`);
        const accountsResponse = await api.accounts.getAccounts(budgetId);
        const accounts = accountsResponse.data.accounts.filter((account) => account.deleted === false && account.closed === false);
        const monthBudget = await api.months.getBudgetMonth(budgetId, month);
        const categories = monthBudget.data.month.categories
            .filter((category) => category.deleted === false && category.hidden === false);
        return {
            content: [{ type: "text", text: JSON.stringify({
                        monthBudget: monthBudget.data.month,
                        accounts: accounts,
                        note: "Divide all numbers by 1000 to get the balance in dollars.",
                    }, null, 2) }]
        };
    }
    catch (error) {
        console.error(`Error getting budget ${input.budgetId || process.env.YNAB_BUDGET_ID}:`);
        console.error(JSON.stringify(error, null, 2));
        return {
            content: [{ type: "text", text: `Error getting budget ${input.budgetId || process.env.YNAB_BUDGET_ID}: ${error instanceof Error ? error.message : JSON.stringify(error)}` }]
        };
    }
}
