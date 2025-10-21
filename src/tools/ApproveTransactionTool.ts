import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface UpdateTransactionInput {
  budgetId?: string;
  transactionId: string;
  approved?: boolean;
  response_format?: "json" | "markdown";
}

class ApproveTransactionTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_approve_transaction",
      description: "Approves an existing transaction in your YNAB budget.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The id of the budget containing the transaction (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          transactionId: {
            type: "string",
            description: "The id of the transaction to approve",
          },
          approved: {
            type: "boolean",
            default: true,
            description: "Whether the transaction should be marked as approved",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
        },
        required: ["transactionId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Approve YNAB Transaction",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: UpdateTransactionInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      // First, get the existing transaction to ensure we don't lose any data
      const existingTransaction = await createRetryableAPICall(
        () => this.api.transactions.getTransactionById(budgetId, input.transactionId),
        'Get transaction by ID'
      );

      if (!existingTransaction.data.transaction) {
        throw new Error("Transaction not found");
      }

      const existingTransactionData = existingTransaction.data.transaction;

      // Create the full transaction payload with all existing data, only changing the approved status
      const transaction: ynab.PutTransactionWrapper = {
        transaction: {
          account_id: existingTransactionData.account_id,
          date: existingTransactionData.date,
          amount: existingTransactionData.amount,
          payee_id: existingTransactionData.payee_id,
          payee_name: existingTransactionData.payee_name,
          category_id: existingTransactionData.category_id,
          memo: existingTransactionData.memo,
          cleared: existingTransactionData.cleared,
          approved: input.approved !== undefined ? input.approved : true,
          flag_color: existingTransactionData.flag_color,
          subtransactions: existingTransactionData.subtransactions,
        }
      };

      const response = await createRetryableAPICall(
        () => this.api.transactions.updateTransaction(
          budgetId,
          existingTransactionData.id,
          transaction
        ),
        'Update transaction'
      );

      if (!response.data.transaction) {
        throw new Error("Failed to update transaction - no transaction data returned");
      }

      const result = {
        success: true,
        transactionId: response.data.transaction.id,
        message: "Transaction updated successfully",
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
        `Error updating transaction:`
      );
      console.error(JSON.stringify(error, null, 2));
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error updating transaction: ${
              error instanceof Error ? error.message : JSON.stringify(error)
            }`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: { success: boolean; transactionId: string; message: string }): string {
    let output = "# Transaction Updated Successfully\n\n";
    output += `${result.message}\n\n`;
    output += `**Transaction ID:** \`${result.transactionId}\`\n`;
    return output;
  }
}

export default ApproveTransactionTool;
