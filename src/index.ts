#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as ynab from "ynab";

const server = new McpServer({
  name: "ynab-mcp-server",
  version: "0.1.2",
});

// Initialize YNAB API
const api = new ynab.API(process.env.YNAB_API_TOKEN || "");
const defaultBudgetId = process.env.YNAB_BUDGET_ID || "";

// Helper function to validate budget ID
function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || defaultBudgetId;
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

// Register list_budgets tool
server.registerTool("list_budgets", {
  title: "List Budgets",
  description: "Lists all available budgets from YNAB API",
  inputSchema: {},
}, async () => {
  try {
    if (!process.env.YNAB_API_TOKEN) {
      return {
        content: [{ type: "text", text: "YNAB API Token is not set" }]
      };
    }

    console.log("Listing budgets");
    const budgetsResponse = await api.budgets.getBudgets();
    console.log(`Found ${budgetsResponse.data.budgets.length} budgets`);

    const budgets = budgetsResponse.data.budgets.map((budget) => ({
      id: budget.id,
      name: budget.name,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(budgets, null, 2) }]
    };
  } catch (error: unknown) {
    console.error(`Error listing budgets: ${JSON.stringify(error)}`);
    return {
      content: [{ type: "text", text: `Error listing budgets: ${JSON.stringify(error)}` }]
    };
  }
});

// Register get_unapproved_transactions tool
server.registerTool("get_unapproved_transactions", {
  title: "Get Unapproved Transactions",
  description: "Gets unapproved transactions from a budget. First time pulls last 3 days, subsequent pulls use server knowledge to get only changes.",
  inputSchema: {
    budgetId: z.string().optional().describe("The ID of the budget to fetch transactions for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
  },
}, async (input) => {
  try {
    const budgetId = getBudgetId(input.budgetId);

    console.log(`Getting unapproved transactions for budget ${budgetId}`);

    const response = await api.transactions.getTransactions(
      budgetId,
      undefined,
      ynab.GetTransactionsTypeEnum.Unapproved
    );

    // Transform the transactions to a more readable format
    const transactions = response.data.transactions
      .filter((transaction) => !transaction.deleted)
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        amount: (transaction.amount / 1000).toFixed(2), // Convert milliunits to actual currency
        memo: transaction.memo,
        approved: transaction.approved,
        account_name: transaction.account_name,
        payee_name: transaction.payee_name,
        category_name: transaction.category_name,
        transfer_account_id: transaction.transfer_account_id,
        transfer_transaction_id: transaction.transfer_transaction_id,
        matched_transaction_id: transaction.matched_transaction_id,
        import_id: transaction.import_id,
      }));

    return {
      content: [{ type: "text", text: JSON.stringify({
        transactions,
        transaction_count: transactions.length,
      }, null, 2) }]
    };
  } catch (error) {
    console.error(`Error getting unapproved transactions for budget ${input.budgetId || defaultBudgetId}:`);
    console.error(JSON.stringify(error, null, 2));
    return {
      content: [{ type: "text", text: `Error getting unapproved transactions: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }` }]
    };
  }
});

// Register budget_summary tool
server.registerTool("budget_summary", {
  title: "Budget Summary",
  description: "Get a summary of the budget for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well.",
  inputSchema: {
    budgetId: z.string().optional().describe("The ID of the budget to get a summary for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
    month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).default("current").describe("The budget month in ISO format (e.g. 2016-12-01). The string 'current' can also be used to specify the current calendar month (UTC)"),
  },
}, async (input) => {
  try {
    const budgetId = getBudgetId(input.budgetId);
    const month = input.month || "current";

    console.log(`Getting accounts and categories for budget ${budgetId} and month ${month}`);
    const accountsResponse = await api.accounts.getAccounts(budgetId);
    const accounts = accountsResponse.data.accounts.filter(
      (account) => account.deleted === false && account.closed === false
    );

    const monthBudget = await api.months.getBudgetMonth(budgetId, month);

    const categories = monthBudget.data.month.categories
      .filter(
        (category) => category.deleted === false && category.hidden === false
      );

    return {
      content: [{ type: "text", text: JSON.stringify({
        monthBudget: monthBudget.data.month,
        accounts: accounts,
        note: "Divide all numbers by 1000 to get the balance in dollars.",
      }, null, 2) }]
    };
  } catch (error: unknown) {
    console.error(`Error getting budget ${input.budgetId || defaultBudgetId}:`);
    console.error(JSON.stringify(error, null, 2));
    return {
      content: [{ type: "text", text: `Error getting budget ${input.budgetId || defaultBudgetId}: ${JSON.stringify(error)}` }]
    };
  }
});

// Register create_transaction tool
server.registerTool("create_transaction", {
  title: "Create Transaction",
  description: "Creates a new transaction in your YNAB budget. Either payeeId or payeeName must be provided in addition to the other required fields.",
  inputSchema: {
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
  },
}, async (input) => {
  try {
    const budgetId = getBudgetId(input.budgetId);

    if(!input.payeeId && !input.payeeName) {
      throw new Error("Either payeeId or payeeName must be provided");
    }

    const milliunitAmount = Math.round(input.amount * 1000);

    const transaction: ynab.PostTransactionsWrapper = {
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
        flag_color: input.flagColor as ynab.TransactionFlagColor,
      }
    };

    const response = await api.transactions.createTransaction(
      budgetId,
      transaction
    );

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
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      }, null, 2) }]
    };
  }
});

// Register approve_transaction tool
server.registerTool("approve_transaction", {
  title: "Approve Transaction",
  description: "Approves an existing transaction in your YNAB budget.",
  inputSchema: {
    budgetId: z.string().optional().describe("The id of the budget containing the transaction (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)"),
    transactionId: z.string().describe("The id of the transaction to approve"),
    approved: z.boolean().optional().default(true).describe("Whether the transaction should be marked as approved"),
  },
}, async (input) => {
  try {
    const budgetId = getBudgetId(input.budgetId);

    // First, get the existing transaction to ensure we don't lose any data
    const existingTransaction = await api.transactions.getTransactionById(budgetId, input.transactionId);

    if (!existingTransaction.data.transaction) {
      throw new Error("Transaction not found");
    }

    const existingTransactionData = existingTransaction.data.transaction;

    const transaction: ynab.PutTransactionWrapper = {
      transaction: {
        approved: input.approved ?? true,
      }
    };

    const response = await api.transactions.updateTransaction(
      budgetId,
      existingTransactionData.id,
      transaction
    );

    if (!response.data.transaction) {
      throw new Error("Failed to update transaction - no transaction data returned");
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        success: true,
        transactionId: response.data.transaction.id,
        message: "Transaction updated successfully",
      }, null, 2) }]
    };
  } catch (error) {
    console.error(`Error updating transaction for budget ${input.budgetId || defaultBudgetId}:`);
    console.error(JSON.stringify(error, null, 2));
    return {
      content: [{ type: "text", text: `Error updating transaction: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }` }]
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("YNAB MCP server running on stdio");
}

main().catch(console.error);
