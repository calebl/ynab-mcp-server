import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as UpdateScheduledTransactionTool from '../tools/UpdateScheduledTransactionTool';

vi.mock('ynab');

describe('UpdateScheduledTransactionTool', () => {
  let mockApi: {
    scheduledTransactions: {
      getScheduledTransactionById: Mock;
      updateScheduledTransaction: Mock;
    };
  };

  const existing = {
    id: 'st-1',
    account_id: 'account-1',
    date_first: '2024-01-01',
    date_next: '2026-11-01',
    frequency: 'monthly',
    amount: -1500000,
    payee_id: 'payee-1',
    category_id: 'cat-1',
    memo: 'Rent',
    flag_color: 'red',
    deleted: false,
    subtransactions: [] as any[],
  };

  function givenExisting(row: Record<string, unknown> = existing) {
    mockApi.scheduledTransactions.getScheduledTransactionById.mockResolvedValue({
      data: { scheduled_transaction: row },
    });
  }

  function putBody() {
    return mockApi.scheduledTransactions.updateScheduledTransaction.mock.calls[0][2].scheduled_transaction;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      scheduledTransactions: {
        getScheduledTransactionById: vi.fn(),
        updateScheduledTransaction: vi.fn().mockImplementation(
          async (_plan: string, _id: string, body: any) => ({
            data: { scheduled_transaction: { ...existing, ...body.scheduled_transaction } },
          })
        ),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('should keep every unchanged field when only the amount changes', async () => {
      givenExisting();

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1600 },
        mockApi as any
      );

      expect(mockApi.scheduledTransactions.getScheduledTransactionById).toHaveBeenCalledTimes(1);
      expect(mockApi.scheduledTransactions.getScheduledTransactionById).toHaveBeenCalledWith('test-budget-id', 'st-1');
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).toHaveBeenCalledTimes(1);
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).toHaveBeenCalledWith('test-budget-id', 'st-1', {
        scheduled_transaction: {
          account_id: 'account-1',
          date: '2026-11-01',
          amount: -1600000,
          frequency: 'monthly',
          payee_id: 'payee-1',
          category_id: 'cat-1',
          memo: 'Rent',
          flag_color: 'red',
        },
      });
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.scheduled_transaction.amount).toBe(-1600);
      expect(response.message).toBe('Scheduled transaction updated successfully');
    });

    it('should switch to a payee by name', async () => {
      givenExisting();

      await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', payeeName: 'New Landlord' },
        mockApi as any
      );

      expect(putBody()).toMatchObject({ payee_id: null, payee_name: 'New Landlord' });
    });

    it('should prefer payeeId over payeeName', async () => {
      givenExisting();

      await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', payeeId: 'payee-2', payeeName: 'ignored' },
        mockApi as any
      );

      expect(putBody().payee_id).toBe('payee-2');
      expect(putBody()).not.toHaveProperty('payee_name');
    });

    it('should honour empty memo and flag color', async () => {
      givenExisting();

      await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', memo: '', flagColor: '' },
        mockApi as any
      );

      expect(putBody()).toMatchObject({ memo: '', flag_color: '' });
    });

    it('should send null for fields the existing row lacks', async () => {
      givenExisting({
        ...existing,
        memo: undefined,
        flag_color: null,
        category_id: undefined,
        payee_id: undefined,
      });

      await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', frequency: 'yearly' },
        mockApi as any
      );

      expect(putBody()).toMatchObject({
        memo: null,
        flag_color: null,
        category_id: null,
        payee_id: null,
        frequency: 'yearly',
      });
    });

    it('should refuse an update with no fields without calling YNAB', async () => {
      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('No fields to update');
      expect(mockApi.scheduledTransactions.getScheduledTransactionById).not.toHaveBeenCalled();
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });

    it('should refuse a deleted scheduled transaction', async () => {
      givenExisting({ ...existing, deleted: true });

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      expect(JSON.parse(result.content[0].text).error).toBe('Scheduled transaction st-1 has been deleted');
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });

    it('should refuse a split scheduled transaction', async () => {
      givenExisting({ ...existing, subtransactions: [{ id: 'sub-1', amount: -1000, deleted: false }] });

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      expect(JSON.parse(result.content[0].text).error).toContain('is split');
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });

    it('should update when every subtransaction is deleted', async () => {
      givenExisting({ ...existing, subtransactions: [{ id: 'sub-1', amount: -1000, deleted: true }] });

      await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      expect(mockApi.scheduledTransactions.updateScheduledTransaction).toHaveBeenCalledTimes(1);
    });

    it('should report a missing response row', async () => {
      givenExisting();
      mockApi.scheduledTransactions.updateScheduledTransaction.mockResolvedValue({ data: {} });

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      expect(JSON.parse(result.content[0].text).error).toContain('Failed to update scheduled transaction');
    });

    it('should report a scheduled transaction that is not found', async () => {
      mockApi.scheduledTransactions.getScheduledTransactionById.mockResolvedValue({ data: {} });

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Scheduled transaction not found: st-1');
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should handle API error', async () => {
      mockApi.scheduledTransactions.getScheduledTransactionById.mockRejectedValue(new Error('API Error'));

      const result = await UpdateScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1', amount: -1 },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and schema fields', () => {
      expect(UpdateScheduledTransactionTool.name).toBe('ynab_update_scheduled_transaction');
      for (const key of [
        'planId', 'budgetId', 'scheduledTransactionId', 'accountId', 'date', 'amount',
        'frequency', 'payeeId', 'payeeName', 'categoryId', 'memo', 'flagColor',
      ]) {
        expect(UpdateScheduledTransactionTool.inputSchema).toHaveProperty(key);
      }
    });
  });
});
