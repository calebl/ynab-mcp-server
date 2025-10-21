import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import GoalProgressReportTool from '../tools/GoalProgressReportTool';

vi.mock('ynab');

describe('GoalProgressReportTool', () => {
  let tool: GoalProgressReportTool;
  let mockApi: {
    months: {
      getBudgetMonth: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      months: {
        getBudgetMonth: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new GoalProgressReportTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_goal_progress_report');
      expect(toolDef.description).toContain('goal progress');
      expect(toolDef.description).toContain('completion status');
    });

    it('should have correct input schema with all properties', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('month');
      expect(toolDef.inputSchema.properties).toHaveProperty('includeCompleted');
      expect(toolDef.inputSchema.properties).toHaveProperty('includeInsights');
      expect(toolDef.inputSchema.properties).toHaveProperty('response_format');
    });

    it('should have includeCompleted default to true', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.includeCompleted.default).toBe(true);
    });

    it('should have includeInsights default to true', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.includeInsights.default).toBe(true);
    });
  });

  describe('execute - successful goal tracking', () => {
    const mockMonthDataWithGoals = {
      data: {
        month: {
          month: '2024-01-01',
          categories: [
            {
              id: 'cat-emergency',
              name: 'Emergency Fund',
              deleted: false,
              hidden: false,
              goal_type: 'TB',
              goal_target: 1000000, // $1000 target
              balance: 500000, // $500 current
              budgeted: 100000, // $100 budgeted this month
            },
            {
              id: 'cat-vacation',
              name: 'Vacation',
              deleted: false,
              hidden: false,
              goal_type: 'TBD',
              goal_target: 500000, // $500 target
              goal_target_month: '2024-12-01',
              balance: 400000, // $400 current
              budgeted: 50000, // $50 budgeted this month
            },
            {
              id: 'cat-completed',
              name: 'Completed Goal',
              deleted: false,
              hidden: false,
              goal_type: 'TB',
              goal_target: 300000, // $300 target
              balance: 300000, // $300 current - completed!
              budgeted: 0,
            },
            {
              id: 'cat-no-goal',
              name: 'Groceries',
              deleted: false,
              hidden: false,
              balance: 100000,
              budgeted: 300000,
            },
          ],
        },
      },
    };

    it('should generate goal progress report for all goals', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('goal_progress');
      expect(parsedResult).toHaveProperty('insights');
      expect(parsedResult).toHaveProperty('summary');
      expect(parsedResult.total_goals).toBe(3); // 3 categories with goals
    });

    it('should correctly identify completed goals', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.completed_goals).toBe(1);
      const completedGoal = parsedResult.goal_progress.find(
        (g: any) => g.category_name === 'Completed Goal'
      );
      expect(completedGoal.status).toBe('completed');
      expect(completedGoal.progress_percentage).toBe(100);
    });

    it('should calculate progress percentage correctly', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const emergencyFund = parsedResult.goal_progress.find(
        (g: any) => g.category_name === 'Emergency Fund'
      );
      expect(emergencyFund.progress_percentage).toBe(50); // 500/1000 = 50%
    });

    it('should calculate remaining amount correctly', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const emergencyFund = parsedResult.goal_progress.find(
        (g: any) => g.category_name === 'Emergency Fund'
      );
      expect(emergencyFund.remaining_amount_dollars).toBe(500); // $1000 - $500
    });

    it('should identify on-track goals', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.on_track_goals).toBeGreaterThan(0);
    });

    it('should identify behind goals', async () => {
      const mockMonthDataBehind = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-behind',
                name: 'Behind Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000, // $1000 target
                balance: 100000, // $100 current
                budgeted: 10000, // $10 budgeted - too little
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataBehind);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.behind_goals).toBeGreaterThan(0);
      const behindGoal = parsedResult.goal_progress.find((g: any) => g.category_name === 'Behind Goal');
      expect(behindGoal.status).toBe('behind');
    });

    it('should exclude completed goals when includeCompleted is false', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        includeCompleted: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const hasCompletedGoal = parsedResult.goal_progress.some(
        (g: any) => g.status === 'completed'
      );
      expect(hasCompletedGoal).toBe(false);
    });

    it('should skip categories without goals', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthDataWithGoals);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const noGoalCategory = parsedResult.goal_progress.find(
        (g: any) => g.category_name === 'Groceries'
      );
      expect(noGoalCategory).toBeUndefined();
    });
  });

  describe('execute - goal type handling', () => {
    it('should handle TB (Target Balance) goals', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-tb',
                name: 'TB Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 500000,
                budgeted: 100000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.goal_progress[0].goal_type).toBe('TB');
    });

    it('should handle TBD (Target Balance by Date) goals', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-tbd',
                name: 'TBD Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TBD',
                goal_target: 500000,
                goal_target_month: '2024-12-01',
                balance: 200000,
                budgeted: 50000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.goal_progress[0].goal_type).toBe('TBD');
      expect(parsedResult.goal_progress[0].months_remaining).toBeGreaterThan(0);
    });

    it('should handle MF (Monthly Funding) goals', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-mf',
                name: 'MF Goal',
                deleted: false,
                hidden: false,
                goal_type: 'MF',
                goal_target: 100000, // $100 monthly
                balance: 500000,
                budgeted: 100000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.goal_progress[0].goal_type).toBe('MF');
    });

    it('should handle NEED (Plan Your Spending) goals', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-need',
                name: 'NEED Goal',
                deleted: false,
                hidden: false,
                goal_type: 'NEED',
                goal_target: 300000, // $300 needed
                balance: 0,
                budgeted: 300000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.goal_progress[0].goal_type).toBe('NEED');
    });
  });

  describe('execute - insights generation', () => {
    it('should generate insights when enabled', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Goal Category',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 900000, // 90% complete - close to completion
                budgeted: 100000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        includeInsights: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('insights');
      expect(Array.isArray(parsedResult.insights)).toBe(true);
    });

    it('should not generate insights when disabled', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Goal Category',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 900000,
                budgeted: 100000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        includeInsights: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.insights).toHaveLength(0);
    });
  });

  describe('execute - summary statistics', () => {
    const mockMonthData = {
      data: {
        month: {
          month: '2024-01-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Goal 1',
              deleted: false,
              hidden: false,
              goal_type: 'TB',
              goal_target: 1000000,
              balance: 500000,
              budgeted: 100000,
            },
            {
              id: 'cat-2',
              name: 'Goal 2',
              deleted: false,
              hidden: false,
              goal_type: 'TBD',
              goal_target: 500000,
              goal_target_month: '2024-12-01',
              balance: 250000,
              budgeted: 50000,
            },
            {
              id: 'cat-3',
              name: 'Goal 3',
              deleted: false,
              hidden: false,
              goal_type: 'TB',
              goal_target: 300000,
              balance: 100000,
              budgeted: 25000,
            },
          ],
        },
      },
    };

    it('should calculate total budgeted for goals', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.summary.total_budgeted_for_goals).toBe(175); // $100 + $50 + $25
    });

    it('should calculate average progress', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.summary.average_progress).toBeGreaterThan(0);
      expect(parsedResult.summary.average_progress).toBeLessThanOrEqual(100);
    });

    it('should identify most urgent goal', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.summary).toHaveProperty('most_urgent_goal');
      expect(typeof parsedResult.summary.most_urgent_goal).toBe('string');
    });

    it('should identify goal with most progress', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.summary).toHaveProperty('most_progress_made');
      expect(typeof parsedResult.summary.most_progress_made).toBe('string');
    });

    it('should count goals needing attention', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.summary).toHaveProperty('goals_needing_attention');
      expect(typeof parsedResult.summary.goals_needing_attention).toBe('number');
    });
  });

  describe('execute - edge cases', () => {
    it('should handle month with no goals', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'No Goal',
                deleted: false,
                hidden: false,
                balance: 100000,
                budgeted: 50000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.total_goals).toBe(0);
      expect(parsedResult.goal_progress).toHaveLength(0);
    });

    it('should filter out deleted categories', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-active',
                name: 'Active Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 500000,
                budgeted: 100000,
              },
              {
                id: 'cat-deleted',
                name: 'Deleted Goal',
                deleted: true,
                hidden: false,
                goal_type: 'TB',
                goal_target: 500000,
                balance: 250000,
                budgeted: 50000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.total_goals).toBe(1);
      const hasDeletedGoal = parsedResult.goal_progress.some(
        (g: any) => g.category_name === 'Deleted Goal'
      );
      expect(hasDeletedGoal).toBe(false);
    });

    it('should filter out hidden categories', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-visible',
                name: 'Visible Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 500000,
                budgeted: 100000,
              },
              {
                id: 'cat-hidden',
                name: 'Hidden Goal',
                deleted: false,
                hidden: true,
                goal_type: 'TB',
                goal_target: 500000,
                balance: 250000,
                budgeted: 50000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.total_goals).toBe(1);
    });

    it('should filter out Inflow and Uncategorized categories', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-inflow',
                name: 'Inflow: Ready to Assign',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 500000,
                budgeted: 100000,
              },
              {
                id: 'cat-uncat',
                name: 'Uncategorized',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 500000,
                balance: 250000,
                budgeted: 50000,
              },
              {
                id: 'cat-normal',
                name: 'Normal Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 300000,
                balance: 150000,
                budgeted: 30000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.total_goals).toBe(1); // Only Normal Goal
    });

    it('should default to current month when not specified', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      expect(mockApi.months.getBudgetMonth).toHaveBeenCalled();
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('report_month');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new GoalProgressReportTool();

      const result = await tool.execute({
        month: '2024-01-01',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API errors gracefully', async () => {
      mockApi.months.getBudgetMonth.mockRejectedValue(new Error('API Error'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error generating goal progress report');
    });

    it('should return markdown format when requested', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Test Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 1000000,
                balance: 500000,
                budgeted: 100000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Goal Progress Report');
      expect(result.content[0].text).toContain('## Summary');
    });

    it('should handle goals with zero target', async () => {
      const mockData = {
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-zero',
                name: 'Zero Target Goal',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 0,
                balance: 100000,
                budgeted: 50000,
              },
            ],
          },
        },
      };

      mockApi.months.getBudgetMonth.mockResolvedValue(mockData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-01-01',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      // Should handle gracefully without errors
      expect(parsedResult).toHaveProperty('goal_progress');
    });
  });
});
