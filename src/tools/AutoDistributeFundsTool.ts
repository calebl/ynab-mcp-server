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

interface AutoDistributeFundsInput {
  budgetId?: string;
  month?: string;
  strategy?: "goals-first" | "proportional" | "custom";
  maxAmount?: number;
  dryRun?: boolean;
  response_format?: "json" | "markdown";
}

interface DistributionPlan {
  categoryId: string;
  categoryName: string;
  categoryGroup: string;
  currentBudgeted: number;
  proposedAmount: number;
  reason: string;
  goalType?: string;
  goalTarget?: number;
  goalUnderFunded?: number;
}

class AutoDistributeFundsTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_auto_distribute_funds",
      description: "Intelligently allocate 'Ready to Assign' money based on category goals and priorities. Supports multiple distribution strategies.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to distribute funds for (optional, defaults to YNAB_BUDGET_ID environment variable)",
          },
          month: {
            type: "string",
            pattern: "^(current|\\d{4}-\\d{2}-\\d{2})$",
            default: "current",
            description: "The budget month to distribute funds for (e.g., 'current' or '2024-03-01')",
          },
          strategy: {
            type: "string",
            enum: ["goals-first", "proportional", "custom"],
            default: "goals-first",
            description: "Distribution strategy: 'goals-first' prioritizes underfunded goals, 'proportional' distributes evenly, 'custom' uses advanced logic",
          },
          maxAmount: {
            type: "number",
            description: "Maximum amount to distribute (optional, defaults to all available 'Ready to Assign' money)",
          },
          dryRun: {
            type: "boolean",
            default: false,
            description: "If true, will not make any actual changes, just return the distribution plan",
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
        title: "Auto Distribute Funds in YNAB Budget",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: AutoDistributeFundsInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      const month = normalizeMonth(input.month);

      console.log(`Auto-distributing funds for budget ${budgetId}, month ${month}`);

      // Get current month budget data
      const monthResponse = await createRetryableAPICall(
        () => this.api.months.getBudgetMonth(budgetId, month),
        'Get budget month for auto distribute'
      );
      const monthData = monthResponse.data.month;
      
      // Check available funds
      const availableFunds = monthData.to_be_budgeted;
      const maxAmount = input.maxAmount ? amountToMilliUnits(input.maxAmount) : availableFunds;
      const amountToDistribute = Math.min(availableFunds, maxAmount);

      if (amountToDistribute <= 0) {
        const message = `No funds available to distribute. Ready to Assign: ${formatCurrency(milliUnitsToAmount(availableFunds))}`;
        return {
          content: [
            {
              type: "text",
              text: input.response_format === "json" ? JSON.stringify({ message, availableFunds: milliUnitsToAmount(availableFunds) }, null, 2) : message,
            },
          ],
        };
      }

      // Get all categories for the month
      const categories = monthData.categories.filter(
        cat => !cat.deleted && !cat.hidden && cat.category_group_name !== "Internal Master Category"
      );

      // Generate distribution plan based on strategy
      const distributionPlan = this.generateDistributionPlan(
        categories, 
        amountToDistribute, 
        input.strategy || "goals-first"
      );

      if (distributionPlan.length === 0) {
        const message = "No suitable categories found for fund distribution.";
        return {
          content: [
            {
              type: "text",
              text: input.response_format === "json" ? JSON.stringify({ message, distributionPlan: [] }, null, 2) : message,
            },
          ],
        };
      }

      // Execute distribution if not dry run
      let executedDistributions: any[] = [];
      if (!input.dryRun) {
        executedDistributions = await this.executeDistribution(budgetId, month, distributionPlan);
      }

      // Calculate totals
      const totalDistributed = distributionPlan.reduce((sum, item) => sum + item.proposedAmount, 0);
      const remainingFunds = amountToDistribute - totalDistributed;

      const result = {
        month: monthData.month,
        availableFunds: milliUnitsToAmount(availableFunds),
        amountToDistribute: milliUnitsToAmount(amountToDistribute),
        totalDistributed: milliUnitsToAmount(totalDistributed),
        remainingFunds: milliUnitsToAmount(remainingFunds),
        strategy: input.strategy,
        distributionPlan: distributionPlan.map(item => ({
          category: item.categoryName,
          categoryGroup: item.categoryGroup,
          currentBudgeted: milliUnitsToAmount(item.currentBudgeted),
          proposedAmount: milliUnitsToAmount(item.proposedAmount),
          reason: item.reason,
          goalType: item.goalType,
          goalTarget: item.goalTarget ? milliUnitsToAmount(item.goalTarget) : null,
          goalUnderFunded: item.goalUnderFunded ? milliUnitsToAmount(item.goalUnderFunded) : null
        })),
        executedDistributions: executedDistributions,
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
      console.error(`Error auto-distributing funds:`, error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error auto-distributing funds: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: any): string {
    let output = "# Auto Distribute Funds Report\n\n";
    output += `**Month:** ${formatDate(result.month)}\n`;
    output += `**Strategy:** ${result.strategy}\n`;
    output += `**Dry Run:** ${result.dryRun ? "Yes" : "No"}\n\n`;

    // Summary
    output += "## Summary\n\n";
    output += `- **Available Funds:** ${formatCurrency(result.availableFunds)}\n`;
    output += `- **Amount to Distribute:** ${formatCurrency(result.amountToDistribute)}\n`;
    output += `- **Total Distributed:** ${formatCurrency(result.totalDistributed)}\n`;
    output += `- **Remaining Funds:** ${formatCurrency(result.remainingFunds)}\n\n`;

    // Distribution Plan
    output += "## Distribution Plan\n\n";
    if (result.distributionPlan.length === 0) {
      output += "No categories eligible for distribution.\n\n";
    } else {
      output += `Planning to distribute to ${result.distributionPlan.length} categories:\n\n`;
      for (const item of result.distributionPlan) {
        output += `### ${item.category} (${item.categoryGroup})\n`;
        output += `- **Current Budgeted:** ${formatCurrency(item.currentBudgeted)}\n`;
        output += `- **Proposed Amount:** ${formatCurrency(item.proposedAmount)}\n`;
        output += `- **Reason:** ${item.reason}\n`;
        if (item.goalType) {
          output += `- **Goal Type:** ${item.goalType}\n`;
          if (item.goalTarget) {
            output += `- **Goal Target:** ${formatCurrency(item.goalTarget)}\n`;
          }
          if (item.goalUnderFunded) {
            output += `- **Goal Under Funded:** ${formatCurrency(item.goalUnderFunded)}\n`;
          }
        }
        output += "\n";
      }
    }

    // Executed Distributions
    if (result.executedDistributions && result.executedDistributions.length > 0) {
      output += "## Executed Distributions\n\n";
      for (const dist of result.executedDistributions) {
        output += `### ${dist.category}\n`;
        output += `- **Amount:** ${formatCurrency(dist.amount)}\n`;
        output += `- **Reason:** ${dist.reason}\n`;
        output += `- **Status:** ${dist.status}\n`;
        if (dist.error) {
          output += `- **Error:** ${dist.error}\n`;
        }
        output += "\n";
      }
    }

    return output;
  }

  private generateDistributionPlan(
    categories: ynab.Category[],
    amountToDistribute: number,
    strategy: string
  ): DistributionPlan[] {
    const plan: DistributionPlan[] = [];
    let remainingAmount = amountToDistribute;

    if (strategy === "goals-first") {
      // Prioritize categories with underfunded goals
      const goalCategories = categories.filter(cat => 
        cat.goal_type && 
        cat.goal_under_funded && 
        cat.goal_under_funded > 0
      ).sort((a, b) => {
        // Sort by goal urgency (TBD > TB > MF > NEED)
        const goalPriority = { "TBD": 4, "TB": 3, "MF": 2, "NEED": 1 };
        const aPriority = goalPriority[a.goal_type as keyof typeof goalPriority] || 0;
        const bPriority = goalPriority[b.goal_type as keyof typeof goalPriority] || 0;
        return bPriority - aPriority;
      });

      for (const category of goalCategories) {
        if (remainingAmount <= 0) break;
        
        const amount = Math.min(category.goal_under_funded!, remainingAmount);
        plan.push({
          categoryId: category.id,
          categoryName: category.name,
          categoryGroup: category.category_group_name || "Unknown",
          currentBudgeted: category.budgeted,
          proposedAmount: amount,
          reason: `Fund ${category.goal_type} goal (${category.goal_type === "TBD" ? "Target by Date" : 
                   category.goal_type === "TB" ? "Target Balance" :
                   category.goal_type === "MF" ? "Monthly Funding" : "Plan Your Spending"})`,
          goalType: category.goal_type || undefined,
          goalTarget: category.goal_target || undefined,
          goalUnderFunded: category.goal_under_funded || undefined
        });
        remainingAmount -= amount;
      }
    } else if (strategy === "proportional") {
      // Distribute proportionally based on current budgeted amounts
      const totalBudgeted = categories.reduce((sum, cat) => sum + Math.max(0, cat.budgeted), 0);
      
      if (totalBudgeted > 0) {
        for (const category of categories) {
          if (remainingAmount <= 0) break;
          if (category.budgeted <= 0) continue;
          
          const proportion = category.budgeted / totalBudgeted;
          const amount = Math.round(amountToDistribute * proportion);
          const actualAmount = Math.min(amount, remainingAmount);
          
          if (actualAmount > 0) {
            plan.push({
              categoryId: category.id,
              categoryName: category.name,
              categoryGroup: category.category_group_name || "Unknown",
              currentBudgeted: category.budgeted,
              proposedAmount: actualAmount,
              reason: `Proportional distribution based on current budgeted amount`
            });
            remainingAmount -= actualAmount;
          }
        }
      }
    } else if (strategy === "custom") {
      // Custom strategy: prioritize by category group and goal status
      const categoryGroups = [
        "Credit Card Payments",
        "Operating Expenses", 
        "COGS",
        "Accounts Payable",
        "Other"
      ];

      for (const groupName of categoryGroups) {
        if (remainingAmount <= 0) break;
        
        const groupCategories = categories.filter(cat => cat.category_group_name === groupName);
        
        // Within each group, prioritize by goals first, then by current budgeted amount
        const sortedGroup = groupCategories.sort((a, b) => {
          // Goals first
          if (a.goal_type && !b.goal_type) return -1;
          if (!a.goal_type && b.goal_type) return 1;
          
          // Then by budgeted amount
          return b.budgeted - a.budgeted;
        });

        for (const category of sortedGroup) {
          if (remainingAmount <= 0) break;
          
          let amount = 0;
          let reason = "";
          
          if (category.goal_type && category.goal_under_funded && category.goal_under_funded > 0) {
            amount = Math.min(category.goal_under_funded, remainingAmount);
            reason = `Fund ${category.goal_type} goal in ${groupName}`;
          } else if (category.budgeted > 0) {
            amount = Math.min(category.budgeted * 0.1, remainingAmount); // 10% of current budget
            reason = `Top up existing budget in ${groupName}`;
          } else {
            amount = Math.min(100000, remainingAmount); // $100 default
            reason = `Initial funding for ${groupName}`;
          }
          
          if (amount > 0) {
            plan.push({
              categoryId: category.id,
              categoryName: category.name,
              categoryGroup: category.category_group_name || "Unknown",
              currentBudgeted: category.budgeted,
              proposedAmount: amount,
              reason: reason,
              goalType: category.goal_type || undefined,
              goalTarget: category.goal_target || undefined,
              goalUnderFunded: category.goal_under_funded || undefined
            });
            remainingAmount -= amount;
          }
        }
      }
    }

    return plan;
  }

  private async executeDistribution(budgetId: string, month: string, plan: DistributionPlan[]): Promise<any[]> {
    const executedDistributions: any[] = [];

    for (const item of plan) {
      try {
        console.log(`Distributing ${formatCurrency(milliUnitsToAmount(item.proposedAmount))} to ${item.categoryName} (${item.reason})`);

        // Get current month data to get current budgeted amounts
        const monthResponse = await createRetryableAPICall(
          () => this.api.months.getBudgetMonth(budgetId, month),
          'Get budget month for distribution'
        );
        const monthData = monthResponse.data.month;
        
        const category = monthData.categories.find(cat => cat.id === item.categoryId);
        
        if (!category) {
          throw new Error(`Category not found: ${item.categoryId}`);
        }
        
        // Calculate new budgeted amount
        const newBudgeted = category.budgeted + item.proposedAmount;
        
        // Update the category budget
        const updateData: ynab.PatchMonthCategoryWrapper = {
          category: {
            budgeted: newBudgeted
          }
        };

        await createRetryableAPICall(
          () => this.api.categories.updateMonthCategory(budgetId, month, item.categoryId, updateData),
          'Update category budget'
        );
        
        executedDistributions.push({
          category: item.categoryName,
          amount: milliUnitsToAmount(item.proposedAmount),
          reason: item.reason,
          status: "success"
        });

      } catch (error) {
        console.error(`Error distributing funds to ${item.categoryName}:`, error);
        executedDistributions.push({
          category: item.categoryName,
          amount: milliUnitsToAmount(item.proposedAmount),
          reason: item.reason,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return executedDistributions;
  }
}

export default AutoDistributeFundsTool;
