import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getBudgetId, amountToMilliUnits, truncateResponse, CHARACTER_LIMIT } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface CreateTransactionInput {
  budgetId?: string;
  accountId: string;
  date: string;
  amount: number;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  cleared?: boolean;
  approved?: boolean;
  flagColor?: string;
  response_format?: "json" | "markdown";
}

class CreateTransactionTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_create_transaction",
      description: "Creates a new transaction in your YNAB budget. Either payee_id or payee_name must be provided in addition to the other required fields.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The id of the budget to create the transaction in (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          accountId: {
            type: "string",
            description: "The id of the account to create the transaction in",
          },
          date: {
            type: "string",
            description: "The date of the transaction in ISO format (e.g. 2024-03-24)",
          },
          amount: {
            type: "number",
            description: "The amount in dollars (e.g. 10.99)",
          },
          payeeId: {
            type: "string",
            description: "The id of the payee (optional if payee_name is provided)",
          },
          payeeName: {
            type: "string",
            description: "The name of the payee (optional if payee_id is provided)",
          },
          categoryId: {
            type: "string",
            description: "The category id for the transaction (optional)",
          },
          memo: {
            type: "string",
            description: "A memo/note for the transaction (optional)",
          },
          cleared: {
            type: "boolean",
            description: "Whether the transaction is cleared (optional, defaults to false)",
          },
          approved: {
            type: "boolean",
            description: "Whether the transaction is approved (optional, defaults to false)",
          },
          flagColor: {
            type: "string",
            description: "The transaction flag color (red, orange, yellow, green, blue, purple) (optional)",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
        },
        required: ["accountId", "date", "amount"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create YNAB Transaction",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: CreateTransactionInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      if(!input.payeeId && !input.payeeName) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Either payee_id or payee_name must be provided",
            },
          ],
        };
      }

      const milliunitAmount = amountToMilliUnits(input.amount);

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

      const response = await createRetryableAPICall(
        () => this.api.transactions.createTransaction(budgetId, transaction),
        'Create transaction'
      );

      if (!response.data.transaction) {
        throw new Error("Failed to create transaction - no transaction data returned");
      }

      const result = {
        success: true,
        transactionId: response.data.transaction.id,
        message: "Transaction created successfully",
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
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error creating transaction: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: { success: boolean; transactionId: string; message: string }): string {
    let output = "# Transaction Created Successfully\n\n";
    output += `✅ ${result.message}\n\n`;
    output += `**Transaction ID:** \`${result.transactionId}\`\n`;
    return output;
  }
}

export default CreateTransactionTool;
