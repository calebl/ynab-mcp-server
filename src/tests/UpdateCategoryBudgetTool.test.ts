import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as UpdateCategoryBudgetTool from '../tools/UpdateCategoryBudgetTool';

vi.mock('ynab');

describe('UpdateCategoryBudgetTool', () => {
  let mockApi: {
    categories: {
      updateMonthCategory: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      categories: {
        updateMonthCategory: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockCategoryResponse = {
      data: {
        category: {
          id: 'category-1',
          name: 'Groceries',
          budgeted: 500000, // $500.00 in milliunits
          activity: -150000, // -$150.00
          balance: 350000, // $350.00
        },
      },
    };

    it('should successfully update category budget', async () => {
      mockApi.categories.updateMonthCategory.mockResolvedValue(mockCategoryResponse);

      const result = await UpdateCategoryBudgetTool.execute(
        {
          budgetId: 'test-budget-id',
          month: '2024-01-01',
          categoryId: 'category-1',
          budgeted: 500.00,
        },
        mockApi as any
      );

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledWith(
        'test-budget-id',
        '2024-01-01',
        'category-1',
        { category: { budgeted: 500000 } }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.category.name).toBe('Groceries');
      expect(response.category.budgeted).toBe('500.00');
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.categories.updateMonthCategory.mockResolvedValue(mockCategoryResponse);

      await UpdateCategoryBudgetTool.execute(
        {
          month: '2024-01-01',
          categoryId: 'category-1',
          budgeted: 500.00,
        },
        mockApi as any
      );

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledWith(
        'test-budget-id',
        '2024-01-01',
        'category-1',
        expect.any(Object)
      );
    });

    it('should handle decimal amounts correctly', async () => {
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: {
          category: {
            id: 'category-1',
            name: 'Groceries',
            budgeted: 123450,
            activity: 0,
            balance: 123450,
          },
        },
      });

      await UpdateCategoryBudgetTool.execute(
        {
          budgetId: 'test-budget-id',
          month: '2024-01-01',
          categoryId: 'category-1',
          budgeted: 123.45,
        },
        mockApi as any
      );

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledWith(
        'test-budget-id',
        '2024-01-01',
        'category-1',
        { category: { budgeted: 123450 } }
      );
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await UpdateCategoryBudgetTool.execute(
        {
          month: '2024-01-01',
          categoryId: 'category-1',
          budgeted: 500.00,
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.categories.updateMonthCategory.mockRejectedValue(new Error('API Error'));

      const result = await UpdateCategoryBudgetTool.execute(
        {
          budgetId: 'test-budget-id',
          month: '2024-01-01',
          categoryId: 'category-1',
          budgeted: 500.00,
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle missing category in response', async () => {
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: null },
      });

      const result = await UpdateCategoryBudgetTool.execute(
        {
          budgetId: 'test-budget-id',
          month: '2024-01-01',
          categoryId: 'category-1',
          budgeted: 500.00,
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to update category');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(UpdateCategoryBudgetTool.name).toBe('ynab_update_category_budget');
      expect(UpdateCategoryBudgetTool.description).toContain('budgeted amount');
    });

    it('should have required input schema fields', () => {
      expect(UpdateCategoryBudgetTool.inputSchema).toHaveProperty('budgetId');
      expect(UpdateCategoryBudgetTool.inputSchema).toHaveProperty('month');
      expect(UpdateCategoryBudgetTool.inputSchema).toHaveProperty('categoryId');
      expect(UpdateCategoryBudgetTool.inputSchema).toHaveProperty('budgeted');
    });
  });
});
