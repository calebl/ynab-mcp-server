import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { z } from 'zod';
import * as ynab from 'ynab';
import * as CreateScheduledTransactionTool from '../tools/CreateScheduledTransactionTool';

vi.mock('ynab');

describe('CreateScheduledTransactionTool', () => {
  let mockApi: {
    scheduledTransactions: {
      createScheduledTransaction: Mock;
    };
  };

  const minimalInput = {
    accountId: 'account-1',
    date: '2026-11-01',
    amount: -1500,
    frequency: 'monthly' as const,
  };

  const createdRow = {
    id: 'st-1',
    date_first: '2026-11-01',
    date_next: '2026-11-01',
    frequency: 'monthly',
    amount: -1500000,
    memo: null,
    flag_color: null,
    account_id: 'account-1',
    account_name: 'Checking',
    payee_id: null,
    payee_name: null,
    category_id: null,
    category_name: null,
    transfer_account_id: null,
    deleted: false,
    subtransactions: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      scheduledTransactions: {
        createScheduledTransaction: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('should send only the given fields, with the amount in milliunits', async () => {
      mockApi.scheduledTransactions.createScheduledTransaction.mockResolvedValue({
        data: { scheduled_transaction: createdRow },
      });

      await CreateScheduledTransactionTool.execute(minimalInput, mockApi as any);

      expect(mockApi.scheduledTransactions.createScheduledTransaction).toHaveBeenCalledWith('test-budget-id', {
        scheduled_transaction: {
          account_id: 'account-1',
          date: '2026-11-01',
          amount: -1500000,
          frequency: 'monthly',
        },
      });
    });

    it('should send every optional field when given', async () => {
      mockApi.scheduledTransactions.createScheduledTransaction.mockResolvedValue({
        data: { scheduled_transaction: createdRow },
      });

      await CreateScheduledTransactionTool.execute(
        {
          ...minimalInput,
          payeeId: 'payee-1',
          payeeName: 'Landlord',
          categoryId: 'cat-1',
          memo: 'Rent',
          flagColor: '',
        },
        mockApi as any
      );

      expect(mockApi.scheduledTransactions.createScheduledTransaction).toHaveBeenCalledWith('test-budget-id', {
        scheduled_transaction: {
          account_id: 'account-1',
          date: '2026-11-01',
          amount: -1500000,
          frequency: 'monthly',
          payee_id: 'payee-1',
          payee_name: 'Landlord',
          category_id: 'cat-1',
          memo: 'Rent',
          flag_color: '',
        },
      });
    });

    it('should return the created row in dollars', async () => {
      mockApi.scheduledTransactions.createScheduledTransaction.mockResolvedValue({
        data: { scheduled_transaction: createdRow },
      });

      const result = await CreateScheduledTransactionTool.execute(minimalInput, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.scheduled_transaction.amount).toBe(-1500);
      expect(response.scheduled_transaction.frequency).toBe('monthly');
      expect(response.scheduled_transaction.date_next).toBe('2026-11-01');
      expect(response.message).toBe('Scheduled transaction created successfully');
    });

    it('should report a missing response row', async () => {
      mockApi.scheduledTransactions.createScheduledTransaction.mockResolvedValue({ data: {} });

      const result = await CreateScheduledTransactionTool.execute(minimalInput, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to create scheduled transaction');
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await CreateScheduledTransactionTool.execute(minimalInput, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should handle API error', async () => {
      mockApi.scheduledTransactions.createScheduledTransaction.mockRejectedValue(new Error('API Error'));

      const result = await CreateScheduledTransactionTool.execute(minimalInput, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });
  });

  describe('tool configuration', () => {
    const schema = z.object(CreateScheduledTransactionTool.inputSchema);

    it('should have correct name and schema fields', () => {
      expect(CreateScheduledTransactionTool.name).toBe('ynab_create_scheduled_transaction');
      for (const key of [
        'planId', 'budgetId', 'accountId', 'date', 'amount', 'frequency',
        'payeeId', 'payeeName', 'categoryId', 'memo', 'flagColor',
      ]) {
        expect(CreateScheduledTransactionTool.inputSchema).toHaveProperty(key);
      }
    });

    it('should validate frequency, date and required fields', () => {
      expect(schema.safeParse({ ...minimalInput, frequency: 'fortnightly' }).success).toBe(false);
      expect(schema.safeParse({ ...minimalInput, frequency: 'everyOtherWeek' }).success).toBe(true);
      expect(schema.safeParse({ ...minimalInput, date: '11/01/2026' }).success).toBe(false);
      const { accountId: _accountId, ...withoutAccount } = minimalInput;
      expect(schema.safeParse(withoutAccount).success).toBe(false);
    });
  });
});
