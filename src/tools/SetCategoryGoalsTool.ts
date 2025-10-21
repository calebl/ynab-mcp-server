import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handleAPIError, createRetryableAPICall } from "../utils/apiErrorHandler.js";
import {
  truncateResponse,
  CHARACTER_LIMIT,
  getBudgetId,
  amountToMilliUnits,
  milliUnitsToAmount,
  formatCurrency
} from "../utils/commonUtils.js";

interface SetCategoryGoalsInput {
  budgetId?: string;
  categoryId?: string;
  categoryName?: string;
  goalType?: 'TB' | 'TBD' | 'MF' | 'NEED' | 'DEBT';
  goalTarget?: number; // Amount in dollars
  goalTargetDate?: string; // YYYY-MM-DD format for TBD goals
  goalTargetMonth?: string; // YYYY-MM-DD format for TBD goals
  note?: string;
  dryRun?: boolean;
  response_format?: "json" | "markdown";
}

interface GoalUpdateResult {
  category_id: string;
  category_name: string;
  goal_type: string | null;
  goal_target: number | null;
  goal_target_dollars: number | null;
  goal_target_month: string | null;
  success: boolean;
  message: string;
  changes_made: string[];
}

interface SetCategoryGoalsResult {
  budget_id: string;
  updates_performed: number;
  results: GoalUpdateResult[];
  goal_types_info: {
    TB: string;
    TBD: string;
    MF: string;
    NEED: string;
    DEBT: string;
  };
  note: string;
}

export default class SetCategoryGoalsTool {
  private api: ynab.API;
  private budgetId?: string;

  constructor(budgetId?: string, ynabApi?: ynab.API) {
    this.api = ynabApi || new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = budgetId || process.env.YNAB_BUDGET_ID;
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_set_category_goals",
      description: "Create or update category goals in YNAB. Supports updating goal targets and target dates for existing goals. Note: Creating new goals requires the YNAB web interface - this tool can only update existing goal targets.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to update (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          categoryId: {
            type: "string",
            description: "The ID of the category to update (optional if categoryName is provided)",
          },
          categoryName: {
            type: "string",
            description: "The name of the category to update (optional if categoryId is provided). Supports partial matching.",
          },
          goalType: {
            type: "string",
            enum: ["TB", "TBD", "MF", "NEED", "DEBT"],
            description: "The type of goal to set. TB=Target Balance, TBD=Target Balance by Date, MF=Monthly Funding, NEED=Plan Your Spending, DEBT=Debt Payment",
          },
          goalTarget: {
            type: "number",
            description: "The goal target amount in dollars (e.g., 1000.00)",
          },
          goalTargetDate: {
            type: "string",
            description: "The target date for TBD goals in YYYY-MM-DD format (e.g., '2024-12-31')",
          },
          goalTargetMonth: {
            type: "string",
            description: "The target month for TBD goals in YYYY-MM-DD format (e.g., '2024-12-01')",
          },
          note: {
            type: "string",
            description: "Optional note to add to the category",
          },
          dryRun: {
            type: "boolean",
            description: "If true, will show what would be updated without making changes",
            default: false,
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        title: "Set Category Goals",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: SetCategoryGoalsInput): Promise<{ content: Array<{ type: string; text: string }>, isError?: boolean }> {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      // Get all categories
      const categoriesResponse = await this.api.categories.getCategories(budgetId);
      const allCategories = categoriesResponse.data.category_groups
        .flatMap((group: any) => group.categories)
        .filter((category: any) => !category.deleted && !category.hidden);

      // Find the target category
      let targetCategory: any = null;
      if (input.categoryId) {
        targetCategory = allCategories.find((cat: any) => cat.id === input.categoryId);
      } else if (input.categoryName) {
        // Try exact match first
        targetCategory = allCategories.find((cat: any) => 
          cat.name.toLowerCase() === input.categoryName!.toLowerCase()
        );
        // If no exact match, try partial match
        if (!targetCategory) {
          targetCategory = allCategories.find((cat: any) => 
            cat.name.toLowerCase().includes(input.categoryName!.toLowerCase())
          );
        }
      }

      if (!targetCategory) {
        throw new Error(`Category not found. Please provide a valid categoryId or categoryName. Use the budget_summary tool to see available categories.`);
      }

      const results: GoalUpdateResult[] = [];
      const changesMade: string[] = [];

      // Check if category already has a goal
      if (!targetCategory.goal_type) {
        results.push({
          category_id: targetCategory.id,
          category_name: targetCategory.name,
          goal_type: null,
          goal_target: null,
          goal_target_dollars: null,
          goal_target_month: null,
          success: false,
          message: "Category does not have a goal set. Creating new goals requires the YNAB web interface. This tool can only update existing goal targets.",
          changes_made: [],
        });
      } else {
        // Category has a goal, we can update the target
        const currentGoalTarget = targetCategory.goal_target || 0;
        const currentGoalTargetDollars = milliUnitsToAmount(currentGoalTarget);
        const currentGoalTargetMonth = targetCategory.goal_target_month;

        let newGoalTarget = currentGoalTarget;
        let newGoalTargetMonth = currentGoalTargetMonth;
        let hasChanges = false;

        // Update goal target if provided
        if (input.goalTarget !== undefined) {
          const newTargetMilliunits = amountToMilliUnits(input.goalTarget);
          if (newTargetMilliunits !== currentGoalTarget) {
            newGoalTarget = newTargetMilliunits;
            hasChanges = true;
            changesMade.push(`Goal target: ${formatCurrency(currentGoalTargetDollars)} → ${formatCurrency(input.goalTarget)}`);
          }
        }

        // Update goal target date/month if provided (for TBD goals)
        if ((input.goalTargetDate || input.goalTargetMonth) && targetCategory.goal_type === 'TBD') {
          const newTargetMonth = input.goalTargetMonth || (input.goalTargetDate ? input.goalTargetDate.substring(0, 7) + '-01' : null);
          if (newTargetMonth && newTargetMonth !== currentGoalTargetMonth) {
            newGoalTargetMonth = newTargetMonth;
            hasChanges = true;
            changesMade.push(`Goal target date: ${currentGoalTargetMonth || 'Not set'} → ${newTargetMonth}`);
          }
        }

        if (!hasChanges) {
          results.push({
            category_id: targetCategory.id,
            category_name: targetCategory.name,
            goal_type: targetCategory.goal_type,
            goal_target: currentGoalTarget,
            goal_target_dollars: currentGoalTargetDollars,
            goal_target_month: currentGoalTargetMonth,
            success: true,
            message: "No changes needed - goal is already set to the specified values",
            changes_made: [],
          });
        } else {
          if (input.dryRun) {
            results.push({
              category_id: targetCategory.id,
              category_name: targetCategory.name,
              goal_type: targetCategory.goal_type,
              goal_target: newGoalTarget,
              goal_target_dollars: milliUnitsToAmount(newGoalTarget),
              goal_target_month: newGoalTargetMonth,
              success: true,
              message: `Would update goal: ${changesMade.join(', ')}`,
              changes_made: changesMade,
            });
          } else {
            // Perform the update
            const updateData: ynab.PatchCategoryWrapper = {
              category: {
                goal_target: newGoalTarget,
                note: input.note || targetCategory.note,
              }
            };

            await this.api.categories.updateCategory(budgetId, targetCategory.id, updateData);

            results.push({
              category_id: targetCategory.id,
              category_name: targetCategory.name,
              goal_type: targetCategory.goal_type,
              goal_target: newGoalTarget,
              goal_target_dollars: milliUnitsToAmount(newGoalTarget),
              goal_target_month: newGoalTargetMonth,
              success: true,
              message: `Successfully updated goal: ${changesMade.join(', ')}`,
              changes_made: changesMade,
            });
          }
        }
      }

      const result: SetCategoryGoalsResult = {
        budget_id: budgetId,
        updates_performed: results.filter(r => r.success && r.changes_made.length > 0).length,
        results: results,
        goal_types_info: {
          TB: "Target Balance - Save a specific amount",
          TBD: "Target Balance by Date - Save a specific amount by a specific date",
          MF: "Monthly Funding - Set aside a specific amount each month",
          NEED: "Plan Your Spending - Set aside money for planned spending",
          DEBT: "Debt Payment - Pay off debt by a specific date",
        },
        note: "All amounts are in dollars. Creating new goals requires the YNAB web interface. This tool can only update existing goal targets and dates.",
      };

      const format = input.response_format || "markdown";
      let responseText: string;

      if (format === "json") {
        responseText = JSON.stringify(result, null, 2);
      } else {
        responseText = this.formatMarkdown(result);
      }

      const { text, wasTruncated } = truncateResponse(responseText, CHARACTER_LIMIT);

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to set category goals: ${errorMessage}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: SetCategoryGoalsResult): string {
    let output = `# Set Category Goals\n\n`;

    output += `## Summary\n`;
    output += `- **Budget ID**: ${result.budget_id}\n`;
    output += `- **Updates Performed**: ${result.updates_performed}\n\n`;

    if (result.results.length > 0) {
      output += `## Results\n\n`;

      for (const res of result.results) {
        output += `### ${res.category_name}\n`;
        output += `- **Category ID**: ${res.category_id}\n`;
        output += `- **Goal Type**: ${res.goal_type || 'None'}\n`;

        if (res.goal_target !== null) {
          output += `- **Goal Target**: ${formatCurrency(res.goal_target_dollars!)}\n`;
        }

        if (res.goal_target_month) {
          output += `- **Target Month**: ${res.goal_target_month}\n`;
        }

        output += `- **Success**: ${res.success ? 'Yes' : 'No'}\n`;
        output += `- **Message**: ${res.message}\n`;

        if (res.changes_made.length > 0) {
          output += `- **Changes Made**:\n`;
          for (const change of res.changes_made) {
            output += `  - ${change}\n`;
          }
        }
        output += "\n";
      }
    }

    output += `## Goal Types Reference\n\n`;
    for (const [key, value] of Object.entries(result.goal_types_info)) {
      output += `- **${key}**: ${value}\n`;
    }
    output += "\n";

    output += `---\n\n`;
    output += `${result.note}\n`;

    return output;
  }
}
