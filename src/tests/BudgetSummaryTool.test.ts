import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as BudgetSummaryTool from '../tools/BudgetSummaryTool';

vi.mock('ynab');

describe('BudgetSummaryTool', () => {
  let mockApi: {
    accounts: {
      getAccounts: Mock;
    };
    months: {
      getBudgetMonth: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      accounts: {
        getAccounts: vi.fn(),
      },
      months: {
        getBudgetMonth: vi.fn(),
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
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await BudgetSummaryTool.execute({}, mockApi as any);

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');
      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith('test-budget-id', 'current');

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('monthBudget');
      expect(parsedResult).toHaveProperty('accounts');
      expect(parsedResult).toHaveProperty('note', 'Divide all numbers by 1000 to get the balance in dollars.');

      // Should only include non-deleted, non-closed accounts
      expect(parsedResult.accounts).toHaveLength(2);
      expect(parsedResult.accounts[0].name).toBe('Checking Account');
      expect(parsedResult.accounts[1].name).toBe('Savings Account');
    });

    it('should successfully get budget summary with custom month', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await BudgetSummaryTool.execute(
        { month: '2023-01-01' },
        mockApi as any
      );

      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith('test-budget-id', '2023-01-01');
    });

    it('should successfully get budget summary with custom budget ID', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await BudgetSummaryTool.execute(
        { budgetId: 'custom-budget-id' },
        mockApi as any
      );

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('custom-budget-id');
      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith('custom-budget-id', 'current');
    });

    it('should handle empty accounts and categories', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [] },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            ...mockMonthData.month,
            categories: [],
          },
        },
      });

      const result = await BudgetSummaryTool.execute({}, mockApi as any);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.accounts).toEqual([]);
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
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: mockMonthData,
      });

      const result = await BudgetSummaryTool.execute({}, mockApi as any);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.accounts).toHaveLength(2); // Only the 2 valid accounts
    });

    it('should handle API error for accounts', async () => {
      const apiError = new Error('Accounts API Error');
      mockApi.accounts.getAccounts.mockRejectedValue(apiError);

      const result = await BudgetSummaryTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Accounts API Error');
    });

    it('should handle API error for month data', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountsData },
      });
      const apiError = new Error('Month API Error');
      mockApi.months.getBudgetMonth.mockRejectedValue(apiError);

      const result = await BudgetSummaryTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Month API Error');
    });

    it('should throw error when no budget ID is provided', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await BudgetSummaryTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
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

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(BudgetSummaryTool.name).toBe('ynab_budget_summary');
      expect(BudgetSummaryTool.description).toContain('Get a summary of the budget for a specific month');
    });

    it('should have correct input schema', () => {
      expect(BudgetSummaryTool.inputSchema).toHaveProperty('budgetId');
      expect(BudgetSummaryTool.inputSchema).toHaveProperty('month');
    });
  });
});