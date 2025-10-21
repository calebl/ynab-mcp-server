import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import HandleOverspendingTool from '../tools/HandleOverspendingTool';

vi.mock('ynab');

describe('HandleOverspendingTool', () => {
  let tool: HandleOverspendingTool;
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

    tool = new HandleOverspendingTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_handle_overspending');
      expect(toolDef.description).toContain('resolve overspent categories');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema).toHaveProperty('properties');
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('month');
      expect(toolDef.inputSchema.properties).toHaveProperty('strategy');
      expect(toolDef.inputSchema.properties).toHaveProperty('dryRun');
    });

    it('should have strategy enum with correct values', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.strategy.enum).toEqual(['auto', 'suggest']);
    });
  });

  describe('execute', () => {
    const mockMonthData = {
      month: '2024-01-01',
      categories: [
        {
          id: 'cat-overspent',
          name: 'Groceries',
          balance: -50000, // -$50.00 overspent
          budgeted: 30000,
          activity: -80000,
          deleted: false,
          hidden: false,
          category_group_name: 'Food',
        },
        {
          id: 'cat-available',
          name: 'Entertainment',
          balance: 100000, // $100.00 available
          budgeted: 150000,
          activity: -50000,
          deleted: false,
          hidden: false,
          category_group_name: 'Fun',
        },
        {
          id: 'cat-credit-card',
          name: '💳 Credit Card Payment',
          balance: 200000,
          budgeted: 200000,
          activity: 0,
          deleted: false,
          hidden: false,
          category_group_name: 'Payments',
        },
        {
          id: 'cat-hidden',
          name: 'Hidden Category',
          balance: 50000,
          budgeted: 50000,
          activity: 0,
          deleted: false,
          hidden: true,
          category_group_name: 'Other',
        },
      ],
    };

    it('should detect overspent categories in suggest mode', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'json',
      });

      expect(mockApi.months.getBudgetMonth).toHaveBeenCalled();
      expect(result).toHaveProperty('content');
      expect(result.content[0].type).toBe('text');

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('overspentCategories');
      expect(parsedResult.overspentCategories).toHaveLength(1);
      expect(parsedResult.overspentCategories[0].name).toBe('Groceries');
    });

    it('should generate move suggestions', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('suggestions');
      expect(parsedResult.suggestions).toHaveLength(1);
      expect(parsedResult.suggestions[0].fromCategory).toBe('Entertainment');
      expect(parsedResult.suggestions[0].toCategory).toBe('Groceries');
      expect(parsedResult.suggestions[0].amount).toBe(50); // $50.00
    });

    it('should exclude credit card payment categories from funding sources', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.availableFunding).toHaveLength(1);
      expect(parsedResult.availableFunding[0].name).toBe('Entertainment');
    });

    it('should execute moves in auto mode without dry run', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'auto',
        dryRun: false,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalled();

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('executedMoves');
      expect(parsedResult.executedMoves).toHaveLength(1);
      expect(parsedResult.executedMoves[0].status).toBe('success');
    });

    it('should not execute moves in dry run mode', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'auto',
        dryRun: true,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.dryRun).toBe(true);
      expect(parsedResult.executedMoves).toHaveLength(0);
    });

    it('should handle no overspent categories', async () => {
      const noOverspentData = {
        ...mockMonthData,
        categories: mockMonthData.categories.filter(cat => cat.balance >= 0),
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: noOverspentData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.message).toContain('No overspent categories found');
    });

    it('should handle no available funding sources', async () => {
      const noFundingData = {
        ...mockMonthData,
        categories: mockMonthData.categories.map(cat => ({
          ...cat,
          balance: cat.balance < 0 ? cat.balance : 0,
        })),
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: noFundingData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.message).toContain('No categories with available funds');
    });

    it('should filter by source categories when provided', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        sourceCategories: ['cat-available'],
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.availableFunding).toHaveLength(1);
      expect(parsedResult.availableFunding[0].id).toBe('cat-available');
    });

    it('should filter by target categories when provided', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        targetCategories: ['cat-overspent'],
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.suggestions).toHaveLength(1);
      expect(parsedResult.suggestions[0].toCategory).toBe('Groceries');
    });

    it('should return markdown format when requested', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Handle Overspending Report');
      expect(result.content[0].text).toContain('## Overspent Categories');
      expect(result.content[0].text).toContain('## Suggested Moves');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new HandleOverspendingTool();

      const result = await tool.execute({
        month: 'current',
        strategy: 'suggest',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API errors', async () => {
      const apiError = new Error('API Error: Unauthorized');
      mockApi.months.getBudgetMonth.mockRejectedValue(apiError);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error handling overspending');
      expect(result.content[0].text).toContain('Unauthorized');
    });

    it('should handle update errors gracefully in auto mode', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockRejectedValue(
        new Error('Update failed')
      );

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'auto',
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.executedMoves).toHaveLength(1);
      expect(parsedResult.executedMoves[0].status).toBe('failed');
      expect(parsedResult.executedMoves[0].error).toBe('Update failed');
    });

    it('should handle multiple overspent categories', async () => {
      const multipleOverspentData = {
        ...mockMonthData,
        categories: [
          ...mockMonthData.categories,
          {
            id: 'cat-overspent-2',
            name: 'Gas',
            balance: -30000,
            budgeted: 50000,
            activity: -80000,
            deleted: false,
            hidden: false,
            category_group_name: 'Transportation',
          },
        ],
      };

      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: multipleOverspentData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        strategy: 'suggest',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.overspentCategories).toHaveLength(2);
      expect(parsedResult.suggestions.length).toBeGreaterThan(0);
    });

    it('should respect month parameter with specific date', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      await tool.execute({
        budgetId: 'test-budget-id',
        month: '2024-06-01',
        strategy: 'suggest',
      });

      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith(
        'test-budget-id',
        '2024-06-01'
      );
    });
  });
});
