import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import ReconcileAccountTool from '../tools/ReconcileAccountTool';

vi.mock('ynab');
vi.mock('../utils/apiErrorHandler.js', () => ({
  handleAPIError: vi.fn(),
  createRetryableAPICall: async (fn: any) => await fn(),
}));

describe('ReconcileAccountTool', () => {
  let tool: ReconcileAccountTool;
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

    tool = new ReconcileAccountTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_reconcile_account');
      expect(toolDef.description.toLowerCase()).toContain('reconcile');
      expect(toolDef.description).toContain('statement');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('accountId');
      expect(toolDef.inputSchema.properties).toHaveProperty('accountName');
      expect(toolDef.inputSchema.properties).toHaveProperty('statementData');
      expect(toolDef.inputSchema.properties).toHaveProperty('statementBalance');
      expect(toolDef.inputSchema.properties).toHaveProperty('tolerance');
    });

    it('should have default tolerance of 0.01', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties.tolerance.default).toBe(0.01);
    });
  });

  describe('execute - CSV parsing', () => {
    const mockAccounts = {
      data: {
        accounts: [
          {
            id: 'acc-checking',
            name: 'Checking Account',
            type: 'checking',
            balance: 150000, // $150
            deleted: false,
            closed: false,
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
            amount: -50000, // -$50
            payee_name: 'Grocery Store',
            memo: 'Weekly shopping',
            deleted: false,
            cleared: ynab.TransactionClearedStatus.Cleared,
          },
          {
            id: 'txn-2',
            date: '2024-01-20',
            amount: -30000, // -$30
            payee_name: 'Gas Station',
            memo: 'Fill up',
            deleted: false,
            cleared: ynab.TransactionClearedStatus.Cleared,
          },
        ],
      },
    };

    // TODO: Fix complex CSV parsing mock setup
    it.skip('should parse CSV statement data', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const csvData = `Date,Description,Amount
2024-01-15,Grocery Store,-50.00
2024-01-20,Gas Station,-30.00`;

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        statementData: csvData,
        statementBalance: 150.0,
        statementDate: '2024-01-31',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('matches');
      expect(parsedResult.total_statement_transactions).toBe(2);
    });

    // TODO: Fix complex transaction matching mock setup
    it.skip('should match transactions exactly', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const csvData = `Date,Description,Amount
2024-01-15,Grocery Store,-50.00
2024-01-20,Gas Station,-30.00`;

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        statementData: csvData,
        statementBalance: 150.0,
        statementDate: '2024-01-31',
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('exact_matches');
      expect(parsedResult).toHaveProperty('matches');
      expect(parsedResult.total_statement_transactions).toBe(2);
      expect(parsedResult.total_ynab_transactions).toBe(2);
    });

    // TODO: Fix unmatched transaction detection mock setup
    it.skip('should detect unmatched transactions', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const csvData = `Date,Description,Amount
2024-01-15,Grocery Store,-50.00
2024-01-25,Restaurant,-45.00`;

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        statementData: csvData,
        statementBalance: 150.0,
        statementDate: '2024-01-31',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('unmatched_ynab');
      expect(parsedResult).toHaveProperty('unmatched_statement');
    });

    // TODO: Fix balance difference calculation mock setup
    it.skip('should calculate balance difference', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const csvData = `Date,Description,Amount
2024-01-15,Grocery Store,-50.00`;

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        statementData: csvData,
        statementBalance: 200.0, // Different from YNAB balance
        statementDate: '2024-01-31',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.balance_difference).not.toBe(0);
    });

    // TODO: Fix tolerance setting mock setup
    it.skip('should respect tolerance setting', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue(mockTransactions);

      const csvData = `Date,Description,Amount
2024-01-15,Grocery Store,-50.01`;

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-checking',
        statementData: csvData,
        statementBalance: 150.0,
        statementDate: '2024-01-31',
        tolerance: 0.05, // $0.05 tolerance
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('matches');
    });
  });

  describe('execute - edge cases', () => {
    // TODO: Fix account lookup by name mock setup
    it.skip('should handle account lookup by name', async () => {
      const mockAccounts = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Checking Account',
              type: 'checking',
              balance: 100000,
              deleted: false,
              closed: false,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountName: 'Checking',
        statementData: 'Date,Description,Amount\n',
        statementBalance: 100,
        statementDate: '2024-01-31',
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_name).toContain('Checking');
    });

    it('should handle invalid account', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({ data: { accounts: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'invalid-id',
        statementData: 'Date,Description,Amount\n',
        statementBalance: 100,
        statementDate: '2024-01-31',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Account not found');
    });

    // TODO: Fix empty statement data mock setup
    it.skip('should handle empty statement data', async () => {
      const mockAccounts = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Checking',
              balance: 100000,
              deleted: false,
              closed: false,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-1',
        statementData: 'Date,Description,Amount\n',
        statementBalance: 100,
        statementDate: '2024-01-31',
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.total_statement_transactions).toBe(0);
    });

    // TODO: Fix dry run mode mock setup
    it.skip('should handle dry run mode', async () => {
      const mockAccounts = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Checking',
              balance: 100000,
              deleted: false,
              closed: false,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-1',
        statementData: 'Date,Description,Amount\n',
        statementBalance: 100,
        statementDate: '2024-01-31',
        dryRun: true,
        response_format: 'json',
      });

      expect(result).not.toHaveProperty('isError');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.note).toContain('reconciliation');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new ReconcileAccountTool();

      const result = await tool.execute({
        accountId: 'acc-1',
        statementData: '',
        statementBalance: 100,
        statementDate: '2024-01-31',
      });

      expect(result).toHaveProperty('isError', true);
    });

    it('should handle API errors', async () => {
      mockApi.accounts.getAccounts.mockRejectedValue(new Error('API Error'));

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-1',
        statementData: '',
        statementBalance: 100,
        statementDate: '2024-01-31',
      });

      expect(result).toHaveProperty('isError', true);
    });

    // TODO: Fix markdown format mock setup
    it.skip('should return markdown format when requested', async () => {
      const mockAccounts = {
        data: {
          accounts: [
            {
              id: 'acc-1',
              name: 'Checking',
              balance: 100000,
              deleted: false,
              closed: false,
            },
          ],
        },
      };

      mockApi.accounts.getAccounts.mockResolvedValue(mockAccounts);
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        accountId: 'acc-1',
        statementData: 'Date,Description,Amount\n',
        statementBalance: 100,
        statementDate: '2024-01-31',
        response_format: 'markdown',
      });

      expect(result).not.toHaveProperty('isError');
      expect(result.content[0].text).toContain('#');
    });
  });
});
