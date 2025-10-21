import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import SetCategoryGoalsTool from '../tools/SetCategoryGoalsTool';

vi.mock('ynab');
vi.mock('../utils/apiErrorHandler.js', () => ({
  handleAPIError: vi.fn(),
  createRetryableAPICall: (fn: any) => fn,
}));

describe('SetCategoryGoalsTool', () => {
  let tool: SetCategoryGoalsTool;
  let mockApi: {
    categories: {
      getCategories: Mock;
      updateCategory: Mock;
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
        updateCategory: vi.fn(),
      },
      months: {
        getBudgetMonth: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new SetCategoryGoalsTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_set_category_goals');
      expect(toolDef.description).toContain('goal');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('categoryId');
      expect(toolDef.inputSchema.properties).toHaveProperty('goalType');
      expect(toolDef.inputSchema.properties).toHaveProperty('goalTarget');
    });

    it('should have goalType enum with all types', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.goalType.enum).toEqual(['TB', 'TBD', 'MF', 'NEED', 'DEBT']);
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
                id: 'cat-1',
                name: 'Savings',
                deleted: false,
                hidden: false,
                goal_type: 'TB', // Existing goal
                goal_target: 50000,
              },
            ],
          },
        ],
      },
    };

    it('should set category goal by ID', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Savings',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 50000,
                budgeted: 100000,
                balance: 100000,
                activity: 0,
              },
            ],
          },
        },
      });
      mockApi.categories.updateCategory.mockResolvedValue({
        data: {
          category: {
            id: 'cat-1',
            name: 'Savings',
            goal_type: 'TB',
            goal_target: 100000,
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        categoryId: 'cat-1',
        goalType: 'TB',
        goalTarget: 1000,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.results).toHaveLength(1);
      expect(parsedResult.results[0].category_id).toBe('cat-1');
    });

    it('should find category by name', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Savings',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 50000,
                budgeted: 100000,
                balance: 100000,
                activity: 0,
              },
            ],
          },
        },
      });
      mockApi.categories.updateCategory.mockResolvedValue({
        data: {
          category: { id: 'cat-1', name: 'Savings', goal_type: 'TB', goal_target: 100000 },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        categoryName: 'Savings',
        goalType: 'TB',
        goalTarget: 1000,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.results[0].category_name).toBe('Savings');
    });

    it('should handle dry run mode', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Savings',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 50000,
                budgeted: 100000,
                balance: 100000,
                activity: 0,
              },
            ],
          },
        },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        categoryId: 'cat-1',
        goalType: 'TB',
        goalTarget: 1000,
        dryRun: true,
        response_format: 'json',
      });

      expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('results');
    });

    it('should handle category not found', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        categoryId: 'invalid-id',
        goalType: 'TB',
        goalTarget: 1000,
      });

      expect(result.content[0].text).toContain('not found');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new SetCategoryGoalsTool();

      const result = await tool.execute({
        categoryId: 'cat-1',
        goalType: 'TB',
        goalTarget: 1000,
      });

      expect(result).toHaveProperty('isError', true);
    });

    it('should handle API errors', async () => {
      mockApi.categories.getCategories.mockRejectedValue(new Error('API Error'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        categoryId: 'cat-1',
        goalType: 'TB',
        goalTarget: 1000,
      });

      expect(result).toHaveProperty('isError', true);
    });

    it('should return markdown format when requested', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategories);
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-01-01',
            categories: [
              {
                id: 'cat-1',
                name: 'Savings',
                deleted: false,
                hidden: false,
                goal_type: 'TB',
                goal_target: 50000,
                budgeted: 100000,
                balance: 100000,
                activity: 0,
              },
            ],
          },
        },
      });
      mockApi.categories.updateCategory.mockResolvedValue({
        data: { category: { id: 'cat-1', name: 'Savings', goal_type: 'TB', goal_target: 100000 } },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        categoryId: 'cat-1',
        goalType: 'TB',
        goalTarget: 1000,
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('#');
    });
  });
});
