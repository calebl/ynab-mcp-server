import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as SpendingByCategoryTool from '../tools/SpendingByCategoryTool';
import * as SpendingByPayeeTool from '../tools/SpendingByPayeeTool';
import * as CashFlowTool from '../tools/CashFlowTool';

const transactions = [
  {
    id: 't1', date: '2024-03-01', amount: -50000, deleted: false,
    category_id: 'c-groceries', category_name: 'Groceries', payee_name: 'Corner Store',
    transfer_account_id: null, subtransactions: [],
  },
  {
    id: 't2', date: '2024-03-02', amount: -25000, deleted: false,
    category_id: 'c-groceries', category_name: 'Groceries', payee_name: 'Corner Store',
    transfer_account_id: null, subtransactions: [],
  },
  {
    id: 't3', date: '2024-03-03', amount: -10000, deleted: false,
    category_id: 'c-dining', category_name: 'Dining Out', payee_name: 'Coffee Place',
    transfer_account_id: null, subtransactions: [],
  },
  // Income - not spending.
  {
    id: 't4', date: '2024-03-04', amount: 200000, deleted: false,
    category_id: null, category_name: 'Inflow: Ready to Assign', payee_name: 'Employer',
    transfer_account_id: null, subtransactions: [],
  },
  // A transfer between the user's own accounts - movement, not spending.
  {
    id: 't5', date: '2024-03-05', amount: -75000, deleted: false,
    category_id: null, category_name: null, payee_name: 'Transfer : Savings',
    transfer_account_id: 'acct-savings', subtransactions: [],
  },
  // Deleted - ignored.
  {
    id: 't6', date: '2024-03-06', amount: -99000, deleted: true,
    category_id: 'c-dining', category_name: 'Dining Out', payee_name: 'Coffee Place',
    transfer_account_id: null, subtransactions: [],
  },
  // A split: the parent amount duplicates the children, so only children count.
  {
    id: 't7', date: '2024-03-07', amount: -40000, deleted: false,
    category_id: null, category_name: null, payee_name: 'Big Box',
    transfer_account_id: null,
    subtransactions: [
      { id: 's1', amount: -30000, deleted: false, category_id: 'c-groceries', category_name: 'Groceries', payee_name: null, transfer_account_id: null },
      { id: 's2', amount: -10000, deleted: false, category_id: 'c-home', category_name: 'Home Goods', payee_name: null, transfer_account_id: null },
      { id: 's3', amount: -5000, deleted: true, category_id: 'c-home', category_name: 'Home Goods', payee_name: null, transfer_account_id: null },
    ],
  },
  // Outside the untilDate window used in one test below.
  {
    id: 't8', date: '2024-04-01', amount: -15000, deleted: false,
    category_id: 'c-dining', category_name: 'Dining Out', payee_name: 'Coffee Place',
    transfer_account_id: null, subtransactions: [],
  },
];

describe('spending reports', () => {
  let mockApi: {
    transactions: { getTransactions: Mock };
    months: { getBudgetMonths: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      transactions: { getTransactions: vi.fn().mockResolvedValue({ data: { transactions } }) },
      months: { getBudgetMonths: vi.fn() },
    };
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('SpendingByCategoryTool', () => {
    it('totals by category, biggest first, counting splits through subtransactions', async () => {
      const result = await SpendingByCategoryTool.execute({ sinceDate: '2024-03-01' }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      // Groceries: $50 + $25 + $30 (split child) = $105
      // Dining Out: $10 + $15 = $25
      // Home Goods: $10 (the deleted $5 child is ignored)
      expect(response.categories).toEqual([
        { name: 'Groceries', total: 105, transaction_count: 3, average: 35, share_of_total: 75 },
        { name: 'Dining Out', total: 25, transaction_count: 2, average: 12.5, share_of_total: 17.86 },
        { name: 'Home Goods', total: 10, transaction_count: 1, average: 10, share_of_total: 7.14 },
      ]);
      expect(response.total_spent).toBe(140);
    });

    it('excludes income, transfers and deleted transactions', async () => {
      const result = await SpendingByCategoryTool.execute({ sinceDate: '2024-03-01' }, mockApi as any);
      const response = JSON.parse(result.content[0].text);
      const names = response.categories.map((c: any) => c.name);

      expect(names).not.toContain('Inflow: Ready to Assign');
      // The $75 transfer and the deleted $99 would both be obvious in the total.
      expect(response.total_spent).toBe(140);
    });

    it('honours untilDate', async () => {
      const result = await SpendingByCategoryTool.execute(
        { sinceDate: '2024-03-01', untilDate: '2024-03-31' },
        mockApi as any
      );
      const response = JSON.parse(result.content[0].text);

      // The April coffee is dropped, so Dining Out falls to $10.
      expect(response.total_spent).toBe(125);
      expect(response.categories.find((c: any) => c.name === 'Dining Out').total).toBe(10);
    });

    it('defaults sinceDate to 30 days ago', async () => {
      await SpendingByCategoryTool.execute({}, mockApi as any);

      const [, sinceDate] = mockApi.transactions.getTransactions.mock.calls[0];
      expect(sinceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const daysBack = (Date.now() - Date.parse(sinceDate)) / 86400000;
      expect(daysBack).toBeGreaterThan(29);
      expect(daysBack).toBeLessThan(31);
    });

    it('applies a limit', async () => {
      const result = await SpendingByCategoryTool.execute(
        { sinceDate: '2024-03-01', limit: 1 },
        mockApi as any
      );
      const response = JSON.parse(result.content[0].text);

      expect(response.categories).toHaveLength(1);
      // The full count is still reported even though the list is truncated.
      expect(response.category_count).toBe(3);
    });

    it('handles an empty budget', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [] } });

      const result = await SpendingByCategoryTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.categories).toEqual([]);
      expect(response.total_spent).toBe(0);
    });

    it('reports API errors', async () => {
      mockApi.transactions.getTransactions.mockRejectedValue(new Error('Unauthorized'));

      const result = await SpendingByCategoryTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unauthorized');
    });
  });

  describe('SpendingByPayeeTool', () => {
    it('totals by payee, inheriting the parent payee for split children', async () => {
      const result = await SpendingByPayeeTool.execute({ sinceDate: '2024-03-01' }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.payees).toEqual([
        { name: 'Corner Store', total: 75, transaction_count: 2, average: 37.5, share_of_total: 53.57 },
        { name: 'Big Box', total: 40, transaction_count: 2, average: 20, share_of_total: 28.57 },
        { name: 'Coffee Place', total: 25, transaction_count: 2, average: 12.5, share_of_total: 17.86 },
      ]);
      expect(response.payee_count).toBe(3);
    });
  });

  describe('CashFlowTool', () => {
    const months = [
      { month: '2024-01-01', income: 500000, activity: -400000, budgeted: 450000, deleted: false },
      { month: '2024-02-01', income: 500000, activity: -600000, budgeted: 500000, deleted: false },
      { month: '2024-03-01', income: 550000, activity: -450000, budgeted: 500000, deleted: false },
      { month: '2023-12-01', income: 1000, activity: -1000, budgeted: 0, deleted: true },
    ];

    beforeEach(() => {
      mockApi.months.getBudgetMonths.mockResolvedValue({ data: { months } });
    });

    it('reports income, spending and net per month, oldest first', async () => {
      const result = await CashFlowTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.months.map((m: any) => m.month)).toEqual([
        '2024-01-01', '2024-02-01', '2024-03-01',
      ]);
      expect(response.months[0]).toEqual({
        month: '2024-01-01', income: 500, spent: 400, net: 100, budgeted: 450,
      });
      // February ran a deficit.
      expect(response.months[1].net).toBe(-100);
    });

    it('totals across the window', async () => {
      const result = await CashFlowTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.total_income).toBe(1550);
      expect(response.total_spent).toBe(1450);
      expect(response.net).toBe(100);
      expect(response.average_monthly_net).toBe(33.33);
    });

    it('limits to the most recent N months', async () => {
      const result = await CashFlowTool.execute({ months: 2 }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.months.map((m: any) => m.month)).toEqual(['2024-02-01', '2024-03-01']);
    });

    it('filters by sinceDate when given', async () => {
      const result = await CashFlowTool.execute({ sinceDate: '2024-03-01' }, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.month_count).toBe(1);
      expect(response.months[0].month).toBe('2024-03-01');
    });

    it('handles a budget with no months', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue({ data: { months: [] } });

      const result = await CashFlowTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.month_count).toBe(0);
      expect(response.average_monthly_net).toBe(0);
    });

    it('reports API errors', async () => {
      mockApi.months.getBudgetMonths.mockRejectedValue(new Error('Unauthorized'));

      const result = await CashFlowTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unauthorized');
    });
  });
});
