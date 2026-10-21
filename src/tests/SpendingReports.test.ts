import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { z } from 'zod';
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
    months: { getPlanMonths: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      transactions: { getTransactions: vi.fn().mockResolvedValue({ data: { transactions } }) },
      months: { getPlanMonths: vi.fn() },
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
      mockApi.months.getPlanMonths.mockResolvedValue({ data: { months } });
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
      mockApi.months.getPlanMonths.mockResolvedValue({ data: { months: [] } });

      const result = await CashFlowTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.month_count).toBe(0);
      expect(response.average_monthly_net).toBe(0);
    });

    it('reports API errors', async () => {
      mockApi.months.getPlanMonths.mockRejectedValue(new Error('Unauthorized'));

      const result = await CashFlowTool.execute({}, mockApi as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unauthorized');
    });
  });

  describe('monthly breakdown', () => {
    const outflow = (id: string, date: string, amount: number, category: string, payee: string) => ({
      id, date, amount, deleted: false,
      category_id: `c-${category.toLowerCase()}`, category_name: category, payee_name: payee,
      transfer_account_id: null, subtransactions: [],
    });

    const monthlyTransactions = [
      outflow('g1', '2024-01-10', -100000, 'Giving', 'Church'),
      outflow('g2', '2024-02-10', -100000, 'Giving', 'Church'),
      outflow('g3', '2024-03-10', -200000, 'Giving', 'Church'),
      outflow('f1', '2024-01-05', -50000, 'Groceries', 'Corner Store'),
      outflow('f2', '2024-01-20', -30000, 'Groceries', 'Corner Store'),
      outflow('f3', '2024-03-02', -40000, 'Groceries', 'Corner Store'),
      // Only in January, so February and March have no spending.
      outflow('h1', '2024-01-25', -12000, 'Home Goods', 'Big Box'),
      // Only in the last month, so there is no earlier spending to compare with.
      outflow('k1', '2024-03-20', -15000, 'Gifts', 'Toy Shop'),
      // Income and a transfer between the user's own accounts - not spending.
      {
        id: 'in', date: '2024-02-01', amount: 500000, deleted: false,
        category_id: null, category_name: 'Inflow: Ready to Assign', payee_name: 'Employer',
        transfer_account_id: null, subtransactions: [],
      },
      {
        id: 'xfer', date: '2024-02-02', amount: -70000, deleted: false,
        category_id: null, category_name: null, payee_name: 'Transfer : Savings',
        transfer_account_id: 'acct-savings', subtransactions: [],
      },
      // A split counts through its children, and a child that is a transfer is not spending.
      {
        id: 'split', date: '2024-02-15', amount: -35000, deleted: false,
        category_id: null, category_name: null, payee_name: 'Big Box',
        transfer_account_id: null,
        subtransactions: [
          { id: 's1', amount: -20000, deleted: false, category_id: 'c-groceries', category_name: 'Groceries', payee_name: null, transfer_account_id: null },
          { id: 's2', amount: -10000, deleted: false, category_id: 'c-giving', category_name: 'Giving', payee_name: null, transfer_account_id: null },
          { id: 's3', amount: -5000, deleted: false, category_id: null, category_name: null, payee_name: null, transfer_account_id: 'acct-savings' },
        ],
      },
    ];

    const firstQuarter = { sinceDate: '2024-01-01', untilDate: '2024-03-31' };

    const run = async (tool: typeof SpendingByCategoryTool | typeof SpendingByPayeeTool, input: object) =>
      JSON.parse((await tool.execute(input, mockApi as any)).content[0].text);

    beforeEach(() => {
      // Like YNAB's since_date, the listing starts at sinceDate.
      mockApi.transactions.getTransactions.mockImplementation(async (_plan: string, sinceDate: string) => ({
        data: { transactions: monthlyTransactions.filter((t) => t.date >= sinceDate) },
      }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('adds a monthly series, mean and change per category, splits counted through their children', async () => {
      const response = await run(SpendingByCategoryTool, { ...firstQuarter, monthly: true });

      expect(response.months).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
      expect(response.full_month_count).toBe(3);
      expect(response.last_full_month).toBe('2024-03-01');
      expect(response.change_compares).toBe('2024-03-01 against the mean of 2 earlier full month(s)');
      expect(response.categories.map((c: any) => c.name)).toEqual(['Giving', 'Groceries', 'Gifts', 'Home Goods']);

      // Giving: $100, then $100 + the $10 split child, then $200.
      // March's $200 against the January/February mean of $105 is +90.48%.
      expect(response.categories[0]).toEqual({
        name: 'Giving', total: 410, transaction_count: 4, average: 102.5, share_of_total: 71.06,
        average_monthly: 136.67,
        change_pct: 90.48,
        monthly: [
          { month: '2024-01-01', total: 100, transaction_count: 1 },
          { month: '2024-02-01', total: 110, transaction_count: 2 },
          { month: '2024-03-01', total: 200, transaction_count: 1 },
        ],
      });
      // Groceries: $80, the $20 split child, $40. March against a $50 mean is -20%.
      const groceries = response.categories[1];
      expect(groceries.monthly.map((m: any) => m.total)).toEqual([80, 20, 40]);
      expect(groceries.change_pct).toBe(-20);
    });

    it('lists months with no spending as zero', async () => {
      const response = await run(SpendingByCategoryTool, { ...firstQuarter, monthly: true });
      const home = response.categories.find((c: any) => c.name === 'Home Goods');

      expect(home.monthly).toEqual([
        { month: '2024-01-01', total: 12, transaction_count: 1 },
        { month: '2024-02-01', total: 0, transaction_count: 0 },
        { month: '2024-03-01', total: 0, transaction_count: 0 },
      ]);
      expect(home.average_monthly).toBe(4);
      expect(home.change_pct).toBe(-100);
    });

    it('has no change figure when the earlier months had no spending', async () => {
      const response = await run(SpendingByCategoryTool, { ...firstQuarter, monthly: true });
      const gifts = response.categories.find((c: any) => c.name === 'Gifts');

      expect(gifts.monthly.map((m: any) => m.total)).toEqual([0, 0, 15]);
      expect(gifts.change_pct).toBeNull();
    });

    it('excludes income and transfers, including a split child that is a transfer', async () => {
      const response = await run(SpendingByCategoryTool, { ...firstQuarter, monthly: true });

      // $410 + $140 + $15 + $12. The $70 transfer, the $5 transfer child and the $500 income are left out.
      expect(response.total_spent).toBe(577);
      expect(response.categories.map((c: any) => c.name)).not.toContain('Inflow: Ready to Assign');
      const monthTotals = [0, 1, 2].map((i) => response.categories.reduce((sum: number, c: any) => sum + c.monthly[i].total, 0));
      expect(monthTotals).toEqual([192, 130, 255]);
    });

    it('breaks down spending by payee through the same rules', async () => {
      const response = await run(SpendingByPayeeTool, { ...firstQuarter, monthly: true });

      expect(response.months).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
      expect(response.payees.map((p: any) => p.name)).toEqual(['Church', 'Corner Store', 'Big Box', 'Toy Shop']);
      // Big Box: $12 in January, then the split's $20 + $10 children (not its $5 transfer child).
      const bigBox = response.payees[2];
      expect(bigBox.monthly).toEqual([
        { month: '2024-01-01', total: 12, transaction_count: 1 },
        { month: '2024-02-01', total: 30, transaction_count: 2 },
        { month: '2024-03-01', total: 0, transaction_count: 0 },
      ]);
      expect(bigBox.average_monthly).toBe(14);
      expect(bigBox.change_pct).toBe(-100);
      expect(response.total_spent).toBe(577);
    });

    it('lists a month that has not ended but leaves it out of the mean and change', async () => {
      const response = await run(SpendingByCategoryTool, { sinceDate: '2024-01-01', untilDate: '2024-03-15', monthly: true });
      const giving = response.categories.find((c: any) => c.name === 'Giving');

      expect(response.months).toHaveLength(3);
      expect(response.last_full_month).toBe('2024-02-01');
      // The March 10 gift is inside the range, so it still counts towards the totals.
      expect(giving.monthly[2].total).toBe(200);
      expect(giving.total).toBe(410);
      // February's $110 against January's $100.
      expect(giving.change_pct).toBe(10);
      expect(giving.average_monthly).toBe(105);
      // The March 20 gift is after untilDate.
      expect(response.categories.map((c: any) => c.name)).not.toContain('Gifts');
    });

    it('treats a first month that starts mid-month as partial', async () => {
      const response = await run(SpendingByCategoryTool, { sinceDate: '2024-01-15', untilDate: '2024-03-31', monthly: true });

      expect(response.months).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
      expect(response.full_month_count).toBe(2);
      expect(response.change_compares).toBe('2024-03-01 against the mean of 1 earlier full month(s)');
      const giving = response.categories.find((c: any) => c.name === 'Giving');
      // March's $200 against February's $110.
      expect(giving.change_pct).toBe(81.82);
    });

    it('has no mean or change without a full month', async () => {
      const response = await run(SpendingByCategoryTool, { sinceDate: '2024-03-05', untilDate: '2024-03-20', monthly: true });

      expect(response.last_full_month).toBeNull();
      expect(response.change_compares).toBe('no full month in range');
      expect(response.categories.length).toBeGreaterThan(0);
      for (const category of response.categories) {
        expect(category.average_monthly).toBeNull();
        expect(category.change_pct).toBeNull();
      }
    });

    it('defaults to the last 6 calendar months through today', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2024-03-20T12:00:00Z'));

      const response = await run(SpendingByCategoryTool, { monthly: true });

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('test-budget-id', '2023-10-01');
      expect(response.since_date).toBe('2023-10-01');
      expect(response.until_date).toBe('2024-03-20');
      expect(response.months).toEqual(['2023-10-01', '2023-11-01', '2023-12-01', '2024-01-01', '2024-02-01', '2024-03-01']);
      expect(response.last_full_month).toBe('2024-02-01');
    });

    it('takes the number of months, counted back from untilDate', async () => {
      const response = await run(SpendingByPayeeTool, { untilDate: '2024-03-31', monthly: true, months: 2 });

      expect(response.since_date).toBe('2024-02-01');
      expect(response.months).toEqual(['2024-02-01', '2024-03-01']);
    });

    it('lets sinceDate override months, as ynab_cash_flow does', async () => {
      const response = await run(SpendingByCategoryTool, { ...firstQuarter, monthly: true, months: 12 });

      expect(response.since_date).toBe('2024-01-01');
      expect(response.months).toHaveLength(3);
    });

    it('keeps the full category count when limited', async () => {
      const response = await run(SpendingByCategoryTool, { ...firstQuarter, monthly: true, limit: 1 });

      expect(response.categories).toHaveLength(1);
      expect(response.category_count).toBe(4);
      expect(response.categories[0].monthly).toHaveLength(3);
    });

    it('leaves the response unchanged with monthly: false, even alongside months', async () => {
      for (const tool of [SpendingByCategoryTool, SpendingByPayeeTool]) {
        const plain = await run(tool, firstQuarter);
        expect(plain).not.toHaveProperty('months');
        expect(await run(tool, { ...firstQuarter, monthly: false })).toEqual(plain);
        expect(await run(tool, { ...firstQuarter, monthly: false, months: 12 })).toEqual(plain);
      }
    });

    it('rejects a range longer than 24 months or one that runs backwards', async () => {
      const tooLong = await run(SpendingByCategoryTool, { sinceDate: '2022-01-01', untilDate: '2024-01-31', monthly: true });
      expect(tooLong.success).toBe(false);
      expect(tooLong.error).toContain('at most 24 months');

      const backwards = await run(SpendingByPayeeTool, { sinceDate: '2024-03-01', untilDate: '2024-01-31', monthly: true });
      expect(backwards.success).toBe(false);
      expect(backwards.error).toContain('is after untilDate');

      expect(mockApi.transactions.getTransactions).not.toHaveBeenCalled();
    });

    it('accepts exactly 24 months', async () => {
      const response = await run(SpendingByCategoryTool, { sinceDate: '2022-02-01', untilDate: '2024-01-31', monthly: true });

      expect(response.months).toHaveLength(24);
      expect(response.full_month_count).toBe(24);
    });
  });

  describe('schema tightening', () => {
    it('rejects a non-integer limit on spending by category and payee', () => {
      expect((SpendingByCategoryTool.inputSchema.limit as z.ZodType).safeParse(1.5).success).toBe(false);
      expect((SpendingByPayeeTool.inputSchema.limit as z.ZodType).safeParse(1.5).success).toBe(false);
    });

    it('accepts months from 1 to 24 on spending by category and payee', () => {
      for (const tool of [SpendingByCategoryTool, SpendingByPayeeTool]) {
        const months = tool.inputSchema.months as z.ZodType;
        expect(months.safeParse(1).success).toBe(true);
        expect(months.safeParse(24).success).toBe(true);
        expect(months.safeParse(0).success).toBe(false);
        expect(months.safeParse(25).success).toBe(false);
        expect(months.safeParse(1.5).success).toBe(false);
      }
    });

    it('rejects a non-integer months on cash flow', () => {
      expect((CashFlowTool.inputSchema.months as z.ZodType).safeParse(1.5).success).toBe(false);
    });
  });
});
