import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListCategoriesTool from '../tools/ListCategoriesTool';

vi.mock('ynab');

describe('ListCategoriesTool', () => {
  let mockApi: {
    categories: {
      getCategories: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      categories: {
        getCategories: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockCategoryGroupsData = {
      data: {
        category_groups: [
          {
            id: 'group-1',
            name: 'Monthly Bills',
            hidden: false,
            deleted: false,
            categories: [
              {
                id: 'cat-1',
                name: 'Rent',
                hidden: false,
                deleted: false,
                budgeted: 1500000,
                activity: -1500000,
                balance: 0,
                goal_type: 'TB',
                goal_target: 1500000,
                goal_percentage_complete: 100,
              },
              {
                id: 'cat-2',
                name: 'Utilities',
                hidden: false,
                deleted: false,
                budgeted: 200000,
                activity: -150000,
                balance: 50000,
                goal_type: null,
                goal_target: null,
                goal_percentage_complete: null,
              },
            ],
          },
          {
            id: 'group-2',
            name: 'Everyday Expenses',
            hidden: false,
            deleted: false,
            categories: [
              {
                id: 'cat-3',
                name: 'Groceries',
                hidden: false,
                deleted: false,
                budgeted: 600000,
                activity: -400000,
                balance: 200000,
                goal_type: 'NEED',
                goal_target: 600000,
                goal_percentage_complete: 100,
              },
            ],
          },
          {
            id: 'group-hidden',
            name: 'Hidden Group',
            hidden: true,
            deleted: false,
            categories: [],
          },
          {
            id: 'group-deleted',
            name: 'Deleted Group',
            hidden: false,
            deleted: true,
            categories: [],
          },
        ],
      },
    };

    it('should successfully list all categories', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoryGroupsData);

      const result = await ListCategoriesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id');

      const response = JSON.parse(result.content[0].text);
      expect(response.group_count).toBe(2); // Excludes hidden and deleted
      expect(response.category_count).toBe(3);
    });

    it('should filter out hidden and deleted groups', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoryGroupsData);

      const result = await ListCategoriesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const groupNames = response.category_groups.map((g: any) => g.name);
      expect(groupNames).not.toContain('Hidden Group');
      expect(groupNames).not.toContain('Deleted Group');
    });

    it('should format amounts correctly', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoryGroupsData);

      const result = await ListCategoriesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const rentCategory = response.category_groups[0].categories[0];
      expect(rentCategory.budgeted).toBe('1500.00');
      expect(rentCategory.activity).toBe('-1500.00');
      expect(rentCategory.balance).toBe('0.00');
    });

    it('should include goal information', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoryGroupsData);

      const result = await ListCategoriesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const rentCategory = response.category_groups[0].categories[0];
      expect(rentCategory.goal_type).toBe('TB');
      expect(rentCategory.goal_target).toBe('1500.00');
      expect(rentCategory.goal_percentage_complete).toBe(100);
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoryGroupsData);

      await ListCategoriesTool.execute({}, mockApi as any);

      expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id');
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListCategoriesTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.categories.getCategories.mockRejectedValue(new Error('API Error'));

      const result = await ListCategoriesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle empty category groups', async () => {
      mockApi.categories.getCategories.mockResolvedValue({
        data: { category_groups: [] },
      });

      const result = await ListCategoriesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.group_count).toBe(0);
      expect(response.category_count).toBe(0);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListCategoriesTool.name).toBe('ynab_list_categories');
      expect(ListCategoriesTool.description).toContain('Lists all categories');
    });

    it('should have optional budgetId in input schema', () => {
      expect(ListCategoriesTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});
