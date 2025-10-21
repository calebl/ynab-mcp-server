import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, milliUnitsToAmount, formatCurrency } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface AnalyzeSpendingPatternsInput {
  budgetId?: string;
  months?: number;
  categoryId?: string;
  includeInsights?: boolean;
  response_format?: "json" | "markdown";
  limit?: number;
  offset?: number;
}

interface SpendingPattern {
  category_id: string;
  category_name: string;
  average_monthly_spending: number;
  spending_trend: 'increasing' | 'decreasing' | 'stable' | 'volatile';
  trend_percentage: number;
  months_analyzed: number;
  total_spent: number;
  highest_month: number;
  lowest_month: number;
  variance: number;
}

interface SpendingInsight {
  type: 'anomaly' | 'trend' | 'recommendation';
  category: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  data: any;
}

interface AnalyzeSpendingPatternsResult {
  analysis_period: string;
  total_categories_analyzed: number;
  spending_patterns: SpendingPattern[];
  insights: SpendingInsight[];
  summary: {
    total_spending: number;
    average_monthly_spending: number;
    most_volatile_category: string;
    fastest_growing_category: string;
    most_stable_category: string;
  };
  pagination: {
    total: number;
    count: number;
    offset: number;
    limit: number;
    has_more: boolean;
    next_offset: number | null;
  };
  note: string;
}

export default class AnalyzeSpendingPatternsTool {
  private api: ynab.API;
  private budgetId: string | undefined;

  constructor() {
    const token = process.env.YNAB_API_TOKEN;
    if (!token) {
      throw new Error("YNAB_API_TOKEN environment variable is required");
    }
    this.api = new ynab.API(token);
    this.budgetId = process.env.YNAB_BUDGET_ID;
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_analyze_spending_patterns",
      description: "Analyze spending patterns across categories to detect trends, anomalies, and provide insights about spending behavior over time.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to analyze (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          months: {
            type: "number",
            default: 6,
            description: "Number of months to analyze for patterns (default: 6, max: 12)",
          },
          categoryId: {
            type: "string",
            description: "Specific category ID to analyze (optional, if not provided analyzes all categories)",
          },
          includeInsights: {
            type: "boolean",
            default: true,
            description: "Whether to include AI-generated insights and recommendations",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
          limit: {
            type: "number",
            default: 50,
            description: "Maximum number of spending patterns to return (default: 50, max: 100)",
          },
          offset: {
            type: "number",
            default: 0,
            description: "Number of spending patterns to skip (default: 0)",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Analyze Spending Patterns",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: AnalyzeSpendingPatternsInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      const monthsToAnalyze = Math.min(input.months || 6, 12);
      const includeInsights = input.includeInsights !== false;
      console.error(`Analyzing spending patterns for budget ${budgetId} over ${monthsToAnalyze} months`);
      
      // Get categories
      const categoriesResponse = await createRetryableAPICall(
        () => this.api.categories.getCategories(budgetId),
        'Get categories for spending analysis'
      );
      const categories = categoriesResponse.data.category_groups
        .flatMap(group => group.categories)
        .filter(category =>
          category.deleted === false &&
          category.hidden === false &&
          !category.name.includes("Inflow:") &&
          category.name !== "Uncategorized"
        );

      // Get target category if specified
      let targetCategories = categories;
      if (input.categoryId) {
        const targetCategory = categories.find(cat => cat.id === input.categoryId);
        if (!targetCategory) {
          return {
            content: [
              {
                type: "text",
                text: `Category with ID ${input.categoryId} not found. Use the budget_summary tool to see available categories.`,
              },
            ],
          };
        }
        targetCategories = [targetCategory];
      }

      // Get historical data for the specified months
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(endDate.getMonth() - monthsToAnalyze);

      const spendingPatterns: SpendingPattern[] = [];
      const insights: SpendingInsight[] = [];

      for (const category of targetCategories) {
        try {
          // Get transactions for this category
          const transactionsResponse = await createRetryableAPICall(
            () => this.api.transactions.getTransactionsByCategory(
              budgetId,
              category.id,
              startDate.toISOString().split('T')[0]
            ),
            `Get transactions for category ${category.name}`
          );

          const transactions = transactionsResponse.data.transactions.filter(
            t => t.deleted === false && t.amount < 0 // Only spending transactions
          );

          // Group transactions by month
          const monthlySpending: { [month: string]: number } = {};
          let totalSpent = 0;

          for (const transaction of transactions) {
            const month = transaction.date.substring(0, 7); // YYYY-MM
            const amount = Math.abs(transaction.amount); // Convert to positive
            monthlySpending[month] = (monthlySpending[month] || 0) + amount;
            totalSpent += amount;
          }

          // Calculate spending pattern
          const monthlyAmounts = Object.values(monthlySpending);
          const monthsWithData = monthlyAmounts.length;
          
          if (monthsWithData === 0) {
            continue; // Skip categories with no spending data
          }

          const averageSpending = totalSpent / monthsWithData;
          const highestMonth = Math.max(...monthlyAmounts);
          const lowestMonth = Math.min(...monthlyAmounts);
          
          // Calculate variance
          const variance = monthlyAmounts.reduce((sum, amount) => 
            sum + Math.pow(amount - averageSpending, 2), 0) / monthsWithData;

          // Determine trend
          let trend: 'increasing' | 'decreasing' | 'stable' | 'volatile';
          let trendPercentage = 0;

          if (monthsWithData >= 2) {
            const firstHalf = monthlyAmounts.slice(0, Math.floor(monthsWithData / 2));
            const secondHalf = monthlyAmounts.slice(Math.floor(monthsWithData / 2));
            
            const firstHalfAvg = firstHalf.reduce((sum, val) => sum + val, 0) / firstHalf.length;
            const secondHalfAvg = secondHalf.reduce((sum, val) => sum + val, 0) / secondHalf.length;
            
            trendPercentage = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
            
            if (Math.abs(trendPercentage) < 5) {
              trend = 'stable';
            } else if (trendPercentage > 20) {
              trend = 'increasing';
            } else if (trendPercentage < -20) {
              trend = 'decreasing';
            } else {
              trend = 'volatile';
            }
          } else {
            trend = 'stable';
          }

          spendingPatterns.push({
            category_id: category.id,
            category_name: category.name,
            average_monthly_spending: Math.round(milliUnitsToAmount(averageSpending) * 100) / 100,
            spending_trend: trend,
            trend_percentage: Math.round(trendPercentage * 100) / 100,
            months_analyzed: monthsWithData,
            total_spent: Math.round(milliUnitsToAmount(totalSpent) * 100) / 100,
            highest_month: Math.round(milliUnitsToAmount(highestMonth) * 100) / 100,
            lowest_month: Math.round(milliUnitsToAmount(lowestMonth) * 100) / 100,
            variance: Math.round(milliUnitsToAmount(variance) * 100) / 100,
          });

          // Generate insights if requested
          if (includeInsights) {
            // High spending anomaly
            if (highestMonth > averageSpending * 2) {
              insights.push({
                type: 'anomaly',
                category: category.name,
                message: `High spending spike detected: ${formatCurrency(milliUnitsToAmount(highestMonth))} in one month (avg: ${formatCurrency(milliUnitsToAmount(averageSpending))})`,
                severity: 'high',
                data: { highest_month: highestMonth, average: averageSpending }
              });
            }

            // Increasing trend
            if (trend === 'increasing' && trendPercentage > 30) {
              insights.push({
                type: 'trend',
                category: category.name,
                message: `Spending increasing rapidly: ${trendPercentage.toFixed(1)}% growth over analyzed period`,
                severity: 'medium',
                data: { trend_percentage: trendPercentage }
              });
            }

            // High volatility
            if (variance > averageSpending * 0.5) {
              insights.push({
                type: 'anomaly',
                category: category.name,
                message: `High spending volatility: spending varies significantly month to month`,
                severity: 'medium',
                data: { variance, average: averageSpending }
              });
            }
          }

        } catch (error) {
          console.error(`Error analyzing category ${category.name}:`, error);
          // Continue with other categories
        }
      }

      // Sort patterns by total spending
      spendingPatterns.sort((a, b) => b.total_spent - a.total_spent);

      // Apply pagination
      const limit = Math.min(input.limit || 50, 100);
      const offset = input.offset || 0;
      const total = spendingPatterns.length;
      const paginatedPatterns = spendingPatterns.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      const nextOffset = hasMore ? offset + limit : null;

      // Calculate summary statistics (based on all patterns, not just paginated)
      const totalSpending = spendingPatterns.reduce((sum, pattern) => sum + pattern.total_spent, 0);
      const averageMonthlySpending = spendingPatterns.reduce((sum, pattern) => sum + pattern.average_monthly_spending, 0);

      const mostVolatileCategory = spendingPatterns.reduce((max, pattern) =>
        pattern.variance > max.variance ? pattern : max, spendingPatterns[0] || { variance: 0, category_name: 'None' });

      const fastestGrowingCategory = spendingPatterns.reduce((max, pattern) =>
        pattern.trend_percentage > max.trend_percentage ? pattern : max, spendingPatterns[0] || { trend_percentage: 0, category_name: 'None' });

      const mostStableCategory = spendingPatterns.reduce((min, pattern) =>
        Math.abs(pattern.trend_percentage) < Math.abs(min.trend_percentage) ? pattern : min, spendingPatterns[0] || { trend_percentage: 100, category_name: 'None' });

      const result: AnalyzeSpendingPatternsResult = {
        analysis_period: `${monthsToAnalyze} months ending ${endDate.toISOString().split('T')[0]}`,
        total_categories_analyzed: total,
        spending_patterns: paginatedPatterns,
        insights: insights,
        summary: {
          total_spending: Math.round(totalSpending * 100) / 100,
          average_monthly_spending: Math.round(averageMonthlySpending * 100) / 100,
          most_volatile_category: mostVolatileCategory.category_name,
          fastest_growing_category: fastestGrowingCategory.category_name,
          most_stable_category: mostStableCategory.category_name,
        },
        pagination: {
          total,
          count: paginatedPatterns.length,
          offset,
          limit,
          has_more: hasMore,
          next_offset: nextOffset,
        },
        note: "All amounts are in dollars. Positive trend_percentage indicates increasing spending, negative indicates decreasing spending. Analysis based on actual transaction data from YNAB.",
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
            text: `Error analyzing spending patterns: ${errorMessage}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: AnalyzeSpendingPatternsResult): string {
    let output = "# Spending Patterns Analysis\n\n";

    output += "## Summary\n";
    output += `- **Analysis Period**: ${result.analysis_period}\n`;
    output += `- **Categories Analyzed (Total)**: ${result.total_categories_analyzed}\n`;
    output += `- **Showing**: ${result.pagination.count} categories (offset: ${result.pagination.offset}, limit: ${result.pagination.limit})\n`;
    output += `- **Total Spending**: ${formatCurrency(result.summary.total_spending)}\n`;
    output += `- **Average Monthly Spending**: ${formatCurrency(result.summary.average_monthly_spending)}\n`;
    output += `- **Most Volatile Category**: ${result.summary.most_volatile_category}\n`;
    output += `- **Fastest Growing Category**: ${result.summary.fastest_growing_category}\n`;
    output += `- **Most Stable Category**: ${result.summary.most_stable_category}\n\n`;

    if (result.spending_patterns.length > 0) {
      output += "## Spending Patterns by Category\n\n";
      for (const pattern of result.spending_patterns) {
        output += `### ${pattern.category_name}\n`;
        output += `- **Total Spent**: ${formatCurrency(pattern.total_spent)}\n`;
        output += `- **Average Monthly**: ${formatCurrency(pattern.average_monthly_spending)}\n`;
        output += `- **Trend**: ${pattern.spending_trend} (${pattern.trend_percentage > 0 ? '+' : ''}${pattern.trend_percentage.toFixed(1)}%)\n`;
        output += `- **Highest Month**: ${formatCurrency(pattern.highest_month)}\n`;
        output += `- **Lowest Month**: ${formatCurrency(pattern.lowest_month)}\n`;
        output += `- **Variance**: ${formatCurrency(pattern.variance)}\n`;
        output += `- **Months Analyzed**: ${pattern.months_analyzed}\n\n`;
      }
    }

    if (result.insights.length > 0) {
      output += "## Insights\n\n";
      for (const insight of result.insights) {
        const emoji = insight.type === 'anomaly' ? '⚠️' : insight.type === 'trend' ? '📈' : '💡';
        output += `${emoji} **${insight.category}** (${insight.severity}): ${insight.message}\n\n`;
      }
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
    output += "\n";

    output += `## Note\n${result.note}\n`;

    return output;
  }
}
