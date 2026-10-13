import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { z } from 'zod';
import * as ynab from 'ynab';
import * as GetTransactionTool from '../tools/GetTransactionTool';

vi.mock('ynab');

describe('GetTransactionTool', () => {
  let mockApi: {
    transactions: {
      getTransactionById: Mock;
    };
  };

  const transaction = {
    id: 'txn-1',
    date: '2024-01-15',
    amount: -25990,
    memo: 'Shopping',
    approved: true,
    cleared: 'cleared',
    account_id: 'acct-1',
    account_name: 'Checking',
    payee_id: 'payee-1',
    payee_name: 'Amazon',
    category_id: 'cat-1',
    category_name: 'Shopping',
    flag_color: 'red',
    transfer_account_id: null,
    import_id: 'YNAB:-25990:2024-01-15:1',
    deleted: false,
    subtransactions: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        getTransactionById: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('should get one transaction by ID with dollar amounts and IDs', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({ data: { transaction } });

      const result = await GetTransactionTool.execute({ transactionId: 'txn-1' }, mockApi as any);

      expect(mockApi.transactions.getTransactionById).toHaveBeenCalledWith('test-budget-id', 'txn-1');
      const response = JSON.parse(result.content[0].text);
      expect(response.transaction).toEqual({
        id: 'txn-1',
        date: '2024-01-15',
        amount: -25.99,
        memo: 'Shopping',
        approved: true,
        cleared: 'cleared',
        account_id: 'acct-1',
        account_name: 'Checking',
        payee_id: 'payee-1',
        payee_name: 'Amazon',
        category_id: 'cat-1',
        category_name: 'Shopping',
        flag_color: 'red',
        transfer_account_id: null,
        import_id: 'YNAB:-25990:2024-01-15:1',
        deleted: false,
      });
      expect(response.transaction).not.toHaveProperty('subtransactions');
    });

    it('should return the non-deleted legs of a split', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: {
          transaction: {
            ...transaction,
            category_name: 'Split',
            subtransactions: [
              { id: 'sub-1', amount: -20000, category_name: 'Household', memo: null, deleted: false },
              { id: 'sub-2', amount: -5990, category_name: 'Groceries', memo: null, deleted: false },
              { id: 'sub-3', amount: -1000, category_name: 'Gone', memo: null, deleted: true },
            ],
          },
        },
      });

      const result = await GetTransactionTool.execute({ transactionId: 'txn-1' }, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.transaction.subtransactions).toHaveLength(2);
      expect(response.transaction.subtransactions.map((s: any) => s.amount)).toEqual([-20, -5.99]);
    });

    it('should return a deleted transaction with deleted: true', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: { ...transaction, deleted: true } },
      });

      const result = await GetTransactionTool.execute({ transactionId: 'txn-1' }, mockApi as any);

      expect(JSON.parse(result.content[0].text).transaction.deleted).toBe(true);
    });

    it('should report a missing transaction', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({ data: { transaction: undefined } });

      const result = await GetTransactionTool.execute({ transactionId: 'txn-1' }, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Transaction not found');
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await GetTransactionTool.execute({ transactionId: 'txn-1' }, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should handle API error', async () => {
      mockApi.transactions.getTransactionById.mockRejectedValue(new Error('API Error'));

      const result = await GetTransactionTool.execute({ transactionId: 'txn-1' }, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and schema', () => {
      expect(GetTransactionTool.name).toBe('ynab_get_transaction');
      expect(GetTransactionTool.inputSchema).toHaveProperty('planId');
      expect(GetTransactionTool.inputSchema).toHaveProperty('budgetId');
      expect(GetTransactionTool.inputSchema).toHaveProperty('transactionId');
    });

    it('should require transactionId', () => {
      expect(z.object(GetTransactionTool.inputSchema).safeParse({}).success).toBe(false);
    });
  });
});
