import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as UpdateTransactionTool from '../tools/UpdateTransactionTool';

vi.mock('ynab');

describe('UpdateTransactionTool', () => {
  let mockApi: {
    transactions: {
      updateTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        updateTransaction: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockTransactionResponse = {
      data: {
        transaction: {
          id: 'txn-1',
          date: '2024-01-15',
          amount: -25990,
          payee_name: 'Amazon',
          category_name: 'Shopping',
          memo: 'Updated memo',
          cleared: 'cleared',
          approved: true,
          account_name: 'Checking',
          flag_color: 'blue',
        },
      },
    };

    it('should successfully update transaction with all fields', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue(mockTransactionResponse);

      const result = await UpdateTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'txn-1',
          date: '2024-01-15',
          amount: -25.99,
          payeeName: 'Amazon',
          categoryId: 'cat-1',
          memo: 'Updated memo',
          cleared: 'cleared',
          approved: true,
          flagColor: 'blue',
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1',
        {
          transaction: {
            date: '2024-01-15',
            amount: -25990,
            payee_name: 'Amazon',
            category_id: 'cat-1',
            memo: 'Updated memo',
            cleared: ynab.TransactionClearedStatus.Cleared,
            approved: true,
            flag_color: 'blue',
          },
        }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.transaction.id).toBe('txn-1');
    });

    it('should only send provided fields', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue(mockTransactionResponse);

      await UpdateTransactionTool.execute(
        {
          transactionId: 'txn-1',
          memo: 'Just updating memo',
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1',
        {
          transaction: {
            memo: 'Just updating memo',
          },
        }
      );
    });

    it('should handle different cleared statuses', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue(mockTransactionResponse);

      await UpdateTransactionTool.execute(
        {
          transactionId: 'txn-1',
          cleared: 'reconciled',
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1',
        {
          transaction: {
            cleared: ynab.TransactionClearedStatus.Reconciled,
          },
        }
      );
    });

    it('should convert amount to milliunits', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue(mockTransactionResponse);

      await UpdateTransactionTool.execute(
        {
          transactionId: 'txn-1',
          amount: 100.50,
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1',
        {
          transaction: {
            amount: 100500,
          },
        }
      );
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await UpdateTransactionTool.execute(
        {
          transactionId: 'txn-1',
          memo: 'test',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.transactions.updateTransaction.mockRejectedValue(new Error('Transaction not found'));

      const result = await UpdateTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'invalid-txn',
          memo: 'test',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Transaction not found');
    });

    it('should handle missing transaction in response', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const result = await UpdateTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'txn-1',
          memo: 'test',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to update transaction');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(UpdateTransactionTool.name).toBe('ynab_update_transaction');
      expect(UpdateTransactionTool.description).toContain('Updates an existing transaction');
    });

    it('should have required input schema fields', () => {
      expect(UpdateTransactionTool.inputSchema).toHaveProperty('transactionId');
      expect(UpdateTransactionTool.inputSchema).toHaveProperty('budgetId');
      expect(UpdateTransactionTool.inputSchema).toHaveProperty('amount');
      expect(UpdateTransactionTool.inputSchema).toHaveProperty('memo');
      expect(UpdateTransactionTool.inputSchema).toHaveProperty('categoryId');
    });
  });
});
