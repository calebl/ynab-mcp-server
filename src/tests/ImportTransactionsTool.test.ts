import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ImportTransactionsTool from '../tools/ImportTransactionsTool';

vi.mock('ynab');

describe('ImportTransactionsTool', () => {
  let mockApi: {
    transactions: {
      importTransactions: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        importTransactions: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('should successfully import transactions', async () => {
      mockApi.transactions.importTransactions.mockResolvedValue({
        data: {
          transaction_ids: ['txn-1', 'txn-2', 'txn-3'],
        },
      });

      const result = await ImportTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.transactions.importTransactions).toHaveBeenCalledWith('test-budget-id');

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.imported_count).toBe(3);
      expect(response.transaction_ids).toEqual(['txn-1', 'txn-2', 'txn-3']);
      expect(response.message).toContain('Successfully imported 3 transaction(s)');
    });

    it('should handle no new transactions to import', async () => {
      mockApi.transactions.importTransactions.mockResolvedValue({
        data: {
          transaction_ids: [],
        },
      });

      const result = await ImportTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.imported_count).toBe(0);
      expect(response.message).toBe('No new transactions to import');
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.transactions.importTransactions.mockResolvedValue({
        data: { transaction_ids: [] },
      });

      await ImportTransactionsTool.execute({}, mockApi as any);

      expect(mockApi.transactions.importTransactions).toHaveBeenCalledWith('test-budget-id');
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ImportTransactionsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.transactions.importTransactions.mockRejectedValue(
        new Error('No linked accounts')
      );

      const result = await ImportTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('No linked accounts');
    });

    it('should handle rate limit error', async () => {
      mockApi.transactions.importTransactions.mockRejectedValue(
        new Error('Rate limit exceeded')
      );

      const result = await ImportTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Rate limit exceeded');
    });

    it('should handle single transaction import', async () => {
      mockApi.transactions.importTransactions.mockResolvedValue({
        data: {
          transaction_ids: ['txn-single'],
        },
      });

      const result = await ImportTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.imported_count).toBe(1);
      expect(response.message).toContain('Successfully imported 1 transaction(s)');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ImportTransactionsTool.name).toBe('ynab_import_transactions');
      expect(ImportTransactionsTool.description).toContain('linked accounts');
    });

    it('should have optional budgetId in input schema', () => {
      expect(ImportTransactionsTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});
