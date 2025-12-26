import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as BulkApproveTransactionsTool from '../tools/BulkApproveTransactionsTool';

vi.mock('ynab');

describe('BulkApproveTransactionsTool', () => {
  let mockApi: {
    transactions: {
      updateTransactions: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        updateTransactions: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockTransactionsResponse = {
      data: {
        transactions: [
          {
            id: 'txn-1',
            date: '2024-01-15',
            amount: -25990,
            payee_name: 'Amazon',
            approved: true,
          },
          {
            id: 'txn-2',
            date: '2024-01-16',
            amount: -15000,
            payee_name: 'Walmart',
            approved: true,
          },
          {
            id: 'txn-3',
            date: '2024-01-17',
            amount: -8500,
            payee_name: 'Target',
            approved: true,
          },
        ],
      },
    };

    it('should successfully approve multiple transactions', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue(mockTransactionsResponse);

      const result = await BulkApproveTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionIds: ['txn-1', 'txn-2', 'txn-3'],
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transactions: [
            { id: 'txn-1', approved: true },
            { id: 'txn-2', approved: true },
            { id: 'txn-3', approved: true },
          ],
        }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.approved_count).toBe(3);
      expect(response.transactions).toHaveLength(3);
    });

    it('should approve a single transaction', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue({
        data: {
          transactions: [mockTransactionsResponse.data.transactions[0]],
        },
      });

      const result = await BulkApproveTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionIds: ['txn-1'],
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.approved_count).toBe(1);
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue(mockTransactionsResponse);

      await BulkApproveTransactionsTool.execute(
        {
          transactionIds: ['txn-1', 'txn-2'],
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        expect.any(Object)
      );
    });

    it('should return error when no transaction IDs provided', async () => {
      const result = await BulkApproveTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionIds: [],
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No transaction IDs provided');
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await BulkApproveTransactionsTool.execute(
        {
          transactionIds: ['txn-1'],
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.transactions.updateTransactions.mockRejectedValue(new Error('API Error'));

      const result = await BulkApproveTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionIds: ['txn-1'],
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle missing transactions in response', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue({
        data: { transactions: null },
      });

      const result = await BulkApproveTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionIds: ['txn-1'],
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to update transactions');
    });

    it('should format amounts correctly in response', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue(mockTransactionsResponse);

      const result = await BulkApproveTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          transactionIds: ['txn-1', 'txn-2', 'txn-3'],
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions[0].amount).toBe('-25.99');
      expect(response.transactions[1].amount).toBe('-15.00');
      expect(response.transactions[2].amount).toBe('-8.50');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(BulkApproveTransactionsTool.name).toBe('ynab_bulk_approve_transactions');
      expect(BulkApproveTransactionsTool.description).toContain('multiple transactions');
    });

    it('should have required input schema fields', () => {
      expect(BulkApproveTransactionsTool.inputSchema).toHaveProperty('budgetId');
      expect(BulkApproveTransactionsTool.inputSchema).toHaveProperty('transactionIds');
    });
  });
});
