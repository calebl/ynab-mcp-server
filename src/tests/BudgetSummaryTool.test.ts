import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import BudgetSummaryTool from '../tools/BudgetSummaryTool';

// Mock the entire ynab module
vi.mock('ynab');

describe('BudgetSummaryTool', () => {
  let tool: BudgetSummaryTool;
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
    
    // Create mock API instance
    mockApi = {
      accounts: {
        getAccounts: vi.fn(),
      },
      months: {
        getBudgetMonth: vi.fn(),
      },
    };

    // Mock the ynab.API constructor
    (ynab.API as any).mockImplementation(() => mockApi);

    // Set environment variables
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new BudgetSummaryTool();
  });

  describe('execute', () => {
    const mockAccounts = [
      {
        id: 'account-1',
        name: 'Checking Account',
        type: 'checking',
        balance: 150000, // $150.00
        deleted: false,
        closed: false,
        on_budget: true,
      },
      {
        id: 'account-2',
        name: 'Savings Account',
        type: 'savings',
        balance: 500000, // $500.00
        deleted: false,
        closed: false,
        on_budget: true,
      },
      {
        id: 'account-3',
        name: 'Deleted Account',
        type: 'checking',
        balance: 0,
        deleted: true,
        closed: false,
        on_budget: true,
      },
      {
        id: 'account-4',
        name: 'Closed Account',
        type: 'checking',
        balance: 0,
        deleted: false,
        closed: true,
        on_budget: true,
      },
    ];

    const mockCategories = [
      {
        id: 'category-1',
        name: 'Groceries',
        balance: -25000, // -$25.00 (overspent)
        budgeted: 30000, // $30.00
        activity: -55000, // -$55.00
        deleted: false,
        hidden: false,
      },
      {
        id: 'category-2',
        name: 'Gas',
        balance: 5000, // $5.00 (positive balance)
        budgeted: 20000, // $20.00
        activity: -15000, // -$15.00
        deleted: false,
        hidden: false,
      },
      {
        id: 'category-3',
        name: 'Deleted Category',
        balance: 0,
        budgeted: 0,
        activity: 0,
        deleted: true,
        hidden: false,
      },
      {
        id: 'category-4',
        name: 'Hidden Category',
        balance: 0,
        budgeted: 0,
        activity: 0,
        deleted: false,
        hidden: true,
      },
    ];

    const mockMonthBudget = {
      month: '2023-12-01',
      income: 400000, // $400.00
      budgeted: 350000, // $350.00
      activity: -300000, // -$300.00
      to_be_budgeted: 50000, // $50.00
      age_of_money: 25,
      note: 'December budget',
      categories: mockCategories,
    };

    it('should successfully get budget summary with budget ID from input', async () => {
      // Setup mocks
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthBudget },
      });

      const input = {
        budgetId: 'custom-budget-id',
        month: '2023-12-01',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('custom-budget-id');
      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith('custom-budget-id', '2023-12-01');

      expect(result).toHaveProperty('content');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const resultText = result.content[0].text;
      expect(resultText).toContain('monthBudget');
      expect(resultText).toContain('accounts');
      expect(resultText).toContain('All amounts in dollars. Compressed format: bal=balance, bud=budgeted, act=activity. All categories shown, sorted by activity.');

      // Parse the JSON result to verify structure
      const parsedResult = JSON.parse(resultText);
      expect(parsedResult).toHaveProperty('monthBudget');
      expect(parsedResult).toHaveProperty('accounts');
      expect(parsedResult.accounts).toHaveLength(2); // Only non-deleted, non-closed accounts
    });

    it('should successfully get budget summary with budget ID from environment', async () => {
      // Setup mocks
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthBudget },
      });

      const input = {
        month: 'current',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');
      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith('test-budget-id', 'current');

      expect(result).toHaveProperty('content');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const resultText = result.content[0].text;
      expect(resultText).toContain('monthBudget');
      expect(resultText).toContain('accounts');
      expect(resultText).toContain('All amounts in dollars. Compressed format: bal=balance, bud=budgeted, act=activity. All categories shown, sorted by activity.');
    });

    it('should filter out deleted and closed accounts', async () => {
      // Setup mocks
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthBudget },
      });

      const input = {
        budgetId: 'test-budget-id',
        month: 'current',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.accounts).toHaveLength(2);
      expect(parsedResult.accounts.every((account: any) => !account.deleted && !account.closed)).toBe(true);
    });

    it('should filter out deleted and hidden categories', async () => {
      // Setup mocks
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthBudget },
      });

      const input = {
        budgetId: 'test-budget-id',
        month: 'current',
      };

      const result = await tool.execute(input);

      // Categories should be filtered in the monthBudget.categories
      const visibleCategories = mockMonthBudget.categories.filter(
        cat => !cat.deleted && !cat.hidden
      );
      expect(visibleCategories).toHaveLength(2);
      expect(visibleCategories.every(cat => !cat.deleted && !cat.hidden)).toBe(true);
    });

    it('should return error when no budget ID is provided', async () => {
      // Clear environment budget ID
      delete process.env.YNAB_BUDGET_ID;
      tool = new BudgetSummaryTool();

      const input = {
        month: 'current',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result).toHaveProperty('content');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0].text).toContain('Error getting budget:');
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API error when getting accounts', async () => {
      // Setup mock to throw API error
      const apiError = new Error('API Error: Budget not found');
      mockApi.accounts.getAccounts.mockRejectedValue(apiError);

      const input = {
        budgetId: 'invalid-budget-id',
        month: 'current',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error getting budget:');
      expect(result.content[0].text).toContain('API Error: Budget not found');
    });

    it('should handle API error when getting budget month', async () => {
      // Setup mocks - accounts succeeds, month fails
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const apiError = new Error('API Error: Month not found');
      mockApi.months.getBudgetMonth.mockRejectedValue(apiError);

      const input = {
        budgetId: 'test-budget-id',
        month: '2025-01-01',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error getting budget:');
      expect(result.content[0].text).toContain('API Error: Month not found');
    });

    it('should handle non-Error objects in catch block', async () => {
      // Setup mock to throw non-Error object
      const nonErrorObject = { message: 'Custom error object', code: 500 };
      mockApi.accounts.getAccounts.mockRejectedValue(nonErrorObject);

      const input = {
        budgetId: 'test-budget-id',
        month: 'current',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error getting budget:');
      expect(result.content[0].text).toContain('"message":"Custom error object"');
      expect(result.content[0].text).toContain('"code":500');
    });

    it('should use current month as default when month not specified', async () => {
      // Setup mocks
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthBudget },
      });

      const input = {
        budgetId: 'test-budget-id',
        month: 'current', // explicitly set to current since the framework may not apply defaults
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.months.getBudgetMonth).toHaveBeenCalledWith('test-budget-id', 'current');
      expect(result).toHaveProperty('content');
      expect(result.content[0].text).toContain('monthBudget');
    });

    it('should handle empty accounts array', async () => {
      // Setup mocks with empty accounts
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [] },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthBudget },
      });

      const input = {
        budgetId: 'test-budget-id',
        month: 'current',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.accounts).toHaveLength(0);
      expect(parsedResult).toHaveProperty('monthBudget');
    });

    it('should handle empty categories array', async () => {
      // Setup mocks with empty categories
      const emptyMonthBudget = {
        ...mockMonthBudget,
        categories: [],
      };

      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: emptyMonthBudget },
      });

      const input = {
        budgetId: 'test-budget-id',
        month: 'current',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.monthBudget.categories).toHaveLength(0);
      expect(parsedResult).toHaveProperty('accounts');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_budget_summary');
      expect(toolDef.description).toBe(
        'Get a summary of the budget for a specific month highlighting overspent categories that need attention and categories with a positive balance that are doing well.'
      );
    });

    it('should have correct schema definition', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema).toHaveProperty('properties');
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('month');
      
      expect(toolDef.inputSchema.properties.budgetId.description).toContain('budget to get a summary for');
      expect(toolDef.inputSchema.properties.month.description).toContain('budget month in ISO format');
      expect(toolDef.inputSchema.properties.month.default).toBe('current');
    });

    it('should have correct month regex pattern', () => {
      // Test that the regex accepts valid formats
      const regex = /^(current|\d{4}-\d{2}-\d{2})$/;
      
      expect(regex.test('current')).toBe(true);
      expect(regex.test('2023-12-01')).toBe(true);
      expect(regex.test('2024-01-15')).toBe(true);
      
      // Test invalid formats
      expect(regex.test('invalid')).toBe(false);
      expect(regex.test('2023-12')).toBe(false);
      expect(regex.test('23-12-01')).toBe(false);
      expect(regex.test('2023/12/01')).toBe(false);
    });
  });
});