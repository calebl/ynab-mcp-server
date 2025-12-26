import { z } from "zod";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_list_months";
export const description = "Lists all budget months. Each month contains summary information about budgeting status.";
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
        console.error(`Listing months for budget ${budgetId}`);
        const response = await api.months.getBudgetMonths(budgetId);
        // Format the months
        const months = response.data.months.map((month) => ({
            month: month.month,
            note: month.note,
            income: (month.income / 1000).toFixed(2),
            budgeted: (month.budgeted / 1000).toFixed(2),
            activity: (month.activity / 1000).toFixed(2),
            to_be_budgeted: (month.to_be_budgeted / 1000).toFixed(2),
            age_of_money: month.age_of_money,
        }));
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        months,
                        month_count: months.length,
                    }, null, 2),
                }],
        };
    }
    catch (error) {
        console.error("Error listing months:", error);
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
