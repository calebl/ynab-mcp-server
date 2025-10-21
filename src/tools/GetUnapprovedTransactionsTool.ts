import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, milliUnitsToAmount, formatCurrency, formatDate } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface GetUnapprovedTransactionsInput {
  budgetId?: string;
  response_format?: "json" | "markdown";
  limit?: number;
  offset?: number;
}

class GetUnapprovedTransactionsTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_get_unapproved_transactions",
      description: "Gets unapproved transactions from a budget. First time pulls last 3 days, subsequent pulls use server knowledge to get only changes.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to fetch transactions for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
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
        title: "Get Unapproved YNAB Transactions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: GetUnapprovedTransactionsInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      console.error(`Getting unapproved transactions for budget ${budgetId}`);

      const response = await createRetryableAPICall(
        () => this.api.transactions.getTransactions(
          budgetId,
          undefined,
          ynab.GetTransactionsTypeEnum.Unapproved
        ),
        'Get unapproved transactions'
      );

      // Transform the transactions to a more readable format
      const allTransactions = this.transformTransactions(
        response.data.transactions
      );

      // Apply pagination
      const limit = Math.min(input.limit || 50, 100);
      const offset = input.offset || 0;
      const total = allTransactions.length;
      const paginatedTransactions = allTransactions.slice(offset, offset + limit);
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
      console.error(
        `Error getting unapproved transactions:`
      );
      console.error(JSON.stringify(error, null, 2));
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting unapproved transactions: ${
              error instanceof Error ? error.message : JSON.stringify(error)
            }`,
          },
        ],
      };
    }
  }

  private transformTransactions(transactions: ynab.TransactionDetail[]) {
    return transactions
      .filter((transaction) => !transaction.deleted)
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        amount: milliUnitsToAmount(transaction.amount),
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
  }

  private formatMarkdown(result: { transactions: any[]; transaction_count: number; pagination: any }): string {
    let output = "# Unapproved Transactions\n\n";
    output += `Found ${result.pagination.total} unapproved transaction(s) total\n`;
    output += `Showing ${result.transaction_count} transactions (offset: ${result.pagination.offset}, limit: ${result.pagination.limit})\n\n`;

    if (result.transaction_count === 0) {
      output += "No unapproved transactions found. Great job staying on top of your budget!\n";
      return output;
    }

    for (const txn of result.transactions) {
      output += `## ${txn.payee_name || "Unknown Payee"}\n`;
      output += `- **Date:** ${formatDate(txn.date)}\n`;
      output += `- **Amount:** ${formatCurrency(txn.amount)}\n`;
      output += `- **Account:** ${txn.account_name}\n`;
      if (txn.category_name) {
        output += `- **Category:** ${txn.category_name}\n`;
      }
      if (txn.memo) {
        output += `- **Memo:** ${txn.memo}\n`;
      }
      output += `- **Transaction ID:** \`${txn.id}\`\n`;
      output += "\n";
    }

    // Add pagination info
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

export default GetUnapprovedTransactionsTool;
