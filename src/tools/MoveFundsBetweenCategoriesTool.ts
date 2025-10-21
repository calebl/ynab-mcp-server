import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  truncateResponse,
  CHARACTER_LIMIT,
  getBudgetId,
  normalizeMonth,
  amountToMilliUnits,
  milliUnitsToAmount,
  formatCurrency,
} from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface MoveFundsBetweenCategoriesInput {
  budgetId?: string;
  month?: string;
  moves: Array<{
    fromCategoryId: string;
    toCategoryId: string;
    amount: number;
  }>;
  dryRun?: boolean;
  response_format?: "json" | "markdown";
}

interface MoveResult {
  fromCategoryId: string;
  fromCategoryName: string;
  toCategoryId: string;
  toCategoryName: string;
  amount: number;
  fromCategoryBalanceBefore: number;
  fromCategoryBalanceAfter: number;
  toCategoryBalanceBefore: number;
  toCategoryBalanceAfter: number;
  status: "success" | "failed" | "simulated";
  error?: string;
}

class MoveFundsBetweenCategoriesTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_move_funds_between_categories",
      description: "Transfer budgeted amounts between categories with validation. Supports multiple simultaneous moves in one operation.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to move funds in (optional, defaults to YNAB_BUDGET_ID environment variable)",
          },
          month: {
            type: "string",
            pattern: "^(current|\\d{4}-\\d{2}-\\d{2})$",
            default: "current",
            description: "The budget month to move funds for (e.g., 'current' or '2024-03-01')",
          },
          moves: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fromCategoryId: {
                  type: "string",
                  description: "The ID of the category to move funds from",
                },
                toCategoryId: {
                  type: "string",
                  description: "The ID of the category to move funds to",
                },
                amount: {
                  type: "number",
                  description: "The amount to move in dollars (e.g., 50.00). Use negative values to dip into previously saved funds (e.g., -100.00 to move $100 from accumulated savings).",
                },
              },
              required: ["fromCategoryId", "toCategoryId", "amount"],
              additionalProperties: false,
            },
            minItems: 1,
            description: "Array of fund moves to execute",
          },
          dryRun: {
            type: "boolean",
            default: false,
            description: "If true, will not make any actual changes, just return what would be moved",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
        },
        required: ["moves"],
        additionalProperties: false,
      },
      annotations: {
        title: "Move Funds Between YNAB Categories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: MoveFundsBetweenCategoriesInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      if (!input.moves || input.moves.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No moves specified. Please provide at least one move with fromCategoryId, toCategoryId, and amount.",
            },
          ],
        };
      }

      console.log(`Moving funds between categories for budget ${budgetId}, month ${input.month || "current"}`);

      // Get current month budget data
      const month = normalizeMonth(input.month);
      const monthResponse = await createRetryableAPICall(
        () => this.api.months.getBudgetMonth(budgetId, month),
        'Get budget month for move funds'
      );
      const monthData = monthResponse.data.month;
      
      // Get all categories for the month
      const categories = monthData.categories.filter(
        cat => !cat.deleted && !cat.hidden && cat.category_group_name !== "Internal Master Category"
      );

      // Validate moves and get current balances
      const validationResults = this.validateMoves(input.moves, categories);

      if (validationResults.invalidMoves.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Validation failed: ${validationResults.invalidMoves.join(", ")}`,
            },
          ],
        };
      }

      // Execute moves
      const moveResults: MoveResult[] = [];
      
      for (const move of input.moves) {
        const fromCategory = categories.find(cat => cat.id === move.fromCategoryId);
        const toCategory = categories.find(cat => cat.id === move.toCategoryId);
        
        if (!fromCategory || !toCategory) {
          moveResults.push({
            fromCategoryId: move.fromCategoryId,
            fromCategoryName: "Unknown",
            toCategoryId: move.toCategoryId,
            toCategoryName: "Unknown",
            amount: move.amount,
            fromCategoryBalanceBefore: 0,
            fromCategoryBalanceAfter: 0,
            toCategoryBalanceBefore: 0,
            toCategoryBalanceAfter: 0,
            status: "failed",
            error: "Category not found"
          });
          continue;
        }

        const amountMilliunits = amountToMilliUnits(Math.abs(move.amount));
        const fromBalanceBefore = fromCategory.budgeted;
        const toBalanceBefore = toCategory.budgeted;

        // For negative amounts, we're moving from accumulated savings (balance) to budgeted
        // For positive amounts, we're moving from budgeted to budgeted
        let fromBalanceAfter: number;
        let toBalanceAfter: number;

        if (move.amount < 0) {
          // Moving from accumulated savings: reduce budgeted amount (make it more negative)
          fromBalanceAfter = fromBalanceBefore - amountMilliunits;
          toBalanceAfter = toBalanceBefore + amountMilliunits;
        } else {
          // Moving from budgeted to budgeted
          fromBalanceAfter = fromBalanceBefore - amountMilliunits;
          toBalanceAfter = toBalanceBefore + amountMilliunits;
        }

        if (input.dryRun) {
          moveResults.push({
            fromCategoryId: move.fromCategoryId,
            fromCategoryName: fromCategory.name,
            toCategoryId: move.toCategoryId,
            toCategoryName: toCategory.name,
            amount: move.amount,
            fromCategoryBalanceBefore: milliUnitsToAmount(fromBalanceBefore),
            fromCategoryBalanceAfter: milliUnitsToAmount(fromBalanceAfter),
            toCategoryBalanceBefore: milliUnitsToAmount(toBalanceBefore),
            toCategoryBalanceAfter: milliUnitsToAmount(toBalanceAfter),
            status: "simulated"
          });
        } else {
          try {
            // Execute the move by updating both categories
            await this.executeMove(budgetId, month, move.fromCategoryId, move.toCategoryId, amountMilliunits);

            moveResults.push({
              fromCategoryId: move.fromCategoryId,
              fromCategoryName: fromCategory.name,
              toCategoryId: move.toCategoryId,
              toCategoryName: toCategory.name,
              amount: move.amount,
              fromCategoryBalanceBefore: milliUnitsToAmount(fromBalanceBefore),
              fromCategoryBalanceAfter: milliUnitsToAmount(fromBalanceAfter),
              toCategoryBalanceBefore: milliUnitsToAmount(toBalanceBefore),
              toCategoryBalanceAfter: milliUnitsToAmount(toBalanceAfter),
              status: "success"
            });
          } catch (error) {
            moveResults.push({
              fromCategoryId: move.fromCategoryId,
              fromCategoryName: fromCategory.name,
              toCategoryId: move.toCategoryId,
              toCategoryName: toCategory.name,
              amount: move.amount,
              fromCategoryBalanceBefore: milliUnitsToAmount(fromBalanceBefore),
              fromCategoryBalanceAfter: milliUnitsToAmount(fromBalanceBefore),
              toCategoryBalanceBefore: milliUnitsToAmount(toBalanceBefore),
              toCategoryBalanceAfter: milliUnitsToAmount(toBalanceBefore),
              status: "failed",
              error: error instanceof Error ? error.message : "Unknown error"
            });
          }
        }
      }

      // Calculate totals (use absolute values for total amount moved)
      const totalAmount = input.moves.reduce((sum, move) => sum + Math.abs(move.amount), 0);
      const successfulMoves = moveResults.filter(r => r.status === "success" || r.status === "simulated").length;
      const failedMoves = moveResults.filter(r => r.status === "failed").length;

      const result = {
        month: monthData.month,
        totalMoves: input.moves.length,
        successfulMoves: successfulMoves,
        failedMoves: failedMoves,
        totalAmount: totalAmount,
        dryRun: input.dryRun || false,
        moves: moveResults.map(move => ({
          fromCategory: move.fromCategoryName,
          toCategory: move.toCategoryName,
          amount: Math.abs(move.amount),
          fromBalanceBefore: move.fromCategoryBalanceBefore,
          fromBalanceAfter: move.fromCategoryBalanceAfter,
          toBalanceBefore: move.toCategoryBalanceBefore,
          toBalanceAfter: move.toCategoryBalanceAfter,
          status: move.status,
          error: move.error
        }))
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
      console.error(`Error moving funds between categories:`, error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error moving funds between categories: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: any): string {
    let output = `# Move Funds Between Categories ${result.dryRun ? "(Dry Run)" : ""}\n\n`;
    output += `**Month:** ${result.month}\n\n`;
    output += `## Summary\n\n`;
    output += `- **Total Moves:** ${result.totalMoves}\n`;
    output += `- **Successful:** ${result.successfulMoves}\n`;
    output += `- **Failed:** ${result.failedMoves}\n`;
    output += `- **Total Amount Moved:** ${formatCurrency(result.totalAmount)}\n`;

    if (result.dryRun) {
      output += `\n*This was a dry run - no actual changes were made.*\n`;
    }

    output += `\n## Moves\n\n`;

    for (const move of result.moves) {
      const statusIcon = move.status === "success" ? "✅" : move.status === "simulated" ? "🔍" : "❌";
      output += `### ${statusIcon} ${move.fromCategory} → ${move.toCategory}\n\n`;
      output += `- **Amount:** ${formatCurrency(move.amount)}\n`;
      output += `- **Status:** ${move.status}\n`;
      output += `- **From Category:**\n`;
      output += `  - Before: ${formatCurrency(move.fromBalanceBefore)}\n`;
      output += `  - After: ${formatCurrency(move.fromBalanceAfter)}\n`;
      output += `- **To Category:**\n`;
      output += `  - Before: ${formatCurrency(move.toBalanceBefore)}\n`;
      output += `  - After: ${formatCurrency(move.toBalanceAfter)}\n`;
      if (move.error) {
        output += `- **Error:** ${move.error}\n`;
      }
      output += `\n`;
    }

    return output;
  }

  private validateMoves(
    moves: Array<{ fromCategoryId: string; toCategoryId: string; amount: number }>,
    categories: ynab.Category[]
  ): { validMoves: any[]; invalidMoves: string[] } {
    const validMoves: any[] = [];
    const invalidMoves: string[] = [];

    for (const move of moves) {
      const fromCategory = categories.find(cat => cat.id === move.fromCategoryId);
      const toCategory = categories.find(cat => cat.id === move.toCategoryId);

      if (!fromCategory) {
        invalidMoves.push(`Source category ${move.fromCategoryId} not found`);
        continue;
      }

      if (!toCategory) {
        invalidMoves.push(`Target category ${move.toCategoryId} not found`);
        continue;
      }

      if (move.fromCategoryId === move.toCategoryId) {
        invalidMoves.push(`Cannot move funds from category to itself: ${fromCategory.name}`);
        continue;
      }

      if (move.amount === 0) {
        invalidMoves.push(`Amount must be non-zero: ${move.amount}`);
        continue;
      }

      const amountMilliunits = amountToMilliUnits(Math.abs(move.amount));
      const totalAvailable = fromCategory.budgeted + fromCategory.balance;

      if (totalAvailable < amountMilliunits) {
        invalidMoves.push(`Insufficient funds in ${fromCategory.name}: ${formatCurrency(milliUnitsToAmount(totalAvailable))} available (budgeted: ${formatCurrency(milliUnitsToAmount(fromCategory.budgeted))}, balance: ${formatCurrency(milliUnitsToAmount(fromCategory.balance))}), ${formatCurrency(Math.abs(move.amount))} requested`);
        continue;
      }

      validMoves.push(move);
    }

    return { validMoves, invalidMoves };
  }

  private async executeMove(
    budgetId: string,
    month: string,
    fromCategoryId: string,
    toCategoryId: string,
    amountMilliunits: number
  ): Promise<void> {
    console.log(`Moving ${formatCurrency(milliUnitsToAmount(amountMilliunits))} from category ${fromCategoryId} to ${toCategoryId} in month ${month}`);

    // Get current month data to get current budgeted amounts
    const monthResponse = await createRetryableAPICall(
      () => this.api.months.getBudgetMonth(budgetId, month),
      'Get budget month for execute move'
    );
    const monthData = monthResponse.data.month;

    const fromCategory = monthData.categories.find(cat => cat.id === fromCategoryId);
    const toCategory = monthData.categories.find(cat => cat.id === toCategoryId);

    if (!fromCategory || !toCategory) {
      throw new Error(`Category not found: ${!fromCategory ? fromCategoryId : toCategoryId}`);
    }

    // Calculate new budgeted amounts
    const fromNewBudgeted = fromCategory.budgeted - amountMilliunits;
    const toNewBudgeted = toCategory.budgeted + amountMilliunits;

    // Update the to category first (credit) to ensure atomicity
    // If this fails, no money is lost since source hasn't been debited yet
    const toUpdateData: ynab.PatchMonthCategoryWrapper = {
      category: {
        budgeted: toNewBudgeted
      }
    };

    await createRetryableAPICall(
      () => this.api.categories.updateMonthCategory(budgetId, month, toCategoryId, toUpdateData),
      'Update to category for move'
    );

    // Update the from category (debit) after successful credit
    const fromUpdateData: ynab.PatchMonthCategoryWrapper = {
      category: {
        budgeted: fromNewBudgeted
      }
    };

    await createRetryableAPICall(
      () => this.api.categories.updateMonthCategory(budgetId, month, fromCategoryId, fromUpdateData),
      'Update from category for move'
    );

    console.log(`Successfully moved ${formatCurrency(milliUnitsToAmount(amountMilliunits))} from ${fromCategory.name} to ${toCategory.name}`);
  }
}

export default MoveFundsBetweenCategoriesTool;
