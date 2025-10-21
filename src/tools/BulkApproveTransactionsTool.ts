import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { optimizeTransactions, withContextOptimization } from "../utils/contextOptimizer.js";
import {
  truncateResponse,
  CHARACTER_LIMIT,
  getBudgetId,
  amountToMilliUnits,
  milliUnitsToAmount,
  formatCurrency,
} from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface BulkApproveTransactionsInput {
  budgetId?: string;
  filters?: {
    payee?: string;
    category?: string;
    account?: string;
    minAmount?: number;
    maxAmount?: number;
    startDate?: string;
    endDate?: string;
    memo?: string;
  };
  dryRun?: boolean;
  response_format?: "json" | "markdown";
  limit?: number;
  offset?: number;
}

interface TransactionFilter {
  id: string;
  date: string;
  amount: number;
  payeeName?: string;
  categoryName?: string;
  accountName: string;
  memo?: string;
  approved: boolean;
  cleared: string;
}

class BulkApproveTransactionsTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_bulk_approve_transactions",
      description: "Approve multiple transactions matching specified criteria in one operation. Supports various filters and natural language patterns.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to approve transactions for (optional, defaults to YNAB_BUDGET_ID environment variable)",
          },
          filters: {
            type: "object",
            properties: {
              payee: {
                type: "string",
                description: "Filter by payee name (supports partial matching)",
              },
              category: {
                type: "string",
                description: "Filter by category name (supports partial matching)",
              },
              account: {
                type: "string",
                description: "Filter by account name (supports partial matching)",
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
          dryRun: {
            type: "boolean",
            default: false,
            description: "If true, will not make any actual changes, just return what would be approved",
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
        title: "Bulk Approve YNAB Transactions",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: BulkApproveTransactionsInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      console.log(`Bulk approving transactions for budget ${budgetId}`);

      // Get all transactions for the budget
      const transactionsResponse = await createRetryableAPICall(
        () => this.api.transactions.getTransactions(budgetId),
        'Get transactions for bulk approve'
      );
      const allTransactions = transactionsResponse.data.transactions.filter(t => !t.deleted);

      // Get accounts and categories for name resolution
      const accountsResponse = await createRetryableAPICall(
        () => this.api.accounts.getAccounts(budgetId),
        'Get accounts for bulk approve'
      );
      const accounts = accountsResponse.data.accounts;

      const categoriesResponse = await createRetryableAPICall(
        () => this.api.categories.getCategories(budgetId),
        'Get categories for bulk approve'
      );
      const categories = categoriesResponse.data.category_groups.flatMap(group => group.categories);

      // Filter transactions based on criteria
      const filteredTransactions = this.filterTransactions(allTransactions, accounts, categories, input.filters || {});

      // Filter to only unapproved transactions
      const allUnapprovedTransactions = filteredTransactions.filter(t => !t.approved);

      if (allUnapprovedTransactions.length === 0) {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `No unapproved transactions found matching the specified criteria. Total transactions checked: ${filteredTransactions.length}`,
            },
          ],
        };
      }

      // Apply pagination
      const limit = Math.min(input.limit || 50, 100);
      const offset = input.offset || 0;
      const total = allUnapprovedTransactions.length;
      const paginatedUnapprovedTransactions = allUnapprovedTransactions.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      const nextOffset = hasMore ? offset + limit : null;

      // Execute approval if not dry run (only on paginated results)
      let approvedTransactions: any[] = [];
      if (!input.dryRun) {
        approvedTransactions = await this.approveTransactions(budgetId, paginatedUnapprovedTransactions);
      }

      // Calculate totals
      const totalAmount = paginatedUnapprovedTransactions.reduce((sum, t) => sum + t.amount, 0);
      const totalCount = paginatedUnapprovedTransactions.length;

      const result = {
        budgetId: budgetId,
        totalTransactionsChecked: allTransactions.length,
        matchingTransactions: filteredTransactions.length,
        unapprovedTransactions: total,
        totalAmount: milliUnitsToAmount(totalAmount),
        filters: input.filters || {},
        transactions: optimizeTransactions(paginatedUnapprovedTransactions.map(t => ({
          ...t,
          account_name: accounts.find(a => a.id === t.account_id)?.name || "Unknown"
        })), { includeDetails: true }),
        approvedTransactions: approvedTransactions,
        dryRun: input.dryRun || false,
        pagination: {
          total,
          count: paginatedUnapprovedTransactions.length,
          offset,
          limit,
          has_more: hasMore,
          next_offset: nextOffset,
        },
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
      console.error(`Error bulk approving transactions:`, error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error bulk approving transactions: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: any): string {
    let output = `# Bulk Approve Transactions ${result.dryRun ? "(Dry Run)" : ""}\n\n`;
    output += `**Budget ID:** ${result.budgetId}\n\n`;
    output += `## Summary\n\n`;
    output += `- **Total Transactions Checked:** ${result.totalTransactionsChecked}\n`;
    output += `- **Matching Transactions:** ${result.matchingTransactions}\n`;
    output += `- **Unapproved Transactions (Total):** ${result.unapprovedTransactions}\n`;
    output += `- **Showing:** ${result.pagination.count} transactions (offset: ${result.pagination.offset}, limit: ${result.pagination.limit})\n`;
    output += `- **Total Amount (Current Page):** ${formatCurrency(result.totalAmount)}\n`;

    if (result.dryRun) {
      output += `\n*This was a dry run - no actual changes were made.*\n`;
    }

    if (Object.keys(result.filters).length > 0) {
      output += `\n## Filters Applied\n\n`;
      for (const [key, value] of Object.entries(result.filters)) {
        if (value !== undefined && value !== null) {
          output += `- **${key}:** ${value}\n`;
        }
      }
    }

    if (result.approvedTransactions && result.approvedTransactions.length > 0) {
      output += `\n## Approved Transactions\n\n`;
      for (const txn of result.approvedTransactions) {
        const statusIcon = txn.status === "success" ? "✅" : "❌";
        output += `${statusIcon} **${txn.payeeName || "Unknown"}** - ${formatCurrency(txn.amount)} on ${txn.date}\n`;
        if (txn.error) {
          output += `  - Error: ${txn.error}\n`;
        }
      }
    } else {
      output += `\n## Transactions to Approve\n\n`;
      const transactions = result.transactions || [];
      for (const txn of transactions.slice(0, 20)) { // Limit to 20 for readability
        output += `- **${txn.payee_name || "Unknown"}** - ${formatCurrency(milliUnitsToAmount(txn.amount))} on ${txn.date}\n`;
        if (txn.account_name) {
          output += `  - Account: ${txn.account_name}\n`;
        }
        if (txn.category_name) {
          output += `  - Category: ${txn.category_name}\n`;
        }
      }
      if (transactions.length > 20) {
        output += `\n*... and ${transactions.length - 20} more transactions*\n`;
      }
    }

    // Add pagination info
    output += "\n---\n\n";
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

  private filterTransactions(
    transactions: ynab.TransactionDetail[],
    accounts: ynab.Account[],
    categories: ynab.Category[],
    filters: NonNullable<BulkApproveTransactionsInput['filters']>
  ): ynab.TransactionDetail[] {
    return transactions.filter(transaction => {
      // Payee filter
      if (filters.payee) {
        const payeeName = transaction.payee_name?.toLowerCase() || "";
        if (!payeeName.includes(filters.payee.toLowerCase())) {
          return false;
        }
      }

      // Category filter
      if (filters.category) {
        const categoryName = transaction.category_name?.toLowerCase() || "";
        if (!categoryName.includes(filters.category.toLowerCase())) {
          return false;
        }
      }

      // Account filter
      if (filters.account) {
        const account = accounts.find(a => a.id === transaction.account_id);
        const accountName = account?.name?.toLowerCase() || "";
        if (!accountName.includes(filters.account.toLowerCase())) {
          return false;
        }
      }

      // Amount filters
      if (filters.minAmount !== undefined) {
        const minAmountMilliunits = amountToMilliUnits(filters.minAmount);
        if (transaction.amount < minAmountMilliunits) {
          return false;
        }
      }

      if (filters.maxAmount !== undefined) {
        const maxAmountMilliunits = amountToMilliUnits(filters.maxAmount);
        if (transaction.amount > maxAmountMilliunits) {
          return false;
        }
      }

      // Date filters
      if (filters.startDate) {
        if (transaction.date < filters.startDate) {
          return false;
        }
      }

      if (filters.endDate) {
        if (transaction.date > filters.endDate) {
          return false;
        }
      }

      // Memo filter
      if (filters.memo) {
        const memo = transaction.memo?.toLowerCase() || "";
        if (!memo.includes(filters.memo.toLowerCase())) {
          return false;
        }
      }

      return true;
    });
  }

  private async approveTransactions(
    budgetId: string,
    transactions: ynab.TransactionDetail[]
  ): Promise<any[]> {
    const approvedTransactions: any[] = [];

    for (const transaction of transactions) {
      try {
        console.log(`Approving transaction: ${transaction.payee_name} - ${formatCurrency(milliUnitsToAmount(transaction.amount))} on ${transaction.date}`);

        // Update transaction to approved
        const updateData: ynab.PutTransactionWrapper = {
          transaction: {
            account_id: transaction.account_id,
            date: transaction.date,
            amount: transaction.amount,
            payee_id: transaction.payee_id,
            payee_name: transaction.payee_name,
            category_id: transaction.category_id,
            memo: transaction.memo,
            cleared: transaction.cleared,
            approved: true,
            flag_color: transaction.flag_color,
            subtransactions: transaction.subtransactions
          }
        };

        await createRetryableAPICall(
          () => this.api.transactions.updateTransaction(budgetId, transaction.id, updateData),
          'Update transaction for bulk approve'
        );

        approvedTransactions.push({
          id: transaction.id,
          payeeName: transaction.payee_name,
          amount: milliUnitsToAmount(transaction.amount),
          date: transaction.date,
          status: "success"
        });

      } catch (error) {
        console.error(`Error approving transaction ${transaction.id}:`, error);
        approvedTransactions.push({
          id: transaction.id,
          payeeName: transaction.payee_name,
          amount: milliUnitsToAmount(transaction.amount),
          date: transaction.date,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return approvedTransactions;
  }
}

export default BulkApproveTransactionsTool;
