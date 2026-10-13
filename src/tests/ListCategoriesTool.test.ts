import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListCategoriesTool from '../tools/ListCategoriesTool';

vi.mock('ynab');

describe('ListCategoriesTool', () => {
  let mockApi: {
    categories: {
      getCategories: Mock;
    };
    months: {
      getPlanMonth: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      categories: {
        getCategories: vi.fn(),
      },
      months: {
        getPlanMonth: vi.fn(),
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

      expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id', undefined);

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
      expect(rentCategory.budgeted).toBe(1500);
      expect(rentCategory.activity).toBe(-1500);
      expect(rentCategory.balance).toBe(0);
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
      expect(rentCategory.goal_target).toBe(1500);
      expect(rentCategory.goal_percentage_complete).toBe(100);
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.categories.getCategories.mockResolvedValue(mockCategoryGroupsData);

      await ListCategoriesTool.execute({}, mockApi as any);

      expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id', undefined);
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListCategoriesTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
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

    describe('goal fields, hidden rows, month and delta sync', () => {
      const plan = {
        data: {
          server_knowledge: 77,
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
                  category_group_id: 'group-1',
                  hidden: false,
                  deleted: false,
                  budgeted: 1500000,
                  activity: -1500000,
                  balance: 0,
                  goal_type: 'TB',
                  goal_target: 1500000,
                  goal_target_date: '2026-12-01',
                  goal_needs_whole_amount: null,
                  goal_cadence: 1,
                  goal_percentage_complete: 100,
                  goal_under_funded: 250000,
                },
                {
                  id: 'cat-hidden',
                  name: 'Old Hobby',
                  category_group_id: 'group-1',
                  hidden: true,
                  deleted: false,
                  budgeted: 0,
                  activity: 0,
                  balance: 0,
                },
                {
                  id: 'cat-deleted',
                  name: 'Gone',
                  category_group_id: 'group-1',
                  hidden: false,
                  deleted: true,
                  budgeted: 0,
                  activity: 0,
                  balance: 0,
                },
              ],
            },
            {
              id: 'group-hidden',
              name: 'Hidden Group',
              hidden: true,
              deleted: false,
              categories: [
                {
                  id: 'cat-in-hidden',
                  name: 'Stashed',
                  category_group_id: 'group-hidden',
                  hidden: false,
                  deleted: false,
                  budgeted: 0,
                  activity: 0,
                  balance: 0,
                },
              ],
            },
          ],
        },
      };

      const monthResponse = (month: string) => ({
        data: {
          month: {
            month,
            categories: [
              {
                id: 'cat-1',
                name: 'Rent',
                category_group_id: 'group-1',
                hidden: false,
                deleted: false,
                budgeted: 1400000,
                activity: -1400000,
                balance: 0,
                goal_type: 'TB',
                goal_target: 1500000,
                goal_percentage_complete: 93,
                goal_under_funded: 100000,
              },
            ],
          },
        },
      });

      const allIds = (response: any) =>
        response.category_groups.flatMap((g: any) => g.categories.map((c: any) => c.id));

      it('returns new goal fields and group deleted while keeping existing field values (REQ-009)', async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);

        const result = await ListCategoriesTool.execute({}, mockApi as any);
        const response = JSON.parse(result.content[0].text);
        const group = response.category_groups[0];
        const rent = group.categories[0];

        expect(group.deleted).toBe(false);
        expect(rent.goal_under_funded).toBe(250);
        expect(rent.goal_target_date).toBe('2026-12-01');
        expect(rent.goal_cadence).toBe(1);
        expect(rent.goal_needs_whole_amount).toBeNull();
        expect(rent.category_group_id).toBe('group-1');
        expect(rent.budgeted).toBe(1500);
        expect(rent.activity).toBe(-1500);
        expect(rent.balance).toBe(0);
        expect(rent.goal_type).toBe('TB');
        expect(rent.goal_target).toBe(1500);
        expect(rent.goal_percentage_complete).toBe(100);
      });

      it('omits hidden groups and categories unless includeHidden is true (REQ-010)', async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);

        const hiddenOff = JSON.parse((await ListCategoriesTool.execute({ includeHidden: false }, mockApi as any)).content[0].text);
        expect(hiddenOff.category_groups.map((g: any) => g.id)).toEqual(['group-1']);
        expect(allIds(hiddenOff)).toEqual(['cat-1']);

        const hiddenOn = JSON.parse((await ListCategoriesTool.execute({ includeHidden: true }, mockApi as any)).content[0].text);
        expect(hiddenOn.category_groups.map((g: any) => g.id)).toEqual(['group-1', 'group-hidden']);
        expect(allIds(hiddenOn)).toEqual(['cat-1', 'cat-hidden', 'cat-in-hidden']);
        expect(hiddenOn.category_groups[1].hidden).toBe(true);
      });

      it('replaces plan values with the month values when month is given (REQ-011, NFR-004)', async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);
        mockApi.months.getPlanMonth.mockResolvedValue(monthResponse('2024-01-01'));

        const result = await ListCategoriesTool.execute({ month: '2024-01-01', includeHidden: true }, mockApi as any);
        const response = JSON.parse(result.content[0].text);

        expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', '2024-01-01');
        expect(mockApi.categories.getCategories).toHaveBeenCalledTimes(1);
        expect(mockApi.months.getPlanMonth).toHaveBeenCalledTimes(1);
        expect(response.month).toBe('2024-01-01');
        expect(response.server_knowledge).toBeUndefined();
        expect(allIds(response)).toEqual(['cat-1']);
        const rent = response.category_groups[0].categories[0];
        expect(rent.budgeted).toBe(1400);
        expect(rent.activity).toBe(-1400);
        expect(rent.goal_percentage_complete).toBe(93);
        expect(rent.goal_under_funded).toBe(100);
      });

      it("resolves month 'current' to the month YNAB returns (REQ-011)", async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);
        mockApi.months.getPlanMonth.mockResolvedValue(monthResponse('2024-01-01'));

        const result = await ListCategoriesTool.execute({ month: 'current' }, mockApi as any);
        const response = JSON.parse(result.content[0].text);

        expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', 'current');
        expect(response.month).toBe('2024-01-01');
      });

      it('rejects month combined with lastKnowledgeOfServer without calling YNAB (REQ-012)', async () => {
        const result = await ListCategoriesTool.execute({ month: '2024-01-01', lastKnowledgeOfServer: 5 }, mockApi as any);
        const response = JSON.parse(result.content[0].text);

        expect(response.success).toBe(false);
        expect(response.error).toContain('month cannot be combined with lastKnowledgeOfServer');
        expect(mockApi.categories.getCategories).not.toHaveBeenCalled();
        expect(mockApi.months.getPlanMonth).not.toHaveBeenCalled();
      });

      it('passes lastKnowledgeOfServer 0 and 42 through to YNAB (REQ-013)', async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);

        await ListCategoriesTool.execute({ lastKnowledgeOfServer: 0 }, mockApi as any);
        expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id', 0);

        await ListCategoriesTool.execute({ lastKnowledgeOfServer: 42 }, mockApi as any);
        expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id', 42);
      });

      it('returns server_knowledge (REQ-014)', async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);

        const result = await ListCategoriesTool.execute({}, mockApi as any);

        expect(JSON.parse(result.content[0].text).server_knowledge).toBe(77);
      });

      it('keeps deleted and hidden rows in delta mode (REQ-015)', async () => {
        mockApi.categories.getCategories.mockResolvedValue(plan);

        const result = await ListCategoriesTool.execute({ lastKnowledgeOfServer: 42 }, mockApi as any);
        const response = JSON.parse(result.content[0].text);
        const categories = response.category_groups.flatMap((g: any) => g.categories);

        expect(response.category_groups.map((g: any) => g.id)).toContain('group-hidden');
        expect(categories.find((c: any) => c.id === 'cat-deleted').deleted).toBe(true);
        expect(categories.find((c: any) => c.id === 'cat-hidden').hidden).toBe(true);
      });
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListCategoriesTool.name).toBe('ynab_list_categories');
      expect(ListCategoriesTool.description).toContain('Lists categories');
    });

    it('should have optional budgetId in input schema', () => {
      expect(ListCategoriesTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});
