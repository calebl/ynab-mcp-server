import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeMonth,
  getBudgetId,
  milliUnitsToAmount,
  amountToMilliUnits,
  truncateResponse,
  CHARACTER_LIMIT,
  formatCurrency,
  formatDate
} from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface HandleOverspendingInput {
  budgetId?: string;
  month?: string;
  strategy?: "auto" | "suggest";
  sourceCategories?: string[];
  targetCategories?: string[];
  dryRun?: boolean;
  response_format?: "json" | "markdown";
}

interface MoveSuggestion {
  fromCategoryId: string;
  fromCategoryName: string;
  toCategoryId: string;
  toCategoryName: string;
  amount: number;
  reason: string;
}

class HandleOverspendingTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_handle_overspending",
      description: "Automatically resolve overspent categories by moving funds from available sources. Credit card payment categories are excluded as funding sources since they are needed to pay CC bills. Supports both automatic execution and suggestion mode.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to handle overspending for (optional, defaults to YNAB_BUDGET_ID environment variable)",
          },
          month: {
            type: "string",
            pattern: "^(current|\\d{4}-\\d{2}-\\d{2})$",
            default: "current",
            description: "The budget month to check for overspending (e.g., 'current' or '2024-03-01')",
          },
          strategy: {
            type: "string",
            enum: ["auto", "suggest"],
            default: "suggest",
            description: "Whether to automatically execute moves ('auto') or just suggest them ('suggest')",
          },
          sourceCategories: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of category IDs to use as funding sources (if not provided, will find available categories automatically)",
          },
          targetCategories: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of category IDs to fix overspending for (if not provided, will fix all overspent categories)",
          },
          dryRun: {
            type: "boolean",
            default: false,
            description: "If true, will not make any actual changes, just return what would be done",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Handle Overspending in YNAB Budget",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: HandleOverspendingInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      const month = normalizeMonth(input.month);

      console.log(`Handling overspending for budget ${budgetId}, month ${month}`);

      // Get current month budget data
      const monthResponse = await createRetryableAPICall(
        () => this.api.months.getBudgetMonth(budgetId, month),
        'Get budget month for overspending'
      );
      const monthData = monthResponse.data.month;
      
      // Get all categories for the month
      const categories = monthData.categories.filter(
        cat => !cat.deleted && !cat.hidden && cat.category_group_name !== "Internal Master Category"
      );

      // Find overspent categories (negative balance)
      const overspentCategories = categories.filter(cat => cat.balance < 0);
      
      if (overspentCategories.length === 0) {
        const message = "No overspent categories found for this month. Great job!";
        return {
          content: [
            {
              type: "text",
              text: input.response_format === "json" ? JSON.stringify({ message, overspentCategories: [] }, null, 2) : message,
            },
          ],
        };
      }

      // Find categories with positive balances that can contribute funds
      // Exclude credit card payment categories as they are needed to pay CC bills
      // Credit card payment categories typically have names starting with "💳" or containing "CC" or "Card"
      const availableCategories = categories.filter(cat => 
        cat.balance > 0 && 
        (!input.sourceCategories || input.sourceCategories.includes(cat.id)) &&
        cat.category_group_name !== "Internal Master Category" &&
        !cat.name.includes("💳") && 
        !cat.name.includes("CC") && 
        !cat.name.includes("Card")
      );

      if (availableCategories.length === 0) {
        const message = "No categories with available funds found to cover overspending. Credit card payment categories are excluded as they are needed to pay CC bills. Consider adding money to 'Ready to Assign' or adjusting your budget.";
        return {
          content: [
            {
              type: "text",
              text: input.response_format === "json" ? JSON.stringify({ message, availableCategories: [] }, null, 2) : message,
            },
          ],
        };
      }

      // Generate move suggestions
      const suggestions = this.generateMoveSuggestions(overspentCategories, availableCategories, input.targetCategories);
      
      if (suggestions.length === 0) {
        const message = "No suitable funding sources found for the overspent categories.";
        return {
          content: [
            {
              type: "text",
              text: input.response_format === "json" ? JSON.stringify({ message, suggestions: [] }, null, 2) : message,
            },
          ],
        };
      }

      // Execute moves if strategy is 'auto' and not dry run
      let executedMoves: any[] = [];
      if (input.strategy === "auto" && !input.dryRun) {
        executedMoves = await this.executeMoves(budgetId, month, suggestions);
      }

      // Format response
      const result = {
        month: monthData.month,
        overspentCategories: overspentCategories.map(cat => ({
          id: cat.id,
          name: cat.name,
          balance: milliUnitsToAmount(cat.balance),
          categoryGroup: cat.category_group_name
        })),
        availableFunding: availableCategories.map(cat => ({
          id: cat.id,
          name: cat.name,
          balance: milliUnitsToAmount(cat.balance),
          categoryGroup: cat.category_group_name
        })),
        suggestions: suggestions.map(s => ({
          fromCategory: s.fromCategoryName,
          toCategory: s.toCategoryName,
          amount: milliUnitsToAmount(s.amount),
          reason: s.reason
        })),
        executedMoves: executedMoves,
        strategy: input.strategy,
        dryRun: input.dryRun || false
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
      console.error(`Error handling overspending:`, error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error handling overspending: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: any): string {
    let output = "# Handle Overspending Report\n\n";
    output += `**Month:** ${formatDate(result.month)}\n`;
    output += `**Strategy:** ${result.strategy}\n`;
    output += `**Dry Run:** ${result.dryRun ? "Yes" : "No"}\n\n`;

    // Overspent Categories
    output += "## Overspent Categories\n\n";
    if (result.overspentCategories.length === 0) {
      output += "No overspent categories found. Great job!\n\n";
    } else {
      output += `Found ${result.overspentCategories.length} overspent categories:\n\n`;
      for (const cat of result.overspentCategories) {
        output += `- **${cat.name}** (${cat.categoryGroup}): ${formatCurrency(cat.balance)}\n`;
      }
      output += "\n";
    }

    // Available Funding
    output += "## Available Funding Sources\n\n";
    if (result.availableFunding.length === 0) {
      output += "No categories with available funds found.\n\n";
    } else {
      output += `Found ${result.availableFunding.length} categories with available funds:\n\n`;
      for (const cat of result.availableFunding) {
        output += `- **${cat.name}** (${cat.categoryGroup}): ${formatCurrency(cat.balance)}\n`;
      }
      output += "\n";
    }

    // Suggestions
    output += "## Suggested Moves\n\n";
    if (result.suggestions.length === 0) {
      output += "No moves suggested.\n\n";
    } else {
      output += `${result.suggestions.length} move(s) suggested:\n\n`;
      for (const suggestion of result.suggestions) {
        output += `### ${formatCurrency(suggestion.amount)}\n`;
        output += `- **From:** ${suggestion.fromCategory}\n`;
        output += `- **To:** ${suggestion.toCategory}\n`;
        output += `- **Reason:** ${suggestion.reason}\n\n`;
      }
    }

    // Executed Moves
    if (result.executedMoves && result.executedMoves.length > 0) {
      output += "## Executed Moves\n\n";
      for (const move of result.executedMoves) {
        output += `### ${formatCurrency(move.amount)}\n`;
        output += `- **From:** ${move.fromCategory}\n`;
        output += `- **To:** ${move.toCategory}\n`;
        output += `- **Status:** ${move.status}\n`;
        if (move.error) {
          output += `- **Error:** ${move.error}\n`;
        }
        output += "\n";
      }
    }

    return output;
  }

  private generateMoveSuggestions(
    overspentCategories: ynab.Category[],
    availableCategories: ynab.Category[],
    targetCategories?: string[]
  ): MoveSuggestion[] {
    const suggestions: MoveSuggestion[] = [];
    const filteredOverspent = targetCategories 
      ? overspentCategories.filter(cat => targetCategories.includes(cat.id))
      : overspentCategories;

    for (const overspent of filteredOverspent) {
      const neededAmount = Math.abs(overspent.balance);
      let remainingNeeded = neededAmount;

      // Sort available categories by balance (highest first) for efficient allocation
      const sortedAvailable = [...availableCategories].sort((a, b) => b.balance - a.balance);

      for (const available of sortedAvailable) {
        if (remainingNeeded <= 0) break;
        if (available.balance <= 0) continue;

        const moveAmount = Math.min(available.balance, remainingNeeded);
        
        suggestions.push({
          fromCategoryId: available.id,
          fromCategoryName: available.name,
          toCategoryId: overspent.id,
          toCategoryName: overspent.name,
          amount: moveAmount,
          reason: `Cover overspending in ${overspent.name} (${overspent.category_group_name})`
        });

        remainingNeeded -= moveAmount;
      }
    }

    return suggestions;
  }

  private async executeMoves(budgetId: string, month: string, suggestions: MoveSuggestion[]): Promise<any[]> {
    const executedMoves: any[] = [];

    for (const suggestion of suggestions) {
      try {
        console.log(`Executing move: ${suggestion.fromCategoryName} -> ${suggestion.toCategoryName} (${formatCurrency(milliUnitsToAmount(suggestion.amount))})`);

        // Get current month data to get current budgeted amounts
        const monthResponse = await createRetryableAPICall(
          () => this.api.months.getBudgetMonth(budgetId, month),
          'Get budget month for move execution'
        );
        const monthData = monthResponse.data.month;
        
        const fromCategory = monthData.categories.find(cat => cat.id === suggestion.fromCategoryId);
        const toCategory = monthData.categories.find(cat => cat.id === suggestion.toCategoryId);
        
        if (!fromCategory || !toCategory) {
          throw new Error(`Category not found: ${!fromCategory ? suggestion.fromCategoryId : suggestion.toCategoryId}`);
        }
        
        // Calculate new budgeted amounts
        const fromNewBudgeted = fromCategory.budgeted - suggestion.amount;
        const toNewBudgeted = toCategory.budgeted + suggestion.amount;
        
        // Update the to category first (credit) to ensure atomicity
        // If this fails, no money is lost since source hasn't been debited yet
        const toUpdateData: ynab.PatchMonthCategoryWrapper = {
          category: {
            budgeted: toNewBudgeted
          }
        };

        await createRetryableAPICall(
          () => this.api.categories.updateMonthCategory(budgetId, month, suggestion.toCategoryId, toUpdateData),
          'Update to category'
        );

        // Update the from category (debit) after successful credit
        const fromUpdateData: ynab.PatchMonthCategoryWrapper = {
          category: {
            budgeted: fromNewBudgeted
          }
        };

        await createRetryableAPICall(
          () => this.api.categories.updateMonthCategory(budgetId, month, suggestion.fromCategoryId, fromUpdateData),
          'Update from category'
        );
        
        executedMoves.push({
          fromCategory: suggestion.fromCategoryName,
          toCategory: suggestion.toCategoryName,
          amount: milliUnitsToAmount(suggestion.amount),
          status: "success"
        });

      } catch (error) {
        console.error(`Error executing move for ${suggestion.fromCategoryName} -> ${suggestion.toCategoryName}:`, error);
        executedMoves.push({
          fromCategory: suggestion.fromCategoryName,
          toCategory: suggestion.toCategoryName,
          amount: milliUnitsToAmount(suggestion.amount),
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return executedMoves;
  }
}

export default HandleOverspendingTool;
