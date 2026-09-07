import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as MoveMoneyTool from '../tools/MoveMoneyTool';

describe('MoveMoneyTool', () => {
  let mockApi: {
    categories: {
      getMonthCategoryById: Mock;
      updateMonthCategory: Mock;
    };
  };

  const source = { id: 'cat-from', name: 'Dining Out', budgeted: 100000, balance: 40000 };
  const destination = { id: 'cat-to', name: 'Groceries', budgeted: 50000, balance: -25000 };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      categories: {
        getMonthCategoryById: vi.fn(async (_budgetId: string, _month: string, categoryId: string) => ({
          data: { category: categoryId === source.id ? { ...source } : { ...destination } },
        })),
        updateMonthCategory: vi.fn(async (_b: string, _m: string, categoryId: string, body: any) => ({
          data: {
            category: {
              ...(categoryId === source.id ? source : destination),
              budgeted: body.category.budgeted,
              balance: (categoryId === source.id ? source : destination).balance +
                (body.category.budgeted - (categoryId === source.id ? source : destination).budgeted),
            },
          },
        })),
      },
    };

    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  const move = (overrides = {}) =>
    MoveMoneyTool.execute(
      { fromCategoryId: 'cat-from', toCategoryId: 'cat-to', amount: 25, ...overrides },
      mockApi as any
    );

  describe('execute', () => {
    it('takes from the source and gives to the destination', async () => {
      const result = await move();
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.moved).toBe(true);
      expect(response.amount).toBe(25);
      expect(response.from.name).toBe('Dining Out');
      expect(response.to.name).toBe('Groceries');

      // $100.00 - $25.00 taken from the source, $50.00 + $25.00 given to the destination.
      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledTimes(2);
      expect(mockApi.categories.updateMonthCategory.mock.calls[0][2]).toBe('cat-from');
      expect(mockApi.categories.updateMonthCategory.mock.calls[0][3]).toEqual({
        category: { budgeted: 75000 },
      });
      expect(mockApi.categories.updateMonthCategory.mock.calls[1][2]).toBe('cat-to');
      expect(mockApi.categories.updateMonthCategory.mock.calls[1][3]).toEqual({
        category: { budgeted: 75000 },
      });
    });

    it('defaults to the current month and honours an explicit one', async () => {
      await move();
      expect(mockApi.categories.getMonthCategoryById).toHaveBeenCalledWith(
        'test-budget-id', 'current', 'cat-from'
      );

      await move({ month: '2024-03-01' });
      expect(mockApi.categories.updateMonthCategory).toHaveBeenLastCalledWith(
        'test-budget-id', '2024-03-01', 'cat-to', expect.anything()
      );
    });

    it('refuses to move money to the same category', async () => {
      const result = await move({ toCategoryId: 'cat-from' });
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('must be different');
      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();
    });

    it('changes nothing when the source cannot be read', async () => {
      mockApi.categories.getMonthCategoryById.mockRejectedValue(new Error('Category not found'));

      const result = await move();
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.moved).toBe(false);
      expect(response.error).toContain('Category not found');
      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();
    });

    it('changes nothing when the first write fails', async () => {
      mockApi.categories.updateMonthCategory.mockRejectedValueOnce(new Error('rate limited'));

      const result = await move();
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.moved).toBe(false);
      expect(response.note).toBe('Nothing was changed.');
      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledTimes(1);
    });

    it('reports a partial move and how to undo it when the second write fails', async () => {
      mockApi.categories.updateMonthCategory
        .mockResolvedValueOnce({ data: { category: { ...source, budgeted: 75000 } } })
        .mockRejectedValueOnce(new Error('server error'));

      const result = await move();
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.moved).toBe(false);
      expect(response.partial).toBe(true);
      expect(response.message).toContain('removed from Dining Out');
      expect(response.message).toContain('Ready to Assign');
      // The recovery hint must name the original budgeted amount, not the new one.
      expect(response.recovery).toContain('$100.00');
      expect(response.recovery).toContain('cat-from');
    });

    it('returns an error when no budget ID is available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await move();
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });
  });

  describe('tool configuration', () => {
    it('has the expected name and schema', () => {
      expect(MoveMoneyTool.name).toBe('ynab_move_money');
      expect(MoveMoneyTool.inputSchema).toHaveProperty('fromCategoryId');
      expect(MoveMoneyTool.inputSchema).toHaveProperty('toCategoryId');
      expect(MoveMoneyTool.inputSchema).toHaveProperty('amount');
    });
  });
});
