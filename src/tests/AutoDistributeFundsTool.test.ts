import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import AutoDistributeFundsTool from '../tools/AutoDistributeFundsTool';

vi.mock('ynab');

describe('AutoDistributeFundsTool', () => {
  let tool: AutoDistributeFundsTool;
  let mockApi: {
    months: {
      getBudgetMonth: Mock;
    };
    categories: {
      updateMonthCategory: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      months: {
        getBudgetMonth: vi.fn(),
      },
      categories: {
        updateMonthCategory: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new AutoDistributeFundsTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_auto_distribute_funds');
      expect(toolDef.description).toContain('allocate');
      expect(toolDef.description).toContain('Ready to Assign');
    });

    it('should have correct input schema with all properties', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('month');
      expect(toolDef.inputSchema.properties).toHaveProperty('strategy');
      expect(toolDef.inputSchema.properties).toHaveProperty('maxAmount');
      expect(toolDef.inputSchema.properties).toHaveProperty('dryRun');
    });

    it('should have strategy enum with correct values', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.strategy.enum).toEqual([
        'goals-first',
        'proportional',
        'custom',
      ]);
    });
  });

  describe('execute - goals-first strategy', () => {
    const mockMonthDataWithGoals = {
      month: '2024-01-01',
      to_be_budgeted: 500000, // $500 available
      categories: [
        {
          id: 'cat-goal-1',
          name: 'Emergency Fund',
          balance: 100000,
          budgeted: 100000,
          activity: 0,
          deleted: false,
          hidden: false,
          category_group_name: 'Savings',
          goal_type: 'TB',
          goal_target: 500000, // $500 goal
          goal_under_funded: 400000, // $400 under funded
        },
        {
          id: 'cat-goal-2',
          name: 'Vacation',
          balance: 50000,
          budgeted: 50000,
          activity: 0,
          deleted: false,
          hidden: false,
          category_group_name: 'Fun',
          goal_type: 'TBD',
          goal_target: 200000, // $200 goal
          goal_under_funded: 150000, // $150 under funded
          goal_target_month: '2024-12-01',
        },
        {
          id: 'cat-no-goal',
          name: 'Groceries',
          balance: 0,
          budgeted: 0,
          activity: 0,
          deleted: false,
          hidden: false,
          category_group_name: 'Food',
        },
      ],
    };

    it('should distribute funds based on goals-first strategy', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthDataWithGoals },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('distributionPlan');
      expect(parsedResult.distributionPlan).toHaveLength(2); // Two categories with goals
      expect(parsedResult.totalDistributed).toBe(500); // Full $500 distributed
    });

    it('should prioritize TBD over TB goals', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthDataWithGoals },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      // Vacation (TBD) should be first as TBD has higher priority than TB
      expect(parsedResult.distributionPlan[0].category).toBe('Vacation');
    });

    it('should execute distribution when not in dry run', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthDataWithGoals },
      });
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        dryRun: false,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalled();

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.executedDistributions).toHaveLength(2);
      expect(parsedResult.executedDistributions.every((d: any) => d.status === 'success')).toBe(
        true
      );
    });

    it('should not execute distribution in dry run mode', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthDataWithGoals },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        dryRun: true,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.dryRun).toBe(true);
      expect(parsedResult.executedDistributions).toHaveLength(0);
    });
  });

  describe('execute - proportional strategy', () => {
    const mockMonthDataProportional = {
      month: '2024-01-01',
      to_be_budgeted: 300000, // $300 available
      categories: [
        {
          id: 'cat-1',
          name: 'Category A',
          balance: 0,
          budgeted: 100000, // $100
          activity: 0,
          deleted: false,
          hidden: false,
          category_group_name: 'Group 1',
        },
        {
          id: 'cat-2',
          name: 'Category B',
          balance: 0,
          budgeted: 200000, // $200
          activity: 0,
          deleted: false,
          hidden: false,
          category_group_name: 'Group 2',
        },
      ],
    };

    it('should distribute proportionally based on current budgeted amounts', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthDataProportional },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'proportional',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.distributionPlan).toHaveLength(2);

      // Category B should get more (66.67%) than Category A (33.33%)
      const catADistribution = parsedResult.distributionPlan.find(
        (p: any) => p.category === 'Category A'
      );
      const catBDistribution = parsedResult.distributionPlan.find(
        (p: any) => p.category === 'Category B'
      );

      expect(catBDistribution.proposedAmount).toBeGreaterThan(catADistribution.proposedAmount);
    });
  });

  describe('execute - custom strategy', () => {
    it('should use custom strategy logic', async () => {
      const mockMonthData = {
        month: '2024-01-01',
        to_be_budgeted: 500000,
        categories: [
          {
            id: 'cat-1',
            name: 'Category',
            balance: 0,
            budgeted: 100000,
            activity: 0,
            deleted: false,
            hidden: false,
            category_group_name: 'Operating Expenses',
          },
        ],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'custom',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.strategy).toBe('custom');
      expect(parsedResult.distributionPlan).toHaveLength(1);
    });
  });

  describe('execute - edge cases', () => {
    it('should handle no available funds', async () => {
      const noFundsData = {
        month: '2024-01-01',
        to_be_budgeted: 0,
        categories: [],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: noFundsData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.message).toContain('No funds available');
    });

    it('should respect maxAmount parameter', async () => {
      const mockMonthData = {
        month: '2024-01-01',
        to_be_budgeted: 500000, // $500 available
        categories: [
          {
            id: 'cat-1',
            name: 'Category',
            balance: 0,
            budgeted: 0,
            activity: 0,
            deleted: false,
            hidden: false,
            category_group_name: 'Group',
            goal_type: 'TB',
            goal_target: 500000,
            goal_under_funded: 500000,
          },
        ],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        maxAmount: 100, // Limit to $100
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.amountToDistribute).toBe(100);
      expect(parsedResult.totalDistributed).toBe(100);
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new AutoDistributeFundsTool();

      const result = await tool.execute({
        month: 'current',
        strategy: 'goals-first',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API errors', async () => {
      const apiError = new Error('API Error: Connection failed');
      mockApi.months.getBudgetMonth.mockRejectedValue(apiError);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error auto-distributing funds');
    });

    it('should handle update errors gracefully', async () => {
      const mockMonthData = {
        month: '2024-01-01',
        to_be_budgeted: 100000,
        categories: [
          {
            id: 'cat-1',
            name: 'Category',
            balance: 0,
            budgeted: 0,
            activity: 0,
            deleted: false,
            hidden: false,
            category_group_name: 'Group',
            goal_type: 'TB',
            goal_target: 100000,
            goal_under_funded: 100000,
          },
        ],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockRejectedValue(new Error('Update failed'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.executedDistributions).toHaveLength(1);
      expect(parsedResult.executedDistributions[0].status).toBe('failed');
    });

    it('should return markdown format when requested', async () => {
      const mockMonthData = {
        month: '2024-01-01',
        to_be_budgeted: 100000,
        categories: [
          {
            id: 'cat-1',
            name: 'Category',
            balance: 0,
            budgeted: 0,
            activity: 0,
            deleted: false,
            hidden: false,
            category_group_name: 'Group',
            goal_type: 'TB',
            goal_target: 100000,
            goal_under_funded: 100000,
          },
        ],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Auto Distribute Funds Report');
      expect(result.content[0].text).toContain('## Summary');
      expect(result.content[0].text).toContain('## Distribution Plan');
    });

    it('should handle no suitable categories', async () => {
      const mockMonthData = {
        month: '2024-01-01',
        to_be_budgeted: 100000,
        categories: [
          {
            id: 'cat-hidden',
            name: 'Hidden',
            balance: 0,
            budgeted: 0,
            activity: 0,
            deleted: false,
            hidden: true,
            category_group_name: 'Internal Master Category',
          },
        ],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'goals-first',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.message).toContain('No suitable categories');
    });
  });
});
