import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handleAPIError, createRetryableAPICall } from "../utils/apiErrorHandler.js";
import {
  truncateResponse,
  CHARACTER_LIMIT,
  getBudgetId,
  milliUnitsToAmount,
  amountToMilliUnits,
  normalizeMonth,
  formatCurrency
} from "../utils/commonUtils.js";

interface BudgetFromHistoryInput {
  budgetId?: string;
  months?: number; // Number of months to analyze, default to 6
  targetMonth?: string; // YYYY-MM-DD format, defaults to current month
  strategy?: 'average' | 'median' | 'trend' | 'conservative' | 'aggressive';
  categoryIds?: string[]; // Optional: specific categories to budget for
  excludeCategories?: string[]; // Optional: categories to exclude from budgeting
  minSpendingThreshold?: number; // Minimum average spending to include in budget
  maxBudgetIncrease?: number; // Maximum percentage increase from historical average
  dryRun?: boolean;
  response_format?: "json" | "markdown";
}

interface CategoryBudgetSuggestion {
  category_id: string;
  category_name: string;
  category_group_name: string;
  historical_average: number;
  historical_median: number;
  historical_trend: number; // Percentage change over time
  suggested_budget: number;
  confidence_level: 'high' | 'medium' | 'low';
  reasoning: string;
  months_analyzed: number;
  total_spent: number;
  spending_consistency: number; // 0-1, higher = more consistent
}

interface BudgetFromHistoryResult {
  budget_id: string;
  target_month: string;
  analysis_period: string;
  strategy_used: string;
  total_suggested_budget: number;
  categories_analyzed: number;
  categories_with_suggestions: number;
  suggestions: CategoryBudgetSuggestion[];
  summary: {
    total_historical_spending: number;
    average_monthly_spending: number;
    suggested_budget_total: number;
    budget_vs_historical_ratio: number;
    high_confidence_suggestions: number;
    medium_confidence_suggestions: number;
    low_confidence_suggestions: number;
  };
  insights: string[];
  note: string;
}

export default class BudgetFromHistoryTool {
  private api: ynab.API;
  private budgetId?: string;

  constructor(budgetId?: string, ynabApi?: ynab.API) {
    this.api = ynabApi || new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = budgetId || process.env.YNAB_BUDGET_ID;
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_budget_from_history",
      description: "Analyze historical spending patterns and suggest budget allocations based on past behavior. Useful for setting up new budgets or adjusting existing ones based on actual spending history.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to analyze (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          months: {
            type: "number",
            description: "Number of months of historical data to analyze (default: 6, max: 12)",
            minimum: 3,
            maximum: 12,
          },
          targetMonth: {
            type: "string",
            description: "The month to create budget suggestions for in YYYY-MM-DD format (default: current month)",
          },
          strategy: {
            type: "string",
            enum: ["average", "median", "trend", "conservative", "aggressive"],
            description: "Budgeting strategy: average=use historical average, median=use median spending, trend=extrapolate trend, conservative=lower than average, aggressive=higher than average",
            default: "average",
          },
          categoryIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional: Specific category IDs to include in budget suggestions",
          },
          excludeCategories: {
            type: "array",
            items: { type: "string" },
            description: "Optional: Category names or IDs to exclude from budget suggestions",
          },
          minSpendingThreshold: {
            type: "number",
            description: "Minimum average monthly spending to include in budget suggestions (default: 10.00)",
            default: 10.00,
          },
          maxBudgetIncrease: {
            type: "number",
            description: "Maximum percentage increase from historical average (default: 50, i.e., 50% increase max)",
            default: 50,
          },
          dryRun: {
            type: "boolean",
            description: "If true, will show suggestions without applying them to the budget",
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
        title: "Budget from History",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: BudgetFromHistoryInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      const monthsToAnalyze = input.months || 6;
      const strategy = input.strategy || 'average';
      const minSpendingThreshold = amountToMilliUnits(input.minSpendingThreshold || 10.00);
      const maxBudgetIncrease = (input.maxBudgetIncrease || 50) / 100; // Convert to decimal
      // Get current categories
      const categoriesResponse = await createRetryableAPICall(
        () => this.api.categories.getCategories(budgetId),
        'Get categories for budget analysis'
      );
      const allCategories = categoriesResponse.data.category_groups
        .flatMap((group: any) => group.categories)
        .filter((category: any) => 
          !category.deleted && 
          !category.hidden && 
          !category.name.includes("Inflow:") &&
          category.name !== "Uncategorized"
        );

      // Filter categories based on input
      let targetCategories = allCategories;
      if (input.categoryIds && input.categoryIds.length > 0) {
        targetCategories = targetCategories.filter((cat: any) => input.categoryIds?.includes(cat.id));
      }
      if (input.excludeCategories && input.excludeCategories.length > 0) {
        targetCategories = targetCategories.filter((cat: any) => 
          !input.excludeCategories?.some(exclude => 
            cat.name.toLowerCase().includes(exclude.toLowerCase()) || 
            cat.id === exclude
          )
        );
      }

      // Calculate date range for analysis
      const currentDate = new Date();
      const currentMonth = currentDate.getMonth();
      const currentYear = currentDate.getFullYear();

      const suggestions: CategoryBudgetSuggestion[] = [];
      const insights: string[] = [];

      for (const category of targetCategories) {
        try {
          // Get historical spending data for this category
          const monthlySpending: number[] = [];
          let totalSpent = 0;
          let monthsWithSpending = 0;

          for (let i = 0; i < monthsToAnalyze; i++) {
            // Calculate month going back from current month
            let targetMonth = currentMonth - i;
            let targetYear = currentYear;
            
            // Handle year boundaries
            while (targetMonth < 0) {
              targetMonth += 12;
              targetYear -= 1;
            }
            
            const monthKey = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-01`;

            try {
              const monthBudget = await createRetryableAPICall(
                () => this.api.months.getBudgetMonth(budgetId, monthKey),
                `Get budget month ${monthKey}`
              );
              const monthCategory = monthBudget.data.month.categories.find(
                (cat: any) => cat.id === category.id
              );

              if (monthCategory) {
                const spending = Math.abs(monthCategory.activity || 0); // Activity is negative for spending
                monthlySpending.push(spending);
                totalSpent += spending;
                if (spending > 0) monthsWithSpending++;
              } else {
                monthlySpending.push(0);
              }
            } catch (error) {
              // If month data not found, assume 0 spending
              monthlySpending.push(0);
            }
          }

          // Calculate statistics
          const averageSpending = monthsWithSpending > 0 ? totalSpent / monthsWithSpending : 0;
          const medianSpending = this.calculateMedian(monthlySpending.filter(amount => amount > 0));
          
          // Calculate trend (simple linear regression)
          const trend = this.calculateTrend(monthlySpending);
          
          // Calculate spending consistency (coefficient of variation)
          const spendingConsistency = this.calculateConsistency(monthlySpending);

          // Skip categories with very low spending
          if (averageSpending < minSpendingThreshold) {
            continue;
          }

          // Calculate suggested budget based on strategy
          let suggestedBudget = 0;
          let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
          let reasoning = '';

          switch (strategy) {
            case 'average':
              suggestedBudget = averageSpending;
              confidenceLevel = spendingConsistency > 0.7 ? 'high' : spendingConsistency > 0.4 ? 'medium' : 'low';
              reasoning = `Based on ${monthsWithSpending} months of spending data (avg: ${formatCurrency(milliUnitsToAmount(averageSpending))})`;
              break;
            case 'median':
              suggestedBudget = medianSpending;
              confidenceLevel = spendingConsistency > 0.6 ? 'high' : spendingConsistency > 0.3 ? 'medium' : 'low';
              reasoning = `Based on median spending of ${formatCurrency(milliUnitsToAmount(medianSpending))} over ${monthsWithSpending} months`;
              break;
            case 'trend':
              suggestedBudget = Math.max(0, averageSpending * (1 + trend));
              confidenceLevel = Math.abs(trend) < 0.2 ? 'high' : Math.abs(trend) < 0.5 ? 'medium' : 'low';
              reasoning = `Trend-based: ${trend > 0 ? '+' : ''}${(trend * 100).toFixed(1)}% change from average ${formatCurrency(milliUnitsToAmount(averageSpending))}`;
              break;
            case 'conservative':
              suggestedBudget = averageSpending * 0.8; // 20% below average
              confidenceLevel = spendingConsistency > 0.6 ? 'high' : spendingConsistency > 0.3 ? 'medium' : 'low';
              reasoning = `Conservative: 20% below average spending of ${formatCurrency(milliUnitsToAmount(averageSpending))}`;
              break;
            case 'aggressive':
              suggestedBudget = averageSpending * 1.2; // 20% above average
              confidenceLevel = spendingConsistency > 0.6 ? 'high' : spendingConsistency > 0.3 ? 'medium' : 'low';
              reasoning = `Aggressive: 20% above average spending of ${formatCurrency(milliUnitsToAmount(averageSpending))}`;
              break;
          }

          // Apply maximum increase limit
          if (suggestedBudget > averageSpending * (1 + maxBudgetIncrease)) {
            suggestedBudget = averageSpending * (1 + maxBudgetIncrease);
            reasoning += ` (capped at ${maxBudgetIncrease * 100}% increase)`;
          }

          // Find category group name
          const categoryGroup = categoriesResponse.data.category_groups.find(
            (group: any) => group.categories.some((cat: any) => cat.id === category.id)
          );

          suggestions.push({
            category_id: category.id,
            category_name: category.name,
            category_group_name: categoryGroup?.name || 'Unknown',
            historical_average: averageSpending,
            historical_median: medianSpending,
            historical_trend: trend,
            suggested_budget: suggestedBudget,
            confidence_level: confidenceLevel,
            reasoning: reasoning,
            months_analyzed: monthsWithSpending,
            total_spent: totalSpent,
            spending_consistency: spendingConsistency,
          });

        } catch (error) {
          console.error(`Error processing category ${category.name}:`, error);
        }
      }

      // Generate insights
      const totalHistoricalSpending = suggestions.reduce((sum, s) => sum + s.total_spent, 0);
      const averageMonthlySpending = totalHistoricalSpending / monthsToAnalyze;
      const suggestedBudgetTotal = suggestions.reduce((sum, s) => sum + s.suggested_budget, 0);
      const budgetVsHistoricalRatio = averageMonthlySpending > 0 ? suggestedBudgetTotal / averageMonthlySpending : 0;

      insights.push(`Analyzed ${suggestions.length} categories with meaningful spending history`);
      insights.push(`Total historical spending: ${formatCurrency(milliUnitsToAmount(totalHistoricalSpending))} over ${monthsToAnalyze} months`);
      insights.push(`Suggested budget total: ${formatCurrency(milliUnitsToAmount(suggestedBudgetTotal))} (${(budgetVsHistoricalRatio * 100).toFixed(1)}% of historical spending)`);

      const highConfidenceCount = suggestions.filter(s => s.confidence_level === 'high').length;
      const mediumConfidenceCount = suggestions.filter(s => s.confidence_level === 'medium').length;
      const lowConfidenceCount = suggestions.filter(s => s.confidence_level === 'low').length;

      if (highConfidenceCount > 0) {
        insights.push(`${highConfidenceCount} categories have high-confidence budget suggestions`);
      }
      if (lowConfidenceCount > 0) {
        insights.push(`${lowConfidenceCount} categories have low-confidence suggestions - consider manual review`);
      }

      // Strategy-specific insights
      if (strategy === 'trend') {
        const increasingCategories = suggestions.filter(s => s.historical_trend > 0.1).length;
        const decreasingCategories = suggestions.filter(s => s.historical_trend < -0.1).length;
        if (increasingCategories > 0) {
          insights.push(`${increasingCategories} categories show increasing spending trends`);
        }
        if (decreasingCategories > 0) {
          insights.push(`${decreasingCategories} categories show decreasing spending trends`);
        }
      }

      const result: BudgetFromHistoryResult = {
        budget_id: budgetId,
        target_month: normalizeMonth(input.targetMonth),
        analysis_period: `${monthsToAnalyze} months ending ${new Date().toISOString().substring(0, 7)}`,
        strategy_used: strategy,
        total_suggested_budget: suggestedBudgetTotal,
        categories_analyzed: targetCategories.length,
        categories_with_suggestions: suggestions.length,
        suggestions: suggestions.map(s => ({
          ...s,
          historical_average: milliUnitsToAmount(s.historical_average),
          historical_median: milliUnitsToAmount(s.historical_median),
          suggested_budget: milliUnitsToAmount(s.suggested_budget),
          total_spent: milliUnitsToAmount(s.total_spent),
        })),
        summary: {
          total_historical_spending: milliUnitsToAmount(totalHistoricalSpending),
          average_monthly_spending: milliUnitsToAmount(averageMonthlySpending),
          suggested_budget_total: milliUnitsToAmount(suggestedBudgetTotal),
          budget_vs_historical_ratio: budgetVsHistoricalRatio,
          high_confidence_suggestions: highConfidenceCount,
          medium_confidence_suggestions: mediumConfidenceCount,
          low_confidence_suggestions: lowConfidenceCount,
        },
        insights: insights,
        note: "All amounts are in dollars. Suggestions are based on historical spending patterns and should be reviewed before applying to your budget.",
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
      await handleAPIError(error, 'Budget from history analysis');
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error analyzing budget from history: ${errorMessage}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: BudgetFromHistoryResult): string {
    let output = "# Budget from History Analysis\n\n";

    output += "## Summary\n";
    output += `- **Target Month**: ${result.target_month}\n`;
    output += `- **Analysis Period**: ${result.analysis_period}\n`;
    output += `- **Strategy Used**: ${result.strategy_used}\n`;
    output += `- **Categories Analyzed**: ${result.categories_analyzed}\n`;
    output += `- **Categories with Suggestions**: ${result.categories_with_suggestions}\n\n`;

    output += "## Financial Overview\n";
    output += `- **Total Historical Spending**: ${formatCurrency(result.summary.total_historical_spending)}\n`;
    output += `- **Average Monthly Spending**: ${formatCurrency(result.summary.average_monthly_spending)}\n`;
    output += `- **Suggested Budget Total**: ${formatCurrency(result.summary.suggested_budget_total)}\n`;
    output += `- **Budget vs Historical Ratio**: ${(result.summary.budget_vs_historical_ratio * 100).toFixed(1)}%\n\n`;

    output += "## Confidence Distribution\n";
    output += `- **High Confidence**: ${result.summary.high_confidence_suggestions} suggestions\n`;
    output += `- **Medium Confidence**: ${result.summary.medium_confidence_suggestions} suggestions\n`;
    output += `- **Low Confidence**: ${result.summary.low_confidence_suggestions} suggestions\n\n`;

    if (result.suggestions.length > 0) {
      output += "## Category Suggestions\n\n";

      // Group by confidence level
      const highConfidence = result.suggestions.filter(s => s.confidence_level === 'high');
      const mediumConfidence = result.suggestions.filter(s => s.confidence_level === 'medium');
      const lowConfidence = result.suggestions.filter(s => s.confidence_level === 'low');

      if (highConfidence.length > 0) {
        output += "### High Confidence 🟢\n\n";
        for (const suggestion of highConfidence) {
          output += `**${suggestion.category_name}** (${suggestion.category_group_name})\n`;
          output += `- Suggested Budget: ${formatCurrency(suggestion.suggested_budget)}\n`;
          output += `- Historical Average: ${formatCurrency(suggestion.historical_average)}\n`;
          output += `- Reasoning: ${suggestion.reasoning}\n`;
          output += `- Months Analyzed: ${suggestion.months_analyzed}\n\n`;
        }
      }

      if (mediumConfidence.length > 0) {
        output += "### Medium Confidence 🟡\n\n";
        for (const suggestion of mediumConfidence) {
          output += `**${suggestion.category_name}** (${suggestion.category_group_name})\n`;
          output += `- Suggested Budget: ${formatCurrency(suggestion.suggested_budget)}\n`;
          output += `- Historical Average: ${formatCurrency(suggestion.historical_average)}\n`;
          output += `- Reasoning: ${suggestion.reasoning}\n`;
          output += `- Months Analyzed: ${suggestion.months_analyzed}\n\n`;
        }
      }

      if (lowConfidence.length > 0) {
        output += "### Low Confidence 🔴\n\n";
        for (const suggestion of lowConfidence) {
          output += `**${suggestion.category_name}** (${suggestion.category_group_name})\n`;
          output += `- Suggested Budget: ${formatCurrency(suggestion.suggested_budget)}\n`;
          output += `- Historical Average: ${formatCurrency(suggestion.historical_average)}\n`;
          output += `- Reasoning: ${suggestion.reasoning}\n`;
          output += `- Months Analyzed: ${suggestion.months_analyzed}\n\n`;
        }
      }
    }

    if (result.insights.length > 0) {
      output += "## Insights\n\n";
      for (const insight of result.insights) {
        output += `- ${insight}\n`;
      }
      output += "\n";
    }

    output += `## Note\n${result.note}\n`;

    return output;
  }

  private calculateMedian(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  private calculateTrend(monthlySpending: number[]): number {
    if (monthlySpending.length < 2) return 0;
    
    // Simple linear regression to find trend
    const n = monthlySpending.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = monthlySpending;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const avgY = sumY / n;
    
    return avgY > 0 ? slope / avgY : 0; // Return as percentage change
  }

  private calculateConsistency(monthlySpending: number[]): number {
    const nonZeroSpending = monthlySpending.filter(amount => amount > 0);
    if (nonZeroSpending.length < 2) return 0;
    
    const mean = nonZeroSpending.reduce((sum, amount) => sum + amount, 0) / nonZeroSpending.length;
    const variance = nonZeroSpending.reduce((sum, amount) => sum + Math.pow(amount - mean, 2), 0) / nonZeroSpending.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Coefficient of variation (lower = more consistent)
    return mean > 0 ? 1 - (standardDeviation / mean) : 0;
  }
}
