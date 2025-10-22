import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, milliUnitsToAmount, formatCurrency, formatDate } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface ListTransactionsInput {
  budgetId?: string;
  accountId?: string;
  accountName?: string;
  filters?: {
    approved?: boolean;
    cleared?: "cleared" | "uncleared" | "reconciled";
    payee?: string;
    category?: string;
    minAmount?: number;
    maxAmount?: number;
    startDate?: string;
    endDate?: string;
    memo?: string;
  };
  response_format?: "json" | "markdown";
  limit?: number;
  offset?: number;
}

interface TransactionResult {
  id: string;
  date: string;
  amount: number;
  memo?: string;
  approved: boolean;
  cleared: string;
  account_name: string;
  payee_name?: string;
  category_name?: string;
  transfer_account_id?: string;
  transfer_transaction_id?: string;
  matched_transaction_id?: string;
  import_id?: string;
  flag_color?: string;
  flag_name?: string;
}

class ListTransactionsTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_list_transactions",
      description: "List transactions from a budget with comprehensive filtering options. Supports filtering by account, approval status, cleared status, and other criteria.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to list transactions from (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          accountId: {
            type: "string",
            description: "The ID of the account to filter transactions by (optional if accountName is provided)",
          },
          accountName: {
            type: "string",
            description: "The name of the account to filter transactions by (optional if accountId is provided). Supports partial matching.",
          },
          filters: {
            type: "object",
            properties: {
              approved: {
                type: "boolean",
                description: "Filter by approval status (true for approved, false for unapproved)",
              },
              cleared: {
                type: "string",
                enum: ["cleared", "uncleared", "reconciled"],
                description: "Filter by cleared status: 'cleared' for cleared transactions, 'uncleared' for uncleared, 'reconciled' for reconciled",
              },
              payee: {
                type: "string",
                description: "Filter by payee name (supports partial matching)",
              },
              category: {
                type: "string",
                description: "Filter by category name (supports partial matching)",
              },
              minAmount: {
                type: "number",
                description: "Minimum transaction amount in dollars",
              },
              maxAmount: {
                type: "number",
                description: "Maximum transaction amount in dollars",
              },
              startDate: {
                type: "string",
                description: "Start date for transaction filter (YYYY-MM-DD format)",
              },
              endDate: {
                type: "string",
                description: "End date for transaction filter (YYYY-MM-DD format)",
              },
              memo: {
                type: "string",
                description: "Filter by memo text (supports partial matching)",
              },
            },
            additionalProperties: false,
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
          limit: {
            type: "number",
            default: 50,
            description: "Maximum number of transactions to return (default: 50, max: 100)",
          },
          offset: {
            type: "number",
            default: 0,
            description: "Number of transactions to skip (default: 0)",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "List YNAB Transactions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: ListTransactionsInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      console.error(`Listing transactions for budget ${budgetId}`);

      // Get all transactions for the budget
      const transactionsResponse = await createRetryableAPICall(
        () => this.api.transactions.getTransactions(budgetId),
        'Get transactions for listing'
      );

      // Get accounts for name resolution
      const accountsResponse = await createRetryableAPICall(
        () => this.api.accounts.getAccounts(budgetId),
        'Get accounts for transaction listing'
      );
      const accounts = accountsResponse.data.accounts;

      // Get categories for name resolution
      const categoriesResponse = await createRetryableAPICall(
        () => this.api.categories.getCategories(budgetId),
        'Get categories for transaction listing'
      );
      const categories = categoriesResponse.data.category_groups.flatMap(group => group.categories);

      // Filter by account if specified
      let filteredTransactions = transactionsResponse.data.transactions.filter(t => !t.deleted);
      
      if (input.accountId || input.accountName) {
        const targetAccount = this.findAccount(accounts, input.accountId, input.accountName);
        if (targetAccount) {
          filteredTransactions = filteredTransactions.filter(t => t.account_id === targetAccount.id);
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Account not found. Please check the account ID or name.`,
              },
            ],
          };
        }
      }

      // Apply additional filters
      const finalFilteredTransactions = this.applyFilters(
        filteredTransactions,
        accounts,
        categories,
        input.filters || {}
      );

      // Transform transactions to readable format
      const transformedTransactions = this.transformTransactions(finalFilteredTransactions);

      // Apply pagination
      const limit = Math.min(input.limit || 50, 100);
      const offset = input.offset || 0;
      const total = transformedTransactions.length;
      const paginatedTransactions = transformedTransactions.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      const nextOffset = hasMore ? offset + limit : null;

      const result = {
        transactions: paginatedTransactions,
        pagination: {
          total,
          count: paginatedTransactions.length,
          offset,
          limit,
          has_more: hasMore,
          next_offset: nextOffset,
        },
        transaction_count: paginatedTransactions.length,
        filters_applied: input.filters || {},
        account_filter: input.accountId || input.accountName || "all",
      };

      const format = input.response_format || "markdown";
      let responseText: string;

      if (format === "json") {
        responseText = JSON.stringify(result, null, 2);
      } else {
        responseText = this.formatMarkdown(result);
      }

      const { text } = truncateResponse(responseText, CHARACTER_LIMIT);

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    } catch (error) {
      console.error(`Error listing transactions:`);
      console.error(JSON.stringify(error, null, 2));
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error listing transactions: ${
              error instanceof Error ? error.message : JSON.stringify(error)
            }`,
          },
        ],
      };
    }
  }

  private findAccount(accounts: ynab.Account[], accountId?: string, accountName?: string): ynab.Account | null {
    if (accountId) {
      return accounts.find(account => account.id === accountId) || null;
    }
    if (accountName) {
      return accounts.find(account => 
        account.name.toLowerCase().includes(accountName.toLowerCase())
      ) || null;
    }
    return null;
  }

  private applyFilters(
    transactions: ynab.TransactionDetail[],
    accounts: ynab.Account[],
    categories: ynab.Category[],
    filters: NonNullable<ListTransactionsInput['filters']>
  ): ynab.TransactionDetail[] {
    return transactions.filter(transaction => {
      // Filter by approval status
      if (filters.approved !== undefined && transaction.approved !== filters.approved) {
        return false;
      }

      // Filter by cleared status
      if (filters.cleared) {
        const clearedStatus = this.getClearedStatus(transaction);
        if (filters.cleared === "cleared" && clearedStatus !== "cleared") {
          return false;
        }
        if (filters.cleared === "uncleared" && clearedStatus !== "uncleared") {
          return false;
        }
        if (filters.cleared === "reconciled" && clearedStatus !== "reconciled") {
          return false;
        }
      }


      // Filter by payee
      if (filters.payee) {
        if (!transaction.payee_name || !transaction.payee_name.toLowerCase().includes(filters.payee.toLowerCase())) {
          return false;
        }
      }

      // Filter by category
      if (filters.category) {
        if (!transaction.category_name || !transaction.category_name.toLowerCase().includes(filters.category.toLowerCase())) {
          return false;
        }
      }

      // Filter by amount range
      const amount = milliUnitsToAmount(transaction.amount);
      if (filters.minAmount !== undefined && amount < filters.minAmount) {
        return false;
      }
      if (filters.maxAmount !== undefined && amount > filters.maxAmount) {
        return false;
      }

      // Filter by date range
      if (filters.startDate && transaction.date < filters.startDate) {
        return false;
      }
      if (filters.endDate && transaction.date > filters.endDate) {
        return false;
      }

      // Filter by memo
      if (filters.memo) {
        if (!transaction.memo || !transaction.memo.toLowerCase().includes(filters.memo.toLowerCase())) {
          return false;
        }
      }

      return true;
    });
  }

  private getClearedStatus(transaction: ynab.TransactionDetail): string {
    if (transaction.cleared === ynab.TransactionClearedStatus.Reconciled) {
      return "reconciled";
    }
    if (transaction.cleared === ynab.TransactionClearedStatus.Cleared) {
      return "cleared";
    }
    return "uncleared";
  }

  private transformTransactions(transactions: ynab.TransactionDetail[]): TransactionResult[] {
    return transactions.map(transaction => ({
      id: transaction.id,
      date: transaction.date,
      amount: milliUnitsToAmount(transaction.amount),
      memo: transaction.memo || undefined,
      approved: transaction.approved,
      cleared: this.getClearedStatus(transaction),
      account_name: transaction.account_name,
      payee_name: transaction.payee_name || undefined,
      category_name: transaction.category_name || undefined,
      transfer_account_id: transaction.transfer_account_id || undefined,
      transfer_transaction_id: transaction.transfer_transaction_id || undefined,
      matched_transaction_id: transaction.matched_transaction_id || undefined,
      import_id: transaction.import_id || undefined,
      flag_color: transaction.flag_color || undefined,
      flag_name: transaction.flag_name || undefined,
    }));
  }

  private formatMarkdown(result: { 
    transactions: TransactionResult[]; 
    transaction_count: number; 
    pagination: any;
    filters_applied: any;
    account_filter: string;
  }): string {
    let output = "# YNAB Transactions\n\n";
    
    // Summary
    output += `Found ${result.pagination.total} transaction(s) total\n`;
    output += `Showing ${result.transaction_count} transactions (offset: ${result.pagination.offset}, limit: ${result.pagination.limit})\n`;
    output += `Account Filter: ${result.account_filter}\n\n`;

    // Filters applied
    const activeFilters = Object.entries(result.filters_applied).filter(([_, value]) => value !== undefined);
    if (activeFilters.length > 0) {
      output += "## Filters Applied\n";
      for (const [key, value] of activeFilters) {
        output += `- **${key}**: ${value}\n`;
      }
      output += "\n";
    }

    if (result.transaction_count === 0) {
      output += "No transactions found matching the specified criteria.\n";
      return output;
    }

    // Transactions
    output += "## Transactions\n\n";
    for (const txn of result.transactions) {
      output += `### ${txn.payee_name || "Unknown Payee"}\n`;
      output += `- **Date:** ${formatDate(txn.date)}\n`;
      output += `- **Amount:** ${formatCurrency(txn.amount)}\n`;
      output += `- **Account:** ${txn.account_name}\n`;
      output += `- **Approved:** ${txn.approved ? "Yes" : "No"}\n`;
      output += `- **Cleared:** ${txn.cleared}\n`;
      if (txn.category_name) {
        output += `- **Category:** ${txn.category_name}\n`;
      }
      if (txn.memo) {
        output += `- **Memo:** ${txn.memo}\n`;
      }
      if (txn.flag_color) {
        output += `- **Flag:** ${txn.flag_name || txn.flag_color}\n`;
      }
      output += `- **Transaction ID:** \`${txn.id}\`\n`;
      output += "\n";
    }

    // Pagination info
    output += "---\n\n";
    output += "## Pagination\n";
    output += `- **Total**: ${result.pagination.total}\n`;
    output += `- **Count**: ${result.pagination.count}\n`;
    output += `- **Offset**: ${result.pagination.offset}\n`;
    output += `- **Limit**: ${result.pagination.limit}\n`;
    output += `- **Has More**: ${result.pagination.has_more}\n`;
    if (result.pagination.next_offset !== null) {
      output += `- **Next Offset**: ${result.pagination.next_offset}\n`;
    }

    return output;
  }
}

export default ListTransactionsTool;
