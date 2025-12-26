import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetTransactionsTool from '../tools/GetTransactionsTool';

vi.mock('ynab');

describe('GetTransactionsTool', () => {
  let mockApi: {
    transactions: {
      getTransactions: Mock;
      getTransactionsByAccount: Mock;
      getTransactionsByCategory: Mock;
      getTransactionsByPayee: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        getTransactions: vi.fn(),
        getTransactionsByAccount: vi.fn(),
        getTransactionsByCategory: vi.fn(),
        getTransactionsByPayee: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockTransactionsData = [
      {
        id: 'txn-1',
        date: '2024-01-15',
        amount: -25990,
        memo: 'Shopping',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Amazon',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: false,
      },
      {
        id: 'txn-2',
        date: '2024-01-16',
        amount: -15000,
        memo: 'Groceries',
        approved: false,
        cleared: 'uncleared',
        account_name: 'Checking',
        payee_name: 'Walmart',
        category_name: 'Groceries',
        flag_color: 'blue',
        transfer_account_id: null,
        deleted: false,
      },
      {
        id: 'txn-deleted',
        date: '2024-01-14',
        amount: -5000,
        memo: 'Deleted',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Store',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: true,
      },
    ];

    it('should successfully get all transactions', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        undefined
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions).toHaveLength(2); // Excludes deleted
      expect(response.transaction_count).toBe(2);
    });

    it('should filter out deleted transactions', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const txnIds = response.transactions.map((t: any) => t.id);
      expect(txnIds).not.toContain('txn-deleted');
    });

    it('should get transactions by account', async () => {
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          accountId: 'account-1',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionsByAccount).toHaveBeenCalledWith(
        'test-budget-id',
        'account-1',
        undefined,
        undefined
      );
    });

    it('should get transactions by category', async () => {
      mockApi.transactions.getTransactionsByCategory.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          categoryId: 'category-1',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionsByCategory).toHaveBeenCalledWith(
        'test-budget-id',
        'category-1',
        undefined,
        undefined
      );
    });

    it('should get transactions by payee', async () => {
      mockApi.transactions.getTransactionsByPayee.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          payeeId: 'payee-1',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionsByPayee).toHaveBeenCalledWith(
        'test-budget-id',
        'payee-1',
        undefined,
        undefined
      );
    });

    it('should filter by sinceDate', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          sinceDate: '2024-01-01',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        '2024-01-01',
        undefined
      );
    });

    it('should filter by type unapproved', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted && !t.approved) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          type: 'unapproved',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        ynab.GetTransactionsTypeEnum.Unapproved
      );
    });

    it('should filter by type uncategorized', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: [] },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          type: 'uncategorized',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        ynab.GetTransactionsTypeEnum.Uncategorized
      );
    });

    it('should apply limit to results', async () => {
      const manyTransactions = Array.from({ length: 150 }, (_, i) => ({
        id: `txn-${i}`,
        date: '2024-01-15',
        amount: -1000,
        memo: 'Test',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Store',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: false,
      }));

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: manyTransactions },
      });

      const result = await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          limit: 50,
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions).toHaveLength(50);
      expect(response.total_available).toBe(150);
    });

    it('should use default limit of 100', async () => {
      const manyTransactions = Array.from({ length: 150 }, (_, i) => ({
        id: `txn-${i}`,
        date: '2024-01-15',
        amount: -1000,
        memo: 'Test',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Store',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: false,
      }));

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: manyTransactions },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions).toHaveLength(100);
    });

    it('should format amounts correctly', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions[0].amount).toBe('-25.99');
      expect(response.transactions[1].amount).toBe('-15.00');
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await GetTransactionsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.transactions.getTransactions.mockRejectedValue(new Error('API Error'));

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(GetTransactionsTool.name).toBe('ynab_get_transactions');
      expect(GetTransactionsTool.description).toContain('Gets transactions');
    });

    it('should have filter options in input schema', () => {
      expect(GetTransactionsTool.inputSchema).toHaveProperty('budgetId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('sinceDate');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('type');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('accountId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('categoryId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('payeeId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('limit');
    });
  });
});
