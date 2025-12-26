import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListScheduledTransactionsTool from '../tools/ListScheduledTransactionsTool';

vi.mock('ynab');

describe('ListScheduledTransactionsTool', () => {
  let mockApi: {
    scheduledTransactions: {
      getScheduledTransactions: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      scheduledTransactions: {
        getScheduledTransactions: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockScheduledTransactionsData = {
      data: {
        scheduled_transactions: [
          {
            id: 'scheduled-1',
            date_first: '2024-01-01',
            date_next: '2024-02-01',
            frequency: 'monthly',
            amount: -1500000,
            memo: 'Rent payment',
            flag_color: null,
            account_id: 'account-1',
            account_name: 'Checking',
            payee_id: 'payee-1',
            payee_name: 'Landlord',
            category_id: 'cat-1',
            category_name: 'Rent',
            transfer_account_id: null,
            deleted: false,
          },
          {
            id: 'scheduled-2',
            date_first: '2024-01-15',
            date_next: '2024-02-15',
            frequency: 'everyOtherWeek',
            amount: 2500000,
            memo: 'Paycheck',
            flag_color: 'green',
            account_id: 'account-1',
            account_name: 'Checking',
            payee_id: 'payee-2',
            payee_name: 'Employer',
            category_id: 'cat-income',
            category_name: 'Income',
            transfer_account_id: null,
            deleted: false,
          },
          {
            id: 'scheduled-deleted',
            date_first: '2024-01-01',
            date_next: '2024-02-01',
            frequency: 'monthly',
            amount: -50000,
            memo: 'Deleted subscription',
            flag_color: null,
            account_id: 'account-1',
            account_name: 'Checking',
            payee_id: 'payee-3',
            payee_name: 'Old Service',
            category_id: 'cat-2',
            category_name: 'Subscriptions',
            transfer_account_id: null,
            deleted: true,
          },
        ],
      },
    };

    it('should successfully list scheduled transactions', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue(
        mockScheduledTransactionsData
      );

      const result = await ListScheduledTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.scheduledTransactions.getScheduledTransactions).toHaveBeenCalledWith(
        'test-budget-id'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.count).toBe(2); // Excludes deleted
    });

    it('should filter out deleted scheduled transactions', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue(
        mockScheduledTransactionsData
      );

      const result = await ListScheduledTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const txnIds = response.scheduled_transactions.map((t: any) => t.id);
      expect(txnIds).not.toContain('scheduled-deleted');
    });

    it('should format amounts correctly', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue(
        mockScheduledTransactionsData
      );

      const result = await ListScheduledTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const rentPayment = response.scheduled_transactions.find(
        (t: any) => t.memo === 'Rent payment'
      );
      expect(rentPayment.amount).toBe('-1500.00');

      const paycheck = response.scheduled_transactions.find(
        (t: any) => t.memo === 'Paycheck'
      );
      expect(paycheck.amount).toBe('2500.00');
    });

    it('should include all transaction details', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue(
        mockScheduledTransactionsData
      );

      const result = await ListScheduledTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const rentPayment = response.scheduled_transactions.find(
        (t: any) => t.memo === 'Rent payment'
      );

      expect(rentPayment.date_first).toBe('2024-01-01');
      expect(rentPayment.date_next).toBe('2024-02-01');
      expect(rentPayment.frequency).toBe('monthly');
      expect(rentPayment.account_name).toBe('Checking');
      expect(rentPayment.payee_name).toBe('Landlord');
      expect(rentPayment.category_name).toBe('Rent');
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue(
        mockScheduledTransactionsData
      );

      await ListScheduledTransactionsTool.execute({}, mockApi as any);

      expect(mockApi.scheduledTransactions.getScheduledTransactions).toHaveBeenCalledWith(
        'test-budget-id'
      );
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListScheduledTransactionsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockRejectedValue(
        new Error('API Error')
      );

      const result = await ListScheduledTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle empty scheduled transactions list', async () => {
      mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue({
        data: { scheduled_transactions: [] },
      });

      const result = await ListScheduledTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.count).toBe(0);
      expect(response.scheduled_transactions).toHaveLength(0);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListScheduledTransactionsTool.name).toBe('ynab_list_scheduled_transactions');
      expect(ListScheduledTransactionsTool.description).toContain('scheduled');
    });

    it('should have optional budgetId in input schema', () => {
      expect(ListScheduledTransactionsTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});
