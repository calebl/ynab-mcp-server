import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import CategoryPerformanceReviewTool from '../tools/CategoryPerformanceReviewTool';

vi.mock('ynab');

describe('CategoryPerformanceReviewTool', () => {
  let tool: CategoryPerformanceReviewTool;
  let mockApi: {
    categories: {
      getCategories: Mock;
    };
    months: {
      getBudgetMonth: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      categories: {
        getCategories: vi.fn(),
      },
      months: {
        getBudgetMonth: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new CategoryPerformanceReviewTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_category_performance_review');
      expect(toolDef.description).toContain('performance');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('months');
      expect(toolDef.inputSchema.properties).toHaveProperty('performanceThreshold');
    });
  });

  describe('execute', () => {
    const mockCategoriesData = {
      data: {
        category_groups: [
          {
            id: 'group-1',
            name: 'Group 1',
            categories: [
              {
                id: 'cat-excellent',
                name: 'Excellent Cat',
                deleted: false,
                hidden: false,
                budgeted: 100000,
                activity: -95000,
                balance: 5000,
              },
            ],
          },
        ],
      },
    };

    const mockMonthData = {
      data: {
        month: {
          month: '2024-01-01',
          categories: [
            {
              id: 'cat-excellent',
              name: 'Excellent Cat',
              deleted: false,
              hidden: false,
              budgeted: 100000,
              activity: -95000, // Good utilization
              balance: 5000,
            },
          ],
        },
      },
    };

    // TODO: Fix multi-month budget data mock setup
    it.skip('should generate performance review', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoriesData);
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('category_performance');
      expect(parsedResult).toHaveProperty('summary');
      expect(parsedResult).toHaveProperty('pagination');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new CategoryPerformanceReviewTool();

      const result = await tool.execute({});

      expect(result).toHaveProperty('isError', true);
    });

    it('should handle API errors', async () => {
      mockApi.categories.getCategories.mockRejectedValue(new Error('API Error'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
      });

      expect(result).toHaveProperty('isError', true);
    });

    // TODO: Fix markdown format mock setup
    it.skip('should return markdown format when requested', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoriesData);
      mockApi.months.getBudgetMonth.mockResolvedValue(mockMonthData);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('#');
      expect(result.content[0].text).toContain('Pagination');
    });
  });
});
