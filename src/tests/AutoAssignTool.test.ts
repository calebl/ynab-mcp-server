import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as AutoAssignTool from '../tools/AutoAssignTool';

describe('AutoAssignTool', () => {
  let mockApi: {
    months: { getBudgetMonth: Mock };
    categories: { updateMonthCategory: Mock };
  };

  const categories = [
    // $30.00 short, budgeted $20.00 so far.
    { id: 'cat-rent', name: 'Rent', deleted: false, hidden: false, budgeted: 20000, goal_under_funded: 30000 },
    // $80.00 short - the biggest shortfall, so it should be funded first.
    { id: 'cat-car', name: 'Car Payment', deleted: false, hidden: false, budgeted: 0, goal_under_funded: 80000 },
    // Fully funded, so it should be skipped.
    { id: 'cat-gas', name: 'Gas', deleted: false, hidden: false, budgeted: 50000, goal_under_funded: 0 },
    // Hidden, so it should be skipped even though it is short.
    { id: 'cat-old', name: 'Old Goal', deleted: false, hidden: true, budgeted: 0, goal_under_funded: 10000 },
  ];

  const monthWith = (toBeBudgeted: number) => ({
    data: { month: { month: '2024-03-01', to_be_budgeted: toBeBudgeted, categories } },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      months: { getBudgetMonth: vi.fn().mockResolvedValue(monthWith(100000)) },
      categories: {
        updateMonthCategory: vi.fn().mockResolvedValue({ data: { category: { id: 'x', name: 'x', budgeted: 0 } } }),
      },
    };

    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('funds the largest shortfall first and stops when the money runs out', async () => {
      // $100.00 available: Car Payment takes $80.00, Rent gets the last $20.00.
      const result = await AutoAssignTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.total_assigned).toBe(100);
      expect(response.remaining_after).toBe(0);
      expect(response.assignments).toHaveLength(2);

      expect(response.assignments[0].name).toBe('Car Payment');
      expect(response.assignments[0].assign).toBe(80);
      expect(response.assignments[0].shortfallRemaining).toBe(0);

      expect(response.assignments[1].name).toBe('Rent');
      expect(response.assignments[1].assign).toBe(20);
      // $30.00 short, only $20.00 available, so $10.00 is still needed.
      expect(response.assignments[1].shortfallRemaining).toBe(10);
    });

    it('writes the new total budgeted amount, not the increment', async () => {
      await AutoAssignTool.execute({}, mockApi as any);

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledTimes(2);
      // Car Payment: $0.00 + $80.00
      expect(mockApi.categories.updateMonthCategory.mock.calls[0][3]).toEqual({
        category: { budgeted: 80000 },
      });
      // Rent: $20.00 already budgeted + $20.00 assigned
      expect(mockApi.categories.updateMonthCategory.mock.calls[1][3]).toEqual({
        category: { budgeted: 40000 },
      });
    });

    it('skips fully funded and hidden categories', async () => {
      const result = await AutoAssignTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);
      const funded = response.assignments.map((a: any) => a.name);

      expect(funded).not.toContain('Gas');
      expect(funded).not.toContain('Old Goal');
    });

    it('writes nothing on a dry run', async () => {
      const result = await AutoAssignTool.execute({ dryRun: true }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.dry_run).toBe(true);
      expect(response.total_to_assign).toBe(100);
      expect(response.assignments).toHaveLength(2);
      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();
    });

    it('never exposes internal milliunit bookkeeping', async () => {
      const result = await AutoAssignTool.execute({ dryRun: true }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.assignments[0]).not.toHaveProperty('newBudgetedMilliunits');
    });

    it('respects maxTotal', async () => {
      const result = await AutoAssignTool.execute({ maxTotal: 50 }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.total_assigned).toBe(50);
      expect(response.assignments).toHaveLength(1);
      expect(response.assignments[0].name).toBe('Car Payment');
      expect(response.assignments[0].shortfallRemaining).toBe(30);
    });

    it('does nothing when Ready to Assign is not positive', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue(monthWith(0));

      const result = await AutoAssignTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.assignments).toEqual([]);
      expect(response.message).toContain('not positive');
      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();
    });

    it('does nothing when no category has an unmet goal', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: { month: '2024-03-01', to_be_budgeted: 100000, categories: [categories[2]] } },
      });

      const result = await AutoAssignTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.message).toContain('no category has an unmet monthly goal');
      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();
    });

    it('reports what landed when a write fails part-way through', async () => {
      mockApi.categories.updateMonthCategory
        .mockResolvedValueOnce({ data: { category: {} } })
        .mockRejectedValueOnce(new Error('server error'));

      const result = await AutoAssignTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.partial).toBe(true);
      expect(response.total_assigned).toBe(80);
      expect(response.assigned.map((a: any) => a.name)).toEqual(['Car Payment']);
      expect(response.not_assigned.map((a: any) => a.name)).toEqual(['Rent']);
      expect(response.message).toContain('before failing on Rent');
    });

    it('returns an error when no budget ID is available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await AutoAssignTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });
  });

  describe('tool configuration', () => {
    it('has the expected name and schema', () => {
      expect(AutoAssignTool.name).toBe('ynab_auto_assign');
      expect(AutoAssignTool.inputSchema).toHaveProperty('dryRun');
      expect(AutoAssignTool.inputSchema).toHaveProperty('maxTotal');
    });
  });
});
