import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetUnapprovedTransactionsTool from '../tools/GetUnapprovedTransactionsTool';

vi.mock('ynab');

describe('GetUnapprovedTransactionsTool', () => {
  let mockApi: {
    transactions: {
      getTransactions: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        getTransactions: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockTransactionsData = [
      {
        id: 'transaction-1',
        date: '2023-01-01',
        amount: -50000, // -$50.00 in milliunits
        memo: 'Test transaction 1',
        approved: false,
        account_name: 'Checking',
        payee_name: 'Test Payee 1',
        category_name: 'Groceries',
        deleted: false,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      },
      {
        id: 'transaction-2',
        date: '2023-01-02',
        amount: -25500, // -$25.50 in milliunits
        memo: 'Test transaction 2',
        approved: false,
        account_name: 'Credit Card',
        payee_name: 'Test Payee 2',
        category_name: 'Dining Out',
        deleted: false,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      },
      {
        id: 'transaction-3',
        date: '2023-01-03',
        amount: -10000, // -$10.00 in milliunits
        memo: 'Test transaction 3',
        approved: false,
        account_name: 'Checking',
        payee_name: 'Test Payee 3',
        category_name: 'Gas',
        deleted: true, // This should be filtered out
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      },
    ];

    it('should successfully get unapproved transactions using budget ID from environment', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetUnapprovedTransactionsTool.execute({}, mockApi as any);

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        ynab.GetTransactionsTypeEnum.Unapproved
      );

      const expectedTransactions = [
        {
          id: 'transaction-1',
          date: '2023-01-01',
          amount: '-50.00',
          memo: 'Test transaction 1',
          approved: false,
          account_name: 'Checking',
          payee_name: 'Test Payee 1',
          category_name: 'Groceries',
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
        {
          id: 'transaction-2',
          date: '2023-01-02',
          amount: '-25.50',
          memo: 'Test transaction 2',
          approved: false,
          account_name: 'Credit Card',
          payee_name: 'Test Payee 2',
          category_name: 'Dining Out',
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            transactions: expectedTransactions,
            transaction_count: 2,
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should successfully get unapproved transactions using provided budget ID', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetUnapprovedTransactionsTool.execute(
        { budgetId: 'custom-budget-id' },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'custom-budget-id',
        undefined,
        ynab.GetTransactionsTypeEnum.Unapproved
      );
    });

    it('should handle empty transactions list', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: [] },
      });

      const result = await GetUnapprovedTransactionsTool.execute({}, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            transactions: [],
            transaction_count: 0,
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should filter out deleted transactions', async () => {
      const transactionsWithDeleted = [
        ...mockTransactionsData,
        {
          id: 'transaction-4',
          date: '2023-01-04',
          amount: -5000,
          memo: 'Deleted transaction',
          approved: false,
          account_name: 'Checking',
          payee_name: 'Deleted Payee',
          category_name: 'Test',
          deleted: true,
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: transactionsWithDeleted },
      });

      const result = await GetUnapprovedTransactionsTool.execute({}, mockApi as any);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transaction_count).toBe(2); // Should not include deleted transactions
      expect(parsedResult.transactions).toHaveLength(2);
    });

    it('should handle API error', async () => {
      const apiError = new Error('API Error: Unauthorized');
      mockApi.transactions.getTransactions.mockRejectedValue(apiError);

      const result = await GetUnapprovedTransactionsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('API Error: Unauthorized');
    });

    it('should throw error when no budget ID is provided', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await GetUnapprovedTransactionsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should convert milliunits to dollars correctly', async () => {
      const testTransactions = [
        {
          id: 'test-1',
          date: '2023-01-01',
          amount: 123456, // $123.456 -> should round to $123.46
          memo: 'Test',
          approved: false,
          account_name: 'Test',
          payee_name: 'Test',
          category_name: 'Test',
          deleted: false,
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: testTransactions },
      });

      const result = await GetUnapprovedTransactionsTool.execute({}, mockApi as any);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transactions[0].amount).toBe('123.46');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(GetUnapprovedTransactionsTool.name).toBe('ynab_get_unapproved_transactions');
      expect(GetUnapprovedTransactionsTool.description).toContain('Gets unapproved transactions from a budget');
    });

    it('should have correct input schema', () => {
      expect(GetUnapprovedTransactionsTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});