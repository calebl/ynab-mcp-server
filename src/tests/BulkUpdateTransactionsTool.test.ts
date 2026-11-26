import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { z } from 'zod';
import * as ynab from 'ynab';
import * as BulkUpdateTransactionsTool from '../tools/BulkUpdateTransactionsTool';

vi.mock('ynab');

describe('BulkUpdateTransactionsTool', () => {
  let mockApi: {
    transactions: {
      updateTransactions: Mock;
      getTransactionById: Mock;
      getTransactions: Mock;
    };
  };

  const savedTxn = (id: string, amount: number) => ({
    id,
    date: '2024-01-15',
    amount,
    payee_name: 'Amazon',
    category_name: 'Shopping',
    memo: null,
    cleared: 'cleared',
    approved: true,
    flag_color: null,
  });

  const splitTxn = (id: string) => ({
    id,
    deleted: false,
    subtransactions: [
      { id: 's1', amount: -5000, deleted: false },
      { id: 's2', amount: -5000, deleted: false },
    ],
  });
  const plainTxn = (id: string, subtransactions: any[] = []) => ({ id, deleted: false, subtransactions });

  async function run(updates: any[]) {
    const result = await BulkUpdateTransactionsTool.execute({ updates }, mockApi as any);
    return JSON.parse(result.content[0].text);
  }

  function sentItems() {
    return mockApi.transactions.updateTransactions.mock.calls[0][1].transactions;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        updateTransactions: vi.fn().mockResolvedValue({ data: { transaction_ids: [], transactions: [] } }),
        getTransactionById: vi.fn(),
        getTransactions: vi.fn().mockResolvedValue({ data: { transactions: [] } }),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('should send every update in one call with SDK field names', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [plainTxn('txn-2')] } });
      await run([
        { transactionId: 'txn-1', amount: -10.5, cleared: 'reconciled' },
        { transactionId: 'txn-2', memo: 'x', categoryId: 'cat-1', payeeId: 'payee-1', flagColor: 'red' },
        { transactionId: 'txn-3', approved: true, flagColor: '' },
      ]);

      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledTimes(1);
      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledWith('test-budget-id', {
        transactions: [
          { id: 'txn-1', amount: -10500, cleared: 'reconciled' },
          { id: 'txn-2', memo: 'x', category_id: 'cat-1', payee_id: 'payee-1', flag_color: 'red' },
          { id: 'txn-3', approved: true, flag_color: null },
        ],
      });
      expect(mockApi.transactions.getTransactionById).not.toHaveBeenCalled();
    });

    it('should keep a zero amount', async () => {
      await run([{ transactionId: 'txn-1', amount: 0 }]);

      expect(sentItems()[0]).toEqual({ id: 'txn-1', amount: 0 });
    });

    it('should treat null fields as omitted', async () => {
      await run([{ transactionId: 'txn-1', memo: null, approved: false }]);

      expect(sentItems()[0]).toEqual({ id: 'txn-1', approved: false });
    });

    it('should report every update as saved', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue({
        data: {
          transaction_ids: ['txn-1', 'txn-2'],
          transactions: [savedTxn('txn-1', -10500), savedTxn('txn-2', -2000)],
        },
      });

      const response = await run([
        { transactionId: 'txn-1', amount: -10.5 },
        { transactionId: 'txn-2', amount: -2 },
      ]);

      expect(response.success).toBe(true);
      expect(response.requested_count).toBe(2);
      expect(response.updated_count).toBe(2);
      expect(response.not_updated_count).toBe(0);
      expect(response.rejected_count).toBe(0);
      expect(response.results.map((r: any) => r.transactionId)).toEqual(['txn-1', 'txn-2']);
      expect(response.results.every((r: any) => r.status === 'updated')).toBe(true);
      expect(response.results[0].transaction.amount).toBe(-10.5);
      expect(response).not.toHaveProperty('error');
    });

    it('should report updates YNAB did not save as a failure with all results', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue({
        data: { transaction_ids: ['txn-1'], transactions: [savedTxn('txn-1', -10500)] },
      });

      const response = await run([
        { transactionId: 'txn-1', amount: -10.5 },
        { transactionId: 'txn-2', amount: -2 },
      ]);

      expect(response.success).toBe(false);
      expect(response.requested_count).toBe(2);
      expect(response.updated_count).toBe(1);
      expect(response.not_updated_count).toBe(1);
      expect(response.results[1]).toEqual({ transactionId: 'txn-2', status: 'not_updated' });
      expect(response.error).toContain('txn-2');
    });

    it('should omit the transaction summary when YNAB returns none', async () => {
      mockApi.transactions.updateTransactions.mockResolvedValue({
        data: { transaction_ids: ['txn-1'] },
      });

      const response = await run([{ transactionId: 'txn-1', amount: -1 }]);

      expect(response.results[0]).toEqual({ transactionId: 'txn-1', status: 'updated' });
    });

    it('should refuse an empty update list', async () => {
      const response = await run([]);

      expect(response.success).toBe(false);
      expect(response.error).toBe('No updates provided');
      expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
      expect(mockApi.transactions.getTransactions).not.toHaveBeenCalled();
    });

    it('should refuse an update with no fields', async () => {
      const response = await run([{ transactionId: 'txn-1' }, { transactionId: 'txn-2', categoryId: 'cat-1' }]);
      expect(mockApi.transactions.getTransactions).not.toHaveBeenCalled();

      expect(response.success).toBe(false);
      expect(response.error).toBe('Update for transaction txn-1 has no fields to change');
      expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
    });

    it('should refuse a repeated transactionId', async () => {
      const response = await run([
        { transactionId: 'txn-1', categoryId: 'cat-1' },
        { transactionId: 'txn-1', categoryId: 'cat-1' },
      ]);
      expect(mockApi.transactions.getTransactions).not.toHaveBeenCalled();

      expect(response.success).toBe(false);
      expect(response.error).toBe('Duplicate transactionId in updates: txn-1');
      expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const response = await run([{ transactionId: 'txn-1', amount: -1 }]);

      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should reject a category change on a split and send the rest', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [splitTxn('txn-1')] } });
      mockApi.transactions.updateTransactions.mockResolvedValue({ data: { transaction_ids: ['txn-2'], transactions: [] } });

      const response = await run([
        { transactionId: 'txn-1', categoryId: 'cat-1' },
        { transactionId: 'txn-2', memo: 'x' },
      ]);

      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledTimes(1);
      expect(sentItems().map((i: any) => i.id)).toEqual(['txn-2']);
      expect(response.results[0].status).toBe('rejected');
      expect(response.results[0].reason).toContain('txn-1');
      expect(response.results[0].reason).toContain('cannot change the category of a split');
      expect(response.success).toBe(false);
      expect([response.requested_count, response.updated_count, response.not_updated_count, response.rejected_count]).toEqual([2, 1, 0, 1]);
      expect(response.error).toContain('txn-1');
    });

    it('should let a non-split with category through', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [plainTxn('txn-1')] } });
      mockApi.transactions.updateTransactions.mockResolvedValue({ data: { transaction_ids: ['txn-1'] } });
      let response = await run([{ transactionId: 'txn-1', categoryId: 'cat-1' }]);
      expect(sentItems()[0]).toEqual({ id: 'txn-1', category_id: 'cat-1' });
      expect(response.results[0].status).toBe('updated');
      expect(response.success).toBe(true);

      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [plainTxn('txn-1', [{ id: 's1', deleted: true }])] } });
      response = await run([{ transactionId: 'txn-1', categoryId: 'cat-1' }]);
      expect(response.results[0].status).toBe('updated');
      expect(response.success).toBe(true);
    });

    it('should handle a mixed batch in input order', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: [splitTxn('a'), plainTxn('b')] },
      });
      const updates = [
        { transactionId: 'a', categoryId: 'cat-1' },
        { transactionId: 'b', categoryId: 'cat-1' },
        { transactionId: 'c', memo: 'x' },
      ];
      mockApi.transactions.updateTransactions.mockResolvedValue({ data: { transaction_ids: ['b', 'c'] } });
      let response = await run(updates);
      expect(sentItems().map((i: any) => i.id)).toEqual(['b', 'c']);
      expect(response.results.map((r: any) => r.status)).toEqual(['rejected', 'updated', 'updated']);
      expect([response.requested_count, response.updated_count, response.not_updated_count, response.rejected_count]).toEqual([3, 2, 0, 1]);

      mockApi.transactions.updateTransactions.mockResolvedValue({ data: { transaction_ids: ['c'] } });
      response = await run(updates);
      expect(response.results.map((r: any) => r.status)).toEqual(['rejected', 'not_updated', 'updated']);
      expect([response.updated_count, response.not_updated_count, response.rejected_count]).toEqual([1, 1, 1]);
      expect(response.error).toBe(`1 transaction(s) were not updated: b; 1 transaction(s) were rejected: a (${response.results[0].reason})`);
    });

    it('should not write when every item is rejected', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [splitTxn('txn-1')] } });

      const response = await run([{ transactionId: 'txn-1', categoryId: 'cat-1' }]);

      expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
      expect(response.success).toBe(false);
      expect([response.requested_count, response.updated_count, response.not_updated_count, response.rejected_count]).toEqual([1, 0, 0, 1]);
      expect(response.results[0].status).toBe('rejected');
    });

    it('should not write when the list read fails', async () => {
      mockApi.transactions.getTransactions.mockRejectedValue(new Error('API Error'));

      const response = await run([{ transactionId: 'txn-1', categoryId: 'cat-1' }]);

      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
      expect(response.results).toBeUndefined();
      expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
    });

    it('should reject an id absent from the list', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [plainTxn('other')] } });

      const response = await run([{ transactionId: 'txn-9', categoryId: 'cat-1' }]);

      expect(response.results[0].status).toBe('rejected');
      expect(response.results[0].reason).toContain('Transaction not found: txn-9');
    });

    it('No reads without categoryId', async () => {
      await run([
        { transactionId: 'a', amount: -1 },
        { transactionId: 'b', memo: 'x' },
        { transactionId: 'c', approved: true },
        { transactionId: 'd', categoryId: null, memo: 'y' },
      ]);

      expect(mockApi.transactions.getTransactions).not.toHaveBeenCalled();
      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledTimes(1);
    });

    it('One read for many categoryId items', async () => {
      await run([
        { transactionId: 'a', categoryId: 'c1' },
        { transactionId: 'b', categoryId: 'c1' },
        { transactionId: 'c', categoryId: 'c1' },
      ]);

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledTimes(1);
      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('test-budget-id');
      expect(mockApi.transactions.getTransactionById).not.toHaveBeenCalled();
    });

    it('should handle API error without per-item results', async () => {
      mockApi.transactions.updateTransactions.mockRejectedValue(new Error('API Error'));

      const response = await run([{ transactionId: 'txn-1', amount: -1 }]);

      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
      expect(response.results).toBeUndefined();
    });
  });

  describe('tool configuration', () => {
    const schema = z.object(BulkUpdateTransactionsTool.inputSchema);
    const item = { transactionId: 'txn-1', amount: -1 };

    it('should have correct name and schema fields', () => {
      expect(BulkUpdateTransactionsTool.name).toBe('ynab_bulk_update_transactions');
      expect(BulkUpdateTransactionsTool.inputSchema).toHaveProperty('planId');
      expect(BulkUpdateTransactionsTool.inputSchema).toHaveProperty('budgetId');
      expect(BulkUpdateTransactionsTool.inputSchema).toHaveProperty('updates');
    });

    it('should accept between 1 and 500 updates', () => {
      expect(schema.safeParse({ updates: [] }).success).toBe(false);
      expect(schema.safeParse({ updates: Array.from({ length: 501 }, (_, i) => ({ ...item, transactionId: `t${i}` })) }).success).toBe(false);
      expect(schema.safeParse({ updates: [item] }).success).toBe(true);
    });

    it('should reject invalid cleared and flag values', () => {
      expect(schema.safeParse({ updates: [{ ...item, cleared: true }] }).success).toBe(false);
      expect(schema.safeParse({ updates: [{ ...item, flagColor: 'pink' }] }).success).toBe(false);
    });

    it('should reject an empty transactionId and mention splits', () => {
      expect(schema.safeParse({ updates: [{ transactionId: '', memo: 'x' }] }).success).toBe(false);
      expect(BulkUpdateTransactionsTool.description).toContain('split');
    });

    it('should describe every update field', () => {
      const jsonSchema = z.toJSONSchema(schema) as any;
      const properties = jsonSchema.properties.updates.items.properties;
      for (const [field, property] of Object.entries(properties)) {
        expect(typeof (property as any).description, field).toBe('string');
        expect((property as any).description.length, field).toBeGreaterThan(0);
      }
    });
  });
});
