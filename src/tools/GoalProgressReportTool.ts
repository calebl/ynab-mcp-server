import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, normalizeMonth, milliUnitsToAmount, formatCurrency } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface GoalProgressReportInput {
  budgetId?: string;
  month?: string;
  includeCompleted?: boolean;
  includeInsights?: boolean;
  response_format?: "json" | "markdown";
  limit?: number;
  offset?: number;
}

interface GoalProgress {
  category_id: string;
  category_name: string;
  goal_type: string;
  goal_target: number;
  goal_target_dollars: number;
  current_balance: number;
  current_balance_dollars: number;
  budgeted_this_month: number;
  budgeted_this_month_dollars: number;
  progress_percentage: number;
  remaining_amount: number;
  remaining_amount_dollars: number;
  months_remaining: number | null;
  status: 'on_track' | 'behind' | 'ahead' | 'completed' | 'no_goal';
  priority: 'high' | 'medium' | 'low';
}

interface GoalInsight {
  type: 'achievement' | 'concern' | 'recommendation';
  category: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  data: any;
}

interface GoalProgressReportResult {
  report_month: string;
  total_goals: number;
  completed_goals: number;
  on_track_goals: number;
  behind_goals: number;
  goal_progress: GoalProgress[];
  insights: GoalInsight[];
  summary: {
    total_budgeted_for_goals: number;
    average_progress: number;
    most_urgent_goal: string;
    most_progress_made: string;
    goals_needing_attention: number;
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

export default class GoalProgressReportTool {
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
      name: "ynab_goal_progress_report",
      description: "Generate a comprehensive report on category goal progress, including completion status, remaining amounts, and insights for goal achievement.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to analyze (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          month: {
            type: "string",
            description: "The budget month to analyze in YYYY-MM-DD format (optional, defaults to current month)",
          },
          includeCompleted: {
            type: "boolean",
            default: true,
            description: "Whether to include completed goals in the report",
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
            description: "Maximum number of goal progress items to return (default: 50, max: 100)",
          },
          offset: {
            type: "number",
            default: 0,
            description: "Number of goal progress items to skip (default: 0)",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Goal Progress Report",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: GoalProgressReportInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      const targetMonth = normalizeMonth(input.month);
      const includeCompleted = input.includeCompleted !== false;
      const includeInsights = input.includeInsights !== false;
      console.error(`Generating goal progress report for budget ${budgetId} for month ${targetMonth}`);
      
      // Get budget month data
      const monthBudget = await createRetryableAPICall(
        () => this.api.months.getBudgetMonth(budgetId, targetMonth),
        'Get budget month for goal progress'
      );
      const categories = monthBudget.data.month.categories.filter(
        category =>
          category.deleted === false &&
          category.hidden === false &&
          !category.name.includes("Inflow:") &&
          category.name !== "Uncategorized"
      );

      const goalProgress: GoalProgress[] = [];
      const insights: GoalInsight[] = [];
      let totalGoals = 0;
      let completedGoals = 0;
      let onTrackGoals = 0;
      let behindGoals = 0;

      for (const category of categories) {
        // Skip categories without goals
        if (!category.goal_type) {
          continue;
        }

        totalGoals++;

        const goalTarget = category.goal_target || 0;
        const currentBalance = category.balance || 0;
        const budgetedThisMonth = category.budgeted || 0;

        // Calculate progress
        let progressPercentage = 0;
        let remainingAmount = 0;
        let status: 'on_track' | 'behind' | 'ahead' | 'completed' | 'no_goal' = 'no_goal';
        let priority: 'high' | 'medium' | 'low' = 'low';
        let monthsRemaining: number | null = null;

        if (goalTarget > 0) {
          progressPercentage = Math.min((currentBalance / goalTarget) * 100, 100);
          remainingAmount = Math.max(goalTarget - currentBalance, 0);

          // Determine status based on goal type
          switch (category.goal_type) {
            case 'TB': // Target Balance
              if (currentBalance >= goalTarget) {
                status = 'completed';
                completedGoals++;
              } else {
                // Calculate if on track based on monthly budget
                const monthlyTarget = goalTarget / 12; // Assume 12-month timeline
                if (budgetedThisMonth >= monthlyTarget * 0.8) {
                  status = 'on_track';
                  onTrackGoals++;
                } else {
                  status = 'behind';
                  behindGoals++;
                }
              }
              break;

            case 'TBD': // Target Balance by Date
              if (currentBalance >= goalTarget) {
                status = 'completed';
                completedGoals++;
              } else {
                // Calculate months remaining based on goal target date
                const targetDate = new Date(category.goal_target_month || '');
                const currentDate = new Date(targetMonth);
                const monthsDiff = Math.max(0, (targetDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24 * 30));
                monthsRemaining = Math.ceil(monthsDiff);

                if (monthsRemaining > 0) {
                  const monthlyNeeded = remainingAmount / monthsRemaining;
                  if (budgetedThisMonth >= monthlyNeeded * 0.8) {
                    status = 'on_track';
                    onTrackGoals++;
                  } else {
                    status = 'behind';
                    behindGoals++;
                  }
                } else {
                  status = 'behind';
                  behindGoals++;
                }
              }
              break;

            case 'MF': // Monthly Funding
              const monthlyTarget = category.goal_target || 0;
              if (budgetedThisMonth >= monthlyTarget) {
                status = 'completed';
                completedGoals++;
              } else if (budgetedThisMonth >= monthlyTarget * 0.8) {
                status = 'on_track';
                onTrackGoals++;
              } else {
                status = 'behind';
                behindGoals++;
              }
              break;

            default:
              status = 'no_goal';
          }

          // Determine priority
          if (status === 'behind' && remainingAmount > 1000) {
            priority = 'high';
          } else if (status === 'behind' || remainingAmount > 500) {
            priority = 'medium';
          } else {
            priority = 'low';
          }
        }

        // Skip completed goals if not including them
        if (!includeCompleted && status === 'completed') {
          continue;
        }

        goalProgress.push({
          category_id: category.id,
          category_name: category.name,
          goal_type: category.goal_type || '',
          goal_target: goalTarget,
          goal_target_dollars: Math.round(milliUnitsToAmount(goalTarget) * 100) / 100,
          current_balance: currentBalance,
          current_balance_dollars: Math.round(milliUnitsToAmount(currentBalance) * 100) / 100,
          budgeted_this_month: budgetedThisMonth,
          budgeted_this_month_dollars: Math.round(milliUnitsToAmount(budgetedThisMonth) * 100) / 100,
          progress_percentage: Math.round(progressPercentage * 100) / 100,
          remaining_amount: remainingAmount,
          remaining_amount_dollars: Math.round(milliUnitsToAmount(remainingAmount) * 100) / 100,
          months_remaining: monthsRemaining,
          status: status,
          priority: priority,
        });

        // Generate insights if requested
        if (includeInsights) {
          // Goal completion achievement
          if (status === 'completed') {
            insights.push({
              type: 'achievement',
              category: category.name,
              message: `Goal completed! Target of ${formatCurrency(milliUnitsToAmount(goalTarget))} achieved.`,
              severity: 'low',
              data: { goal_target: goalTarget, current_balance: currentBalance }
            });
          }

          // Behind on goal
          if (status === 'behind' && priority === 'high') {
            insights.push({
              type: 'concern',
              category: category.name,
              message: `Significantly behind on goal: ${formatCurrency(milliUnitsToAmount(remainingAmount))} remaining, only ${formatCurrency(milliUnitsToAmount(budgetedThisMonth))} budgeted this month`,
              severity: 'high',
              data: { remaining_amount: remainingAmount, budgeted_this_month: budgetedThisMonth }
            });
          }

          // Good progress
          if (status === 'on_track' && progressPercentage > 75) {
            insights.push({
              type: 'achievement',
              category: category.name,
              message: `Great progress! ${progressPercentage.toFixed(1)}% complete on goal`,
              severity: 'low',
              data: { progress_percentage: progressPercentage }
            });
          }
        }
      }

      // Sort by priority and remaining amount
      goalProgress.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[b.priority] - priorityOrder[a.priority];
        }
        return b.remaining_amount - a.remaining_amount;
      });

      // Apply pagination
      const limit = Math.min(input.limit || 50, 100);
      const offset = input.offset || 0;
      const total = goalProgress.length;
      const paginatedGoalProgress = goalProgress.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      const nextOffset = hasMore ? offset + limit : null;

      // Calculate summary statistics (based on all goals, not just paginated)
      const totalBudgetedForGoals = goalProgress.reduce((sum, goal) => sum + goal.budgeted_this_month_dollars, 0);
      const averageProgress = goalProgress.length > 0 ?
        goalProgress.reduce((sum, goal) => sum + goal.progress_percentage, 0) / goalProgress.length : 0;

      const mostUrgentGoal = goalProgress.find(goal => goal.priority === 'high')?.category_name || 'None';
      const mostProgressMade = goalProgress.reduce((max, goal) =>
        goal.progress_percentage > max.progress_percentage ? goal : max,
        goalProgress[0] || { progress_percentage: 0, category_name: 'None' });

      const goalsNeedingAttention = goalProgress.filter(goal => goal.status === 'behind').length;

      const result: GoalProgressReportResult = {
        report_month: targetMonth,
        total_goals: totalGoals,
        completed_goals: completedGoals,
        on_track_goals: onTrackGoals,
        behind_goals: behindGoals,
        goal_progress: paginatedGoalProgress,
        insights: insights,
        summary: {
          total_budgeted_for_goals: Math.round(totalBudgetedForGoals * 100) / 100,
          average_progress: Math.round(averageProgress * 100) / 100,
          most_urgent_goal: mostUrgentGoal,
          most_progress_made: mostProgressMade.category_name,
          goals_needing_attention: goalsNeedingAttention,
        },
        pagination: {
          total,
          count: paginatedGoalProgress.length,
          offset,
          limit,
          has_more: hasMore,
          next_offset: nextOffset,
        },
        note: "All amounts are in dollars. Goal types: TB=Target Balance, TBD=Target Balance by Date, MF=Monthly Funding. Status indicates if you're on track to meet your goal based on current budgeting patterns.",
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
            text: `Error generating goal progress report: ${errorMessage}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: GoalProgressReportResult): string {
    let output = "# Goal Progress Report\n\n";

    output += "## Summary\n";
    output += `- **Report Month**: ${result.report_month}\n`;
    output += `- **Total Goals**: ${result.total_goals}\n`;
    output += `- **Showing**: ${result.pagination.count} goals (offset: ${result.pagination.offset}, limit: ${result.pagination.limit})\n`;
    output += `- **Completed Goals**: ${result.completed_goals}\n`;
    output += `- **On Track Goals**: ${result.on_track_goals}\n`;
    output += `- **Behind Goals**: ${result.behind_goals}\n`;
    output += `- **Total Budgeted for Goals**: ${formatCurrency(result.summary.total_budgeted_for_goals)}\n`;
    output += `- **Average Progress**: ${result.summary.average_progress.toFixed(1)}%\n`;
    output += `- **Most Urgent Goal**: ${result.summary.most_urgent_goal}\n`;
    output += `- **Most Progress Made**: ${result.summary.most_progress_made}\n`;
    output += `- **Goals Needing Attention**: ${result.summary.goals_needing_attention}\n\n`;

    if (result.goal_progress.length > 0) {
      output += "## Goal Progress by Category\n\n";
      for (const goal of result.goal_progress) {
        const statusEmoji = goal.status === 'completed' ? '✅' :
                           goal.status === 'on_track' ? '🟢' :
                           goal.status === 'behind' ? '🔴' :
                           goal.status === 'ahead' ? '🟡' : '⚪';
        const priorityEmoji = goal.priority === 'high' ? '🔥' :
                             goal.priority === 'medium' ? '⚡' : '📌';

        output += `### ${statusEmoji} ${goal.category_name} ${priorityEmoji}\n`;
        output += `- **Goal Type**: ${goal.goal_type}\n`;
        output += `- **Target**: ${formatCurrency(goal.goal_target_dollars)}\n`;
        output += `- **Current Balance**: ${formatCurrency(goal.current_balance_dollars)}\n`;
        output += `- **Budgeted This Month**: ${formatCurrency(goal.budgeted_this_month_dollars)}\n`;
        output += `- **Progress**: ${goal.progress_percentage.toFixed(1)}%\n`;
        output += `- **Remaining**: ${formatCurrency(goal.remaining_amount_dollars)}\n`;
        if (goal.months_remaining !== null) {
          output += `- **Months Remaining**: ${goal.months_remaining}\n`;
        }
        output += `- **Status**: ${goal.status}\n`;
        output += `- **Priority**: ${goal.priority}\n\n`;
      }
    }

    if (result.insights.length > 0) {
      output += "## Insights\n\n";
      for (const insight of result.insights) {
        const emoji = insight.type === 'achievement' ? '🎉' :
                     insight.type === 'concern' ? '⚠️' : '💡';
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
