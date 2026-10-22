import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as PlanSummaryTool from '../tools/PlanSummaryTool';

vi.mock('ynab');

describe('PlanSummaryTool', () => {
  let mockApi: {
    accounts: {
      getAccounts: Mock;
    };
    months: {
      getPlanMonth: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      accounts: {
        getAccounts: vi.fn(),
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
    const mockAccountsData = [
      {
        id: 'account-1',
        name: 'Checking Account',
        type: 'checking',
        deleted: false,
        closed: false,
        balance: 150000, // $150.00
      },
      {
        id: 'account-2',
        name: 'Savings Account',
        type: 'savings',
        deleted: false,
        closed: false,
        balance: 500000, // $500.00
      },
      {
        id: 'account-3',
        name: 'Closed Account',
        type: 'checking',
        deleted: false,
        closed: true, // Should be filtered out
        balance: 0,
      },
      {
        id: 'account-4',
        name: 'Deleted Account',
        type: 'checking',
        deleted: true, // Should be filtered out
        closed: false,
        balance: 0,
      },
    ];

    const mockMonthData = {
      month: {
        month: '2023-01-01',
        income: 500000, // $500.00
        budgeted: 450000, // $450.00
        activity: -400000, // -$400.00
        to_be_budgeted: 50000, // $50.00
        age_of_money: 45,
        note: 'Test month note',
        categories: [
          {
            id: 'category-1',
            name: 'Groceries',
            deleted: false,
            hidden: false,
            balance: -2500, // -$2.50 (overspent)
            budgeted: 20000, // $20.00
            activity: -22500, // -$22.50
          },
          {
            id: 'category-2',
            name: 'Gas',
            deleted: false,
            hidden: false,
            balance: 5000, // $5.00 (positive)
            budgeted: 15000, // $15.00
            activity: -10000, // -$10.00
          },
          {
            id: 'category-3',
            name: 'Hidden Category',
            deleted: false,
            hidden: true, // Should be filtered out
            balance: 1000,
            budgeted: 1000,
            activity: 0,
          },
          {
            id: 'category-4',
            name: 'Deleted Category',
            deleted: true, // Should be filtered out
            hidden: false,
            balance: 1000,
            budgeted: 1000,
            activity: 0,
          },
        ],
      },
    };

    it('should successfully get budget summary with default month', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      mockApi.months.getPlanMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await PlanSummaryTool.execute({}, mockApi as any);

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');
      expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', 'current');

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.month).toBe('2023-01-01');
      expect(parsedResult.income).toBe(500);
      expect(parsedResult.budgeted).toBe(450);
      expect(parsedResult.activity).toBe(-400);
      expect(parsedResult.ready_to_assign).toBe(50);

      // Should only include non-deleted, non-closed accounts, in dollars
      expect(parsedResult.accounts).toHaveLength(2);
      expect(parsedResult.accounts[0].name).toBe('Checking Account');
      expect(parsedResult.accounts[0].balance).toBe(150);
      expect(parsedResult.accounts[1].name).toBe('Savings Account');
    });

    it('should split categories into overspent, underfunded and positive', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      mockApi.months.getPlanMonth.mockResolvedValue({
        data: {
          month: {
            ...mockMonthData.month,
            categories: [
              ...mockMonthData.month.categories,
              {
                id: 'category-5',
                name: 'Vacation',
                deleted: false,
                hidden: false,
                balance: 10000, // $10.00
                budgeted: 10000,
                activity: 0,
                goal_target: 100000, // $100.00
                goal_under_funded: 90000, // $90.00 still needed
              },
            ],
          },
        },
      });

      const result = await PlanSummaryTool.execute({}, mockApi as any);
      const parsedResult = JSON.parse(result.content[0].text);

      // Only Groceries is negative; hidden and deleted categories are excluded.
      expect(parsedResult.overspent).toHaveLength(1);
      expect(parsedResult.overspent[0].name).toBe('Groceries');
      expect(parsedResult.overspent[0].balance).toBe(-2.5);

      // Positive balances come back largest first.
      expect(parsedResult.positive_balance.map((c: any) => c.name)).toEqual([
        'Vacation',
        'Gas',
      ]);

      // Only the category with an unmet goal is underfunded.
      expect(parsedResult.underfunded).toHaveLength(1);
      expect(parsedResult.underfunded[0].name).toBe('Vacation');
      expect(parsedResult.underfunded[0].goal_under_funded).toBe(90);
      expect(parsedResult.underfunded[0].goal_target).toBe(100);
    });

    it('should successfully get budget summary with custom month', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      mockApi.months.getPlanMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await PlanSummaryTool.execute(
        { month: '2023-01-01' },
        mockApi as any
      );

      expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', '2023-01-01');
    });

    it('should successfully get budget summary with custom budget ID', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      mockApi.months.getPlanMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await PlanSummaryTool.execute(
        { budgetId: 'custom-budget-id' },
        mockApi as any
      );

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('custom-budget-id');
      expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('custom-budget-id', 'current');
    });

    it('should handle empty accounts and categories', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [] },
      });
      mockApi.months.getPlanMonth.mockResolvedValue({
        data: {
          month: {
            ...mockMonthData.month,
            categories: [],
          },
        },
      });

      const result = await PlanSummaryTool.execute({}, mockApi as any);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.accounts).toEqual([]);
      expect(parsedResult.overspent).toEqual([]);
      expect(parsedResult.positive_balance).toEqual([]);
    });

    it('should filter out deleted and closed accounts', async () => {
      const accountsWithDeletedAndClosed = [
        ...mockAccountsData,
        {
          id: 'account-5',
          name: 'Another Closed Account',
          type: 'savings',
          deleted: false,
          closed: true,
          balance: 100000,
        },
        {
          id: 'account-6',
          name: 'Another Deleted Account',
          type: 'checking',
          deleted: true,
          closed: false,
          balance: 200000,
        },
      ];

      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: accountsWithDeletedAndClosed },
      });
      mockApi.months.getPlanMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await PlanSummaryTool.execute({}, mockApi as any);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.accounts).toHaveLength(2); // Only the 2 valid accounts
    });

    it('should handle API error for accounts', async () => {
      const apiError = new Error('Accounts API Error');
      mockApi.accounts.getAccounts.mockRejectedValue(apiError);

      const result = await PlanSummaryTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Accounts API Error');
    });

    it('should handle API error for month data', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      const apiError = new Error('Month API Error');
      mockApi.months.getPlanMonth.mockRejectedValue(apiError);

      const result = await PlanSummaryTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Month API Error');
    });

    it('should return an error when no plan ID is provided', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await PlanSummaryTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should validate month format with regex', () => {
      // Test the month regex pattern
      const validMonths = ['current', '2023-01-01', '2024-12-31'];
      const invalidMonths = ['invalid', '23-01-01', '2023-1-1', '2023/01/01'];

      validMonths.forEach(month => {
        expect(/^(current|\d{4}-\d{2}-\d{2})$/.test(month)).toBe(true);
      });

      invalidMonths.forEach(month => {
        expect(/^(current|\d{4}-\d{2}-\d{2})$/.test(month)).toBe(false);
      });
    });
  });

  describe('budgetVsActuals', () => {
    const category = (
      id: string,
      name: string,
      group: [string, string],
      budgeted: number,
      activity: number,
      balance: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      name,
      category_group_id: group[0],
      category_group_name: group[1],
      budgeted,
      activity,
      balance,
      hidden: false,
      deleted: false,
      internal: false,
      ...extra,
    });

    const BILLS: [string, string] = ['group-bills', 'Bills'];
    const FUN: [string, string] = ['group-fun', 'Fun'];
    const CARDS: [string, string] = ['group-cards', 'Credit Card Payments'];
    const INTERNAL: [string, string] = ['group-internal', 'Internal Master Category'];

    const month = (categories: unknown[]) => ({
      data: {
        month: {
          month: '2026-09-01',
          income: 900000,
          budgeted: 800000,
          activity: -850000,
          to_be_budgeted: 0,
          age_of_money: 30,
          categories,
        },
      },
    });

    const run = async (input: Record<string, unknown>, categories: unknown[]) => {
      mockApi.accounts.getAccounts.mockResolvedValue({ data: { accounts: [] } });
      mockApi.months.getPlanMonth.mockResolvedValue(month(categories));
      const result = await PlanSummaryTool.execute(input, mockApi as any);
      return JSON.parse(result.content[0].text);
    };

    const CATEGORIES = [
      category('c-rent', 'Rent', BILLS, 1500000, -1500000, 0),
      category('c-dining', 'Dining Out', FUN, 200000, -250000, -50000),
      category('c-power', 'Electric', BILLS, 150000, -120000, 30000),
      category('c-hidden', 'Old Hobby', FUN, 50000, -10000, 40000, { hidden: true }),
      category('c-deleted', 'Gone', FUN, 70000, -70000, 0, { deleted: true }),
    ];

    it('leaves the response unchanged when omitted or false', async () => {
      const omitted = await run({}, CATEGORIES);
      const explicitFalse = await run({ budgetVsActuals: false }, CATEGORIES);

      expect(omitted).not.toHaveProperty('budget_vs_actuals');
      expect(explicitFalse).toEqual(omitted);
    });

    it('reports each visible category with group subtotals and totals', async () => {
      const result = await run({ budgetVsActuals: true }, CATEGORIES);

      // The existing summary is still there.
      expect(result.overspent.map((c: any) => c.name)).toEqual(['Dining Out']);

      const { groups, totals } = result.budget_vs_actuals;
      // Groups appear in the order YNAB lists their first category; hidden and deleted categories are left out.
      expect(groups.map((g: any) => g.category_group_name)).toEqual(['Bills', 'Fun']);
      expect(groups[0]).toEqual({
        category_group_id: 'group-bills',
        category_group_name: 'Bills',
        budgeted: 1650,
        activity: -1620,
        balance: 30,
        variance: 30,
        percent_used: 98.2,
        categories: [
          { id: 'c-rent', name: 'Rent', budgeted: 1500, activity: -1500, balance: 0, variance: 0, percent_used: 100 },
          { id: 'c-power', name: 'Electric', budgeted: 150, activity: -120, balance: 30, variance: 30, percent_used: 80 },
        ],
      });
      expect(groups[1].categories).toEqual([
        { id: 'c-dining', name: 'Dining Out', budgeted: 200, activity: -250, balance: -50, variance: -50, percent_used: 125 },
      ]);
      expect(totals).toEqual({
        budgeted: 1850,
        activity: -1870,
        balance: -20,
        variance: -20,
        percent_used: 101.1,
      });
    });

    it('skips Ready to Assign, whose activity is the month income, and keeps other internal categories with activity', async () => {
      // YNAB's month endpoint returns "Inflow: Ready to Assign" among the categories,
      // with the month's income as its activity and a balance that accumulates across months.
      const result = await run({ budgetVsActuals: true }, [
        category('c-rta', 'Inflow: Ready to Assign', INTERNAL, 0, 900000, 2428718370, { internal: true }),
        category('c-uncat', 'Uncategorized', INTERNAL, 0, -40000, -40000, { internal: true }),
        category('c-quiet', 'Quiet Internal', INTERNAL, 0, 0, 0, { internal: true }),
        category('c-rent', 'Rent', BILLS, 1500000, -1500000, 0),
      ]);

      const { groups, totals } = result.budget_vs_actuals;
      expect(groups.map((g: any) => g.category_group_name)).toEqual(['Internal Master Category', 'Bills']);
      expect(groups[0].categories).toEqual([
        { id: 'c-uncat', name: 'Uncategorized', budgeted: 0, activity: -40, balance: -40, variance: -40, percent_used: null },
      ]);
      expect(totals).toEqual({ budgeted: 1500, activity: -1540, balance: -40, variance: -40, percent_used: 102.7 });
    });

    it('recognises Ready to Assign by its group when the internal flag is missing', async () => {
      const result = await run({ budgetVsActuals: true }, [
        category('c-rta', 'Inflow: Ready to Assign', INTERNAL, 0, 900000, 2428718370, { internal: undefined }),
        category('c-rent', 'Rent', BILLS, 1500000, -1500000, 0),
      ]);

      expect(result.budget_vs_actuals.groups.map((g: any) => g.category_group_name)).toEqual(['Bills']);
      expect(result.budget_vs_actuals.totals.activity).toBe(-1500);
    });

    it('reports percent used as null when nothing was assigned, and below zero after net refunds', async () => {
      const result = await run({ budgetVsActuals: true }, [
        category('c-gifts', 'Gifts', FUN, 0, -40000, -40000),
        category('c-moved', 'Moved Out', FUN, -25000, 0, 0),
        category('c-refund', 'Electronics', FUN, 100000, 30000, 130000),
      ]);

      const [fun] = result.budget_vs_actuals.groups;
      expect(fun.categories.map((c: any) => [c.name, c.variance, c.percent_used])).toEqual([
        ['Gifts', -40, null],
        ['Moved Out', -25, null],
        ['Electronics', 130, -30],
      ]);
      expect(fun.percent_used).toBe(13.3);
    });

    it('lists Credit Card Payments as its own group and leaves it out of the totals', async () => {
      // A $90 card purchase in Dining Out moves $90 into the card's payment category.
      const result = await run({ budgetVsActuals: true }, [
        category('c-dining', 'Dining Out', FUN, 200000, -90000, 110000),
        category('c-visa', 'Visa', CARDS, 0, 90000, 90000),
      ]);

      const { groups, totals } = result.budget_vs_actuals;
      expect(groups.map((g: any) => g.category_group_name)).toEqual(['Fun', 'Credit Card Payments']);
      expect(groups[1]).toMatchObject({ activity: 90, categories: [{ name: 'Visa', activity: 90 }] });
      expect(totals).toEqual({ budgeted: 200, activity: -90, balance: 110, variance: 110, percent_used: 45 });
    });

    it('does not count a card payment made in the month as spending', async () => {
      // Last month's $300 bill is paid this month: the payment category's activity is +90 - 300.
      const result = await run({ budgetVsActuals: true }, [
        category('c-dining', 'Dining Out', FUN, 200000, -90000, 110000),
        category('c-visa', 'Visa', CARDS, 0, -210000, 0),
      ]);

      const { groups, totals } = result.budget_vs_actuals;
      expect(groups[1].activity).toBe(-210);
      expect(totals).toEqual({ budgeted: 200, activity: -90, balance: 110, variance: 110, percent_used: 45 });
    });

    it('uses the plan currency precision', async () => {
      (mockApi as any).plans = {
        getPlanSettingsById: vi.fn().mockResolvedValue({
          data: { settings: { currency_format: { decimal_digits: 3 } } },
        }),
      };

      const result = await run({ budgetVsActuals: true }, [
        category('c-rent', 'Rent', BILLS, 1234567, -1000001, 234566),
      ]);

      expect(result.budget_vs_actuals.groups[0].categories[0]).toEqual({
        id: 'c-rent',
        name: 'Rent',
        budgeted: 1234.567,
        activity: -1000.001,
        balance: 234.566,
        variance: 234.566,
        percent_used: 81,
      });
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(PlanSummaryTool.name).toBe('ynab_plan_summary');
      expect(PlanSummaryTool.description).toContain('Get a summary of the plan for a specific month');
    });

    it('should have correct input schema', () => {
      expect(PlanSummaryTool.inputSchema).toHaveProperty('planId');
      expect(PlanSummaryTool.inputSchema).toHaveProperty('budgetId');
      expect(PlanSummaryTool.inputSchema).toHaveProperty('month');
      expect(PlanSummaryTool.inputSchema).toHaveProperty('budgetVsActuals');
    });
  });
});