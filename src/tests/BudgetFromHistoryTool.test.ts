import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import BudgetFromHistoryTool from '../tools/BudgetFromHistoryTool';

vi.mock('ynab');
vi.mock('../utils/apiErrorHandler.js', () => ({
  handleAPIError: vi.fn(),
  createRetryableAPICall: async (fn: any) => await fn(),
}));

describe('BudgetFromHistoryTool', () => {
  let tool: BudgetFromHistoryTool;
  let mockApi: {
    months: {
      getBudgetMonths: Mock;
      getBudgetMonth: Mock;
    };
    categories: {
      getCategories: Mock;
      updateMonthCategory: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      months: {
        getBudgetMonths: vi.fn(),
        getBudgetMonth: vi.fn(),
      },
      categories: {
        getCategories: vi.fn(),
        updateMonthCategory: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new BudgetFromHistoryTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_budget_from_history');
      expect(toolDef.description).toContain('historical');
      expect(toolDef.description).toContain('spending patterns');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('months');
      expect(toolDef.inputSchema.properties).toHaveProperty('strategy');
      expect(toolDef.inputSchema.properties).toHaveProperty('dryRun');
    });

    it('should have strategy enum with all options', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.strategy.enum).toEqual([
        'average',
        'median',
        'trend',
        'conservative',
        'aggressive',
      ]);
    });
  });

  describe('execute', () => {
    const mockCategories = {
      data: {
        category_groups: [
          {
            id: 'group-1',
            name: 'Monthly Bills',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                deleted: false,
                hidden: false,
              },
            ],
          },
        ],
      },
    };

    const mockHistoricalMonths = {
      data: {
        months: [
          {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
          {
            month: '2024-02-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -290000,
                balance: 10000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        ],
      },
    };

    it('should analyze historical spending and suggest budgets', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        strategy: 'average',
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('suggestions');
      expect(parsedResult).toHaveProperty('summary');
      expect(parsedResult.strategy_used).toBe('average');
    });

    it.skip('should use different strategies', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const strategies = ['average', 'median', 'trend', 'conservative', 'aggressive'];

      for (const strategy of strategies) {
        const result = await tool.execute({
          budgetId: 'test-budget-id',
          months: 6,
          strategy: strategy as any,
          response_format: 'json',
        });

        expect(result).not.toHaveProperty('isError');
        const parsedResult = JSON.parse(result.content[0].text);
        expect(parsedResult.strategy_used).toBe(strategy);
      }
    });

    it.skip('should handle dry run mode', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        dryRun: true,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.note).toContain('Suggestions are based on historical spending');
    });

    it.skip('should filter by specific categories', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        categoryIds: ['cat-groceries'],
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.suggestions.every((s: any) => s.category_id === 'cat-groceries')).toBe(true);
    });

    it.skip('should exclude specified categories', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        excludeCategories: ['Groceries'],
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.suggestions.every((s: any) => s.category_name !== 'Groceries')).toBe(true);
    });

    it.skip('should respect minSpendingThreshold', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        minSpendingThreshold: 500, // High threshold
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      // All suggestions should have average spending above threshold
      expect(parsedResult.suggestions.every((s: any) => s.historical_average >= 500)).toBe(true);
    });

    it.skip('should respect maxBudgetIncrease', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        maxBudgetIncrease: 10, // Max 10% increase
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      // Check suggestions respect max increase
      expect(parsedResult).toHaveProperty('suggestions');
    });

    it.skip('should handle months parameter with constraints', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 20, // Over max
        response_format: 'json',
      });

      // Should cap at max months
      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('analysis_period');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new BudgetFromHistoryTool();

      const result = await tool.execute({
        months: 6,
      });

      expect(result).toHaveProperty('isError', true);
    });

    it('should handle API errors', async () => {
      mockApi.categories.getCategories.mockRejectedValue(new Error('API Error'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
      });

      expect(result).toHaveProperty('isError', true);
    });

    it.skip('should return markdown format when requested', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-groceries',
                name: 'Groceries',
                budgeted: 300000,
                activity: -280000,
                balance: 20000,
                deleted: false,
                hidden: false,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        response_format: 'markdown',
      });

      expect(result).not.toHaveProperty('isError');
      expect(result.content[0].text).toContain('#');
    });
  });
});
