import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
export const name = "ynab_create_transaction";
export const description = "Creates a new transaction in your YNAB budget. Either payeeId or payeeName must be provided in addition to the other required fields.";
export const inputSchema = {
    budgetId: z.string().optional().describe("The id of the budget to create the transaction in (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
    accountId: z.string().describe("The id of the account to create the transaction in"),
    date: z.string().describe("The date of the transaction in ISO format (e.g. 2024-03-24)"),
    amount: z.number().describe("The amount in dollars (e.g. 10.99)"),
    payeeId: z.string().optional().describe("The id of the payee (optional if payeeName is provided)"),
    payeeName: z.string().optional().describe("The name of the payee (optional if payeeId is provided)"),
    categoryId: z.string().optional().describe("The category id for the transaction (optional)"),
    memo: z.string().optional().describe("A memo/note for the transaction (optional)"),
    cleared: z.boolean().optional().describe("Whether the transaction is cleared (optional, defaults to false)"),
    approved: z.boolean().optional().describe("Whether the transaction is approved (optional, defaults to false)"),
    flagColor: z.string().optional().describe("The transaction flag color (red, orange, yellow, green, blue, purple) (optional)"),
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
        if (!input.payeeId && !input.payeeName) {
            throw new Error("Either payeeId or payeeName must be provided");
        }
        const milliunitAmount = Math.round(input.amount * 1000);
        const transaction = {
            transaction: {
                account_id: input.accountId,
                date: input.date,
                amount: milliunitAmount,
                payee_id: input.payeeId,
                payee_name: input.payeeName,
                category_id: input.categoryId,
                memo: input.memo,
                cleared: input.cleared ? ynab.TransactionClearedStatus.Cleared : ynab.TransactionClearedStatus.Uncleared,
                approved: input.approved ?? false,
                flag_color: input.flagColor,
            }
        };
        const response = await api.transactions.createTransaction(budgetId, transaction);
        if (!response.data.transaction) {
            throw new Error("Failed to create transaction - no transaction data returned");
        }
        return {
            content: [{ type: "text", text: JSON.stringify({
                        success: true,
                        transactionId: response.data.transaction.id,
                        message: "Transaction created successfully",
                    }, null, 2) }]
        };
    }
    catch (error) {
        console.error("Error creating transaction:", error);
        return {
            content: [{ type: "text", text: JSON.stringify({
                        success: false,
                        error: getErrorMessage(error),
                    }, null, 2) }]
        };
    }
}
