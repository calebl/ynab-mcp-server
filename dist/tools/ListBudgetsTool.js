import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_list_budgets";
export const description = "Lists all available budgets from YNAB API";
export const inputSchema = {};
export async function execute(_input, api) {
    try {
        if (!process.env.YNAB_API_TOKEN) {
            return {
                content: [{ type: "text", text: "YNAB API Token is not set" }]
            };
        }
        console.error("Listing budgets");
        const budgetsResponse = await api.budgets.getBudgets();
        console.error(`Found ${budgetsResponse.data.budgets.length} budgets`);
        const budgets = budgetsResponse.data.budgets.map((budget) => ({
            id: budget.id,
            name: budget.name,
        }));
        return {
            content: [{ type: "text", text: JSON.stringify(budgets, null, 2) }]
        };
    }
    catch (error) {
        console.error("Error listing budgets:", error);
        return {
            content: [{ type: "text", text: JSON.stringify({
                        success: false,
                        error: getErrorMessage(error),
                    }, null, 2) }]
        };
    }
}
