import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import BulkApproveTransactionsTool from '../tools/BulkApproveTransactionsTool';

vi.mock('ynab');
vi.mock('../utils/contextOptimizer.js', () => ({
  optimizeTransactions: (transactions: any[]) => transactions,
  withContextOptimization: (fn: any) => fn,
}));

describe('BulkApproveTransactionsTool', () => {
  let tool: BulkApproveTransactionsTool;
  let mockApi: {
    transactions: {
      getTransactions: Mock;
      updateTransaction: Mock;
    };
    accounts: {
      getAccounts: Mock;
    };
    categories: {
      getCategories: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        getTransactions: vi.fn(),
        updateTransaction: vi.fn(),
      },
      accounts: {
        getAccounts: vi.fn(),
      },
      categories: {
        getCategories: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new BulkApproveTransactionsTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_bulk_approve_transactions');
      expect(toolDef.description).toContain('Approve multiple transactions');
    });

    it('should have correct input schema with filters', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('filters');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('payee');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('category');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('account');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('minAmount');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('maxAmount');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('startDate');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('endDate');
      expect(toolDef.inputSchema.properties.filters.properties).toHaveProperty('memo');
    });
  });

  describe('execute', () => {
    const mockTransactions = [
      {
        id: 'txn-1',
        account_id: 'acc-1',
        date: '2024-01-15',
        amount: -50000,
        payee_name: 'Grocery Store',
        payee_id: 'payee-1',
        category_name: 'Groceries',
        category_id: 'cat-1',
        memo: 'Weekly shopping',
        approved: false,
        cleared: ynab.TransactionClearedStatus.Cleared,
        flag_color: null,
        deleted: false,
        subtransactions: [],
      },
      {
        id: 'txn-2',
        account_id: 'acc-1',
        date: '2024-01-16',
        amount: -30000,
        payee_name: 'Gas Station',
        payee_id: 'payee-2',
        category_name: 'Gas',
        category_id: 'cat-2',
        memo: 'Fill up',
        approved: false,
        cleared: ynab.TransactionClearedStatus.Uncleared,
        flag_color: null,
        deleted: false,
        subtransactions: [],
      },
      {
        id: 'txn-3',
        account_id: 'acc-1',
        date: '2024-01-17',
        amount: -100000,
        payee_name: 'Restaurant',
        payee_id: 'payee-3',
        category_name: 'Dining Out',
        category_id: 'cat-3',
        memo: 'Dinner',
        approved: true, // Already approved
        cleared: ynab.TransactionClearedStatus.Cleared,
        flag_color: null,
        deleted: false,
        subtransactions: [],
      },
    ];

    const mockAccounts = [
      {
        id: 'acc-1',
        name: 'Checking Account',
        type: 'checking',
        balance: 500000,
        deleted: false,
        closed: false,
        on_budget: true,
      },
    ];

    const mockCategories = [
      {
        id: 'cat-1',
        name: 'Groceries',
        balance: 0,
        budgeted: 0,
        activity: 0,
        deleted: false,
        hidden: false,
      },
      {
        id: 'cat-2',
        name: 'Gas',
        balance: 0,
        budgeted: 0,
        activity: 0,
        deleted: false,
        hidden: false,
      },
      {
        id: 'cat-3',
        name: 'Dining Out',
        balance: 0,
        budgeted: 0,
        activity: 0,
        deleted: false,
        hidden: false,
      },
    ];

    beforeEach(() => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactions },
      });
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });
      mockApi.categories.getCategories.mockResolvedValue({
        data: {
          category_groups: [
            {
              id: 'group-1',
              name: 'Food',
              categories: mockCategories,
            },
          ],
        },
      });
    });

    it('should approve all unapproved transactions without filters', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.unapprovedTransactions).toBe(2); // txn-1 and txn-2
      expect(parsedResult.approvedTransactions).toHaveLength(2);
    });

    it('should filter by payee name', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          payee: 'Grocery',
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.matchingTransactions).toBe(1);
      expect(parsedResult.unapprovedTransactions).toBe(1);
    });

    it('should filter by category name', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          category: 'Gas',
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.matchingTransactions).toBe(1);
    });

    it('should filter by account name', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          account: 'Checking',
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.matchingTransactions).toBeGreaterThan(0);
    });

    it('should filter by min amount', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          minAmount: -60, // -$60
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      // -$50 and -$30 are both greater than -$60, so both pass (2 unapproved transactions)
      expect(parsedResult.matchingTransactions).toBe(2);
    });

    it('should filter by max amount', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          maxAmount: -40, // -$40
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      // -$50 is less than -$40 (passes), -$30 is greater than -$40 (excluded)
      // -$100 is less than -$40 and also passes (even though approved)
      // matchingTransactions counts all matches before filtering approved status
      expect(parsedResult.matchingTransactions).toBe(2);
    });

    it('should filter by date range', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          startDate: '2024-01-16',
          endDate: '2024-01-16',
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.matchingTransactions).toBe(1); // Only txn-2
    });

    it('should filter by memo text', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          memo: 'shopping',
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.matchingTransactions).toBe(1);
    });

    it('should not execute approvals in dry run mode', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        dryRun: true,
        response_format: 'json',
      });

      expect(mockApi.transactions.updateTransaction).not.toHaveBeenCalled();

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.dryRun).toBe(true);
    });

    it('should handle no unapproved transactions', async () => {
      const allApprovedTransactions = mockTransactions.map(txn => ({
        ...txn,
        approved: true,
      }));

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: allApprovedTransactions },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        dryRun: false,
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('No unapproved transactions found');
    });

    it('should handle API errors during approval', async () => {
      mockApi.transactions.updateTransaction.mockRejectedValue(
        new Error('Update failed')
      );

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.approvedTransactions).toHaveLength(2);
      expect(parsedResult.approvedTransactions.every((t: any) => t.status === 'failed')).toBe(
        true
      );
    }, 15000);

    it('should return markdown format when requested', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        dryRun: true,
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Bulk Approve Transactions');
      expect(result.content[0].text).toContain('## Summary');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new BulkApproveTransactionsTool();

      const result = await tool.execute({
        dryRun: true,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API connection errors', async () => {
      const apiError = new Error('API Error: Connection failed');
      mockApi.transactions.getTransactions.mockRejectedValue(apiError);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        dryRun: true,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error bulk approving transactions');
    });

    it('should combine multiple filters', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        filters: {
          payee: 'Store',
          minAmount: -60,
          startDate: '2024-01-01',
        },
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.matchingTransactions).toBe(1); // Only Grocery Store with -$50
    });
  });
});
