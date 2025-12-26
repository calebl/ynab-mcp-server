import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as DeleteTransactionTool from '../tools/DeleteTransactionTool';

vi.mock('ynab');

describe('DeleteTransactionTool', () => {
  let mockApi: {
    transactions: {
      deleteTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        deleteTransaction: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockDeleteResponse = {
      data: {
        transaction: {
          id: 'txn-1',
          deleted: true,
        },
      },
    };

    it('should successfully delete a transaction', async () => {
      mockApi.transactions.deleteTransaction.mockResolvedValue(mockDeleteResponse);

      const result = await DeleteTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'txn-1',
        },
        mockApi as any
      );

      expect(mockApi.transactions.deleteTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.transactionId).toBe('txn-1');
      expect(response.message).toBe('Transaction deleted successfully');
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.transactions.deleteTransaction.mockResolvedValue(mockDeleteResponse);

      await DeleteTransactionTool.execute(
        { transactionId: 'txn-1' },
        mockApi as any
      );

      expect(mockApi.transactions.deleteTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1'
      );
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await DeleteTransactionTool.execute(
        { transactionId: 'txn-1' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error for non-existent transaction', async () => {
      mockApi.transactions.deleteTransaction.mockRejectedValue(
        new Error('Transaction not found')
      );

      const result = await DeleteTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'invalid-txn',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Transaction not found');
    });

    it('should handle missing transaction in response', async () => {
      mockApi.transactions.deleteTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const result = await DeleteTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'txn-1',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to delete transaction');
    });

    it('should handle generic API error', async () => {
      mockApi.transactions.deleteTransaction.mockRejectedValue(new Error('Network error'));

      const result = await DeleteTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'txn-1',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Network error');
    });

    it('should handle non-Error exceptions', async () => {
      mockApi.transactions.deleteTransaction.mockRejectedValue('String error');

      const result = await DeleteTransactionTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionId: 'txn-1',
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      // getErrorMessage will stringify the string error
      expect(response.error).toBe('"String error"');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(DeleteTransactionTool.name).toBe('ynab_delete_transaction');
      expect(DeleteTransactionTool.description).toContain('Deletes a transaction');
    });

    it('should warn that action cannot be undone', () => {
      expect(DeleteTransactionTool.description).toContain('cannot be undone');
    });

    it('should have required input schema fields', () => {
      expect(DeleteTransactionTool.inputSchema).toHaveProperty('budgetId');
      expect(DeleteTransactionTool.inputSchema).toHaveProperty('transactionId');
    });
  });
});
