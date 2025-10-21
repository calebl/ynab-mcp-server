import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { optimizeCategories, optimizeAccounts, withContextOptimization } from "../utils/contextOptimizer.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, milliUnitsToAmount, formatCurrency } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface BudgetSummaryInput {
  budgetId?: string;
  month: string;
  response_format?: "json" | "markdown";
}

class BudgetSummaryTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_budget_summary",
      description: "Get a summary of the budget for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to get a summary for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          month: {
            type: "string",
            pattern: "^(current|\\d{4}-\\d{2}-\\d{2})$",
            default: "current",
            description: "The budget month in ISO format (e.g. 2016-12-01). The string 'current' can also be used to specify the current calendar month (UTC)",
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
        title: "Budget Summary",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: BudgetSummaryInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      console.error(`Getting accounts and categories for budget ${budgetId} and month ${input.month}`);
      const accountsResponse = await createRetryableAPICall(
        () => this.api.accounts.getAccounts(budgetId),
        'Get accounts for budget summary'
      );
      // Filter accounts: only include open, non-deleted accounts that are on-budget
      const accounts = accountsResponse.data.accounts.filter(
        (account) =>
          account.deleted === false &&
          account.closed === false &&
          account.on_budget === true
      );

      const monthBudget = await createRetryableAPICall(
        () => this.api.months.getBudgetMonth(budgetId, input.month),
        'Get budget month'
      );

      // Filter categories: only include active, non-hidden categories
      // Also exclude internal categories like "Inflow: Ready to Assign" and "Uncategorized"
      const categories = monthBudget.data.month.categories
        .filter(
          (category) => 
            category.deleted === false && 
            category.hidden === false &&
            !category.name.includes("Inflow:") &&
            category.name !== "Uncategorized" &&
            category.name !== "Deferred Income SubCategory"
        );

      const result = this.summaryPrompt(monthBudget.data.month, accounts, categories);

      // Add category summary for better context
      const categorySummary = this.createCategorySummary(categories);
      const enhancedResult = {
        ...result,
        categorySummary: categorySummary
      };

      const format = input.response_format || "markdown";
      let responseText: string;

      if (format === "json") {
        // Optimize for context efficiency in JSON mode
        const optimized = withContextOptimization(enhancedResult, {
          maxTokens: 4000,
          summarizeCategories: true,
          summarizeAccounts: true
        });
        responseText = optimized.content[0].text;
      } else {
        responseText = this.formatMarkdown(monthBudget.data.month, accounts, categories, categorySummary);
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
    } catch (error: unknown) {
      console.error(`Error getting budget:`);
      console.error(JSON.stringify(error, null, 2));
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting budget: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
          },
        ],
      };
    }
  }

  private summaryPrompt(
    monthBudget: ynab.MonthDetail,
    accounts: ynab.Account[],
    categories: ynab.Category[]
  ) {
//     const prompt = `
// Here is the budget month information for the month of ${monthBudget.month}:
//   Income: ${monthBudget.income / 1000}
//   Budgeted: ${monthBudget.budgeted / 1000}
//   Activity: ${monthBudget.activity / 1000}
//   To be budgeted: ${monthBudget.to_be_budgeted / 1000}
//   Age of Money: ${monthBudget.age_of_money}
//   Note: ${monthBudget.note}

// Make sure to use the budget month information to help you answer the user's question. If income is less than budgeted, it means that the month is over budget.
// If there is money in the to be budgeted, suggest that the user assign it to a category. Tell the user how much they have spent and how much they have made.

// Example response if spending is more than income:
// You have spent $100.00 more this month than you made.

// Example response if spending is less than income:
// You have made $100.00 more this month than you spent.

// Here is a list of categories. Use this list to help you answer the user's question.
// Categories:
// ${categories
//   .map(
//     (category) =>
//       `Category: ${category.name} (id:${category.id}, balance: ${category.balance / 1000}, budgeted: ${category.budgeted / 1000}, activity: ${category.activity / 1000})`
//   )
//   .join("\n")}

// List all categories. Order them by balance from lowest to highest. Like this:
// Categories:
// - Category 1: -$100.00
// - Category 2: -$50.00
// - Category 3: -$25.00
// - Category 4: -$10.00
// - Category 5: -$5.00

// Here is a list of accounts. Use this list to help you answer the user's question.
// Checking and savings accounts:
// ${accounts
//   .filter((account) => account.type === "checking" || account.type === "savings")
//   .map(
//     (account) =>
//       `Account ${account.id}. Name: ${account.name} (id:${account.id}, type:${account.type}, balance: ${account.balance / 1000})`
//   )
//   .join("\n")}
// `;

    // return prompt;

    return {
      monthBudget: {
        month: monthBudget.month,
        note: monthBudget.note,
        income: monthBudget.income,
        budgeted: monthBudget.budgeted,
        activity: monthBudget.activity,
        to_be_budgeted: monthBudget.to_be_budgeted,
        age_of_money: monthBudget.age_of_money,
        deleted: monthBudget.deleted,
        categories: optimizeCategories(categories, { 
          prioritizeByActivity: true 
        })
      },
      accounts: optimizeAccounts(accounts),
      note: "All amounts in dollars. Compressed format: bal=balance, bud=budgeted, act=activity. All categories shown, sorted by activity.",
    }
  }

  private createCategorySummary(categories: any[]) {
    const totalCategories = categories.length;
    const categoriesWithActivity = categories.filter(cat => cat.activity !== 0);
    const categoriesWithBudget = categories.filter(cat => cat.budgeted !== 0);
    const overspentCategories = categories.filter(cat => cat.balance < 0);
    const underfundedCategories = categories.filter(cat => cat.budgeted > 0 && cat.balance < cat.budgeted);

    // Calculate totals
    const totalActivity = categories.reduce((sum, cat) => sum + cat.activity, 0);
    const totalBudgeted = categories.reduce((sum, cat) => sum + cat.budgeted, 0);
    const totalOverspent = overspentCategories.reduce((sum, cat) => sum + Math.abs(cat.balance), 0);

    return {
      total_categories: totalCategories,
      categories_with_activity: categoriesWithActivity.length,
      categories_with_budget: categoriesWithBudget.length,
      overspent_categories: overspentCategories.length,
      underfunded_categories: underfundedCategories.length,
      total_activity_dollars: Math.round((milliUnitsToAmount(totalActivity)) * 100) / 100,
      total_budgeted_dollars: Math.round((milliUnitsToAmount(totalBudgeted)) * 100) / 100,
      total_overspent_dollars: Math.round((milliUnitsToAmount(totalOverspent)) * 100) / 100,
      top_activity_categories: categoriesWithActivity
        .sort((a, b) => Math.abs(b.activity) - Math.abs(a.activity))
        .slice(0, 5)
        .map(cat => ({
          name: cat.name,
          activity_dollars: Math.round((milliUnitsToAmount(cat.activity)) * 100) / 100
        }))
    };
  }

  private formatMarkdown(
    monthBudget: ynab.MonthDetail,
    accounts: ynab.Account[],
    categories: ynab.Category[],
    categorySummary: any
  ): string {
    let output = `# Budget Summary for ${monthBudget.month}\n\n`;

    output += "## Month Overview\n";
    output += `- **Income**: ${formatCurrency(milliUnitsToAmount(monthBudget.income))}\n`;
    output += `- **Budgeted**: ${formatCurrency(milliUnitsToAmount(monthBudget.budgeted))}\n`;
    output += `- **Activity**: ${formatCurrency(milliUnitsToAmount(monthBudget.activity))}\n`;
    output += `- **Ready to Assign**: ${formatCurrency(milliUnitsToAmount(monthBudget.to_be_budgeted))}\n`;
    if (monthBudget.age_of_money !== null) {
      output += `- **Age of Money**: ${monthBudget.age_of_money} days\n`;
    }
    if (monthBudget.note) {
      output += `- **Note**: ${monthBudget.note}\n`;
    }
    output += "\n";

    output += "## Category Summary\n";
    output += `- **Total Categories**: ${categorySummary.total_categories}\n`;
    output += `- **Categories with Activity**: ${categorySummary.categories_with_activity}\n`;
    output += `- **Categories with Budget**: ${categorySummary.categories_with_budget}\n`;
    output += `- **Overspent Categories**: ${categorySummary.overspent_categories}\n`;
    output += `- **Total Activity**: ${formatCurrency(categorySummary.total_activity_dollars)}\n`;
    output += `- **Total Budgeted**: ${formatCurrency(categorySummary.total_budgeted_dollars)}\n`;
    if (categorySummary.overspent_categories > 0) {
      output += `- **Total Overspent**: ${formatCurrency(categorySummary.total_overspent_dollars)}\n`;
    }
    output += "\n";

    if (categorySummary.top_activity_categories.length > 0) {
      output += "## Top Activity Categories\n";
      for (const cat of categorySummary.top_activity_categories) {
        output += `- **${cat.name}**: ${formatCurrency(cat.activity_dollars)}\n`;
      }
      output += "\n";
    }

    // Show overspent categories
    const overspentCategories = categories.filter(cat => cat.balance < 0)
      .sort((a, b) => a.balance - b.balance);

    if (overspentCategories.length > 0) {
      output += "## Overspent Categories (Need Attention)\n";
      for (const cat of overspentCategories) {
        output += `- **${cat.name}** (${cat.category_group_name})\n`;
        output += `  - Balance: ${formatCurrency(milliUnitsToAmount(cat.balance))}\n`;
        output += `  - Budgeted: ${formatCurrency(milliUnitsToAmount(cat.budgeted))}\n`;
        output += `  - Activity: ${formatCurrency(milliUnitsToAmount(cat.activity))}\n`;
      }
      output += "\n";
    }

    // Show well-performing categories
    const wellPerformingCategories = categories.filter(cat => cat.balance > 0 && cat.budgeted > 0)
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 5);

    if (wellPerformingCategories.length > 0) {
      output += "## Well-Performing Categories\n";
      for (const cat of wellPerformingCategories) {
        output += `- **${cat.name}** (${cat.category_group_name})\n`;
        output += `  - Balance: ${formatCurrency(milliUnitsToAmount(cat.balance))}\n`;
        output += `  - Budgeted: ${formatCurrency(milliUnitsToAmount(cat.budgeted))}\n`;
        output += `  - Activity: ${formatCurrency(milliUnitsToAmount(cat.activity))}\n`;
      }
      output += "\n";
    }

    // Show account balances
    const checkingAndSavingsAccounts = accounts.filter(account =>
      account.type === "checking" || account.type === "savings"
    );

    if (checkingAndSavingsAccounts.length > 0) {
      output += "## Checking and Savings Accounts\n";
      for (const account of checkingAndSavingsAccounts) {
        output += `- **${account.name}** (${account.type})\n`;
        output += `  - Balance: ${formatCurrency(milliUnitsToAmount(account.balance))}\n`;
      }
      output += "\n";
    }

    return output;
  }
}

export default BudgetSummaryTool;
