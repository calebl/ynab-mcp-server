import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import CashFlowForecastTool from '../tools/CashFlowForecastTool';

vi.mock('ynab');

describe('CashFlowForecastTool', () => {
  let tool: CashFlowForecastTool;
  let mockApi: {
    accounts: {
      getAccounts: Mock;
    };
    transactions: {
      getTransactionsByAccount: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      accounts: {
        getAccounts: vi.fn(),
      },
      transactions: {
        getTransactionsByAccount: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new CashFlowForecastTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_cash_flow_forecast');
      expect(toolDef.description).toContain('cash flow');
      expect(toolDef.description).toContain('forecast');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('months');
      expect(toolDef.inputSchema.properties).toHaveProperty('accountId');
      expect(toolDef.inputSchema.properties).toHaveProperty('includeProjections');
    });

    it('should have default months of 6 with max of 12', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.months.default).toBe(6);
    });
  });

  describe('execute - successful forecast', () => {
    const mockAccounts = {
      data: {
        accounts: [
          {
            id: 'acc-checking',
            name: 'Checking',
            type: 'checking',
            balance: 500000, // $500
            deleted: false,
            closed: false,
            on_budget: true,
          },
          {
            id: 'acc-savings',
            name: 'Savings',
            type: 'savings',
            balance: 1000000, // $1000
            deleted: false,
            closed: false,
            on_budget: true,
          },
        ],
      },
    };

    const mockTransactions = {
      data: {
        transactions: [
          {
            id: 'txn-1',
            date: '2024-01-15',
            amount: 200000, // +$200 income
            deleted: false,
          },
          {
            id: 'txn-2',
            date: '2024-01-20',
            amount: -100000, // -$100 expense
            deleted: false,
          },
          {
            id: 'txn-3',
            date: '2024-02-15',
            amount: 200000, // +$200 income
            deleted: false,
          },
          {
            id: 'txn-4',
            date: '2024-02-20',
            amount: -100000, // -$100 expense
            deleted: false,
          },
        ],
      },
    };

    it('should generate cash flow forecast', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        months: 6,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('projections');
      expect(parsedResult).toHaveProperty('summary');
      expect(parsedResult).toHaveProperty('current_balance_dollars');
    });

    it('should use primary checking account when no account specified', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_analyzed).toContain('Checking');
    });

    it('should calculate projected balance', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        months: 6,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.summary).toHaveProperty('projected_balance_end');
    });

    it('should respect months parameter with max of 12', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        months: 20, // Request 20 but max is 12
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.projections.length).toBeLessThanOrEqual(12);
    });
  });

  describe('execute - edge cases', () => {
    it('should handle invalid account ID', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({ data: { accounts: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'invalid-id',
      });

      expect(result.content[0].text).toContain('not found');
    });

    it('should handle no suitable accounts', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({ data: { accounts: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
      });

      expect(result.content[0].text).toContain('No suitable account found');
    });

    it('should filter out deleted accounts', async () => {
      const accountsWithDeleted = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Active',
              type: 'checking',
              balance: 500000,
              deleted: false,
              closed: false,
              on_budget: true,
            },
            {
              id: 'acc-2',
              name: 'Deleted',
              type: 'checking',
              balance: 300000,
              deleted: true,
              closed: false,
              on_budget: true,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(accountsWithDeleted);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_analyzed).toContain('Active');
    });

    it('should filter out closed accounts', async () => {
      const accountsWithClosed = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Open',
              type: 'checking',
              balance: 500000,
              deleted: false,
              closed: false,
              on_budget: true,
            },
            {
              id: 'acc-2',
              name: 'Closed',
              type: 'checking',
              balance: 0,
              deleted: false,
              closed: true,
              on_budget: true,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(accountsWithClosed);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_analyzed).toContain('Open');
    });

    it('should filter out off-budget accounts', async () => {
      const accountsWithOffBudget = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'On Budget',
              type: 'checking',
              balance: 500000,
              deleted: false,
              closed: false,
              on_budget: true,
            },
            {
              id: 'acc-2',
              name: 'Off Budget',
              type: 'checking',
              balance: 1000000,
              deleted: false,
              closed: false,
              on_budget: false,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(accountsWithOffBudget);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_analyzed).toContain('On Budget');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new CashFlowForecastTool();

      const result = await tool.execute({
        months: 6,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API errors', async () => {
      mockApi.accounts.getAccounts.mockRejectedValue(new Error('API Error'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error generating cash flow forecast');
    });

    it('should return markdown format when requested', async () => {
      const mockAccounts = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Checking',
              type: 'checking',
              balance: 500000,
              deleted: false,
              closed: false,
              on_budget: true,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        months: 6,
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Cash Flow Forecast');
    });
  });
});
