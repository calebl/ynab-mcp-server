import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { z } from 'zod';
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

    it('should clear a flag when flagColor is an empty string', async () => {
      mockApi.transactions.updateTransaction.mockResolvedValue(mockTransactionResponse);

      await UpdateTransactionTool.execute(
        {
          transactionId: 'txn-1',
          flagColor: '',
        },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'txn-1',
        {
          transaction: {
            flag_color: '',
          },
        }
      );
    });

    it('should reject an invalid flag color at the schema level', () => {
      const result = (UpdateTransactionTool.inputSchema.flagColor as z.ZodType).safeParse('chartreuse');
      expect(result.success).toBe(false);
    });

    it('should reject an invalid cleared value at the schema level', () => {
      const result = (UpdateTransactionTool.inputSchema.cleared as z.ZodType).safeParse('invalid');
      expect(result.success).toBe(false);
    });

    it('should reject a date not in YYYY-MM-DD format at the schema level', () => {
      const result = (UpdateTransactionTool.inputSchema.date as z.ZodType).safeParse('01/15/2024');
      expect(result.success).toBe(false);
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

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
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
      expect(response.error).toContain('No plan ID provided');
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

  describe('split transactions', () => {
    let api: any;

    beforeEach(() => {
      api = {
        transactions: {
          getTransactionById: vi.fn().mockResolvedValue({
            data: { transaction: { id: 'txn-1', amount: -100000, subtransactions: [] } },
          }),
          updateTransaction: vi.fn().mockResolvedValue({
            data: {
              transaction: {
                id: 'txn-1',
                amount: -100000,
                category_name: 'Split',
                subtransactions: [
                  { amount: -60000, category_name: 'Groceries', payee_name: null, memo: null, deleted: false },
                  { amount: -40000, category_name: 'Dining Out', payee_name: null, memo: null, deleted: false },
                ],
              },
            },
          }),
        },
        categories: {
          getCategories: vi.fn().mockResolvedValue({
            data: {
              category_groups: [{
                deleted: false,
                hidden: false,
                categories: [
                  { id: 'category-groceries', name: 'Groceries', deleted: false, hidden: false },
                  { id: 'category-dining', name: 'Dining Out', deleted: false, hidden: false },
                ],
              }],
            },
          }),
        },
      };
    });

    const splits = [
      { amount: -60, category_name: 'groceries' },
      { amount: -40, category_name: 'dining' },
    ];

    const update = async (overrides = {}) =>
      JSON.parse((await UpdateTransactionTool.execute(
        { transactionId: 'txn-1', subtransactions: splits, ...overrides } as any,
        api
      )).content[0].text);

    it('splits an ordinary transaction against its current amount', async () => {
      const response = await update();

      expect(response.success).toBe(true);
      expect(response.matchedSplitCategories).toEqual(['Groceries', 'Dining Out']);
      expect(response.transaction.subtransactions).toEqual([
        { amount: -60, category_name: 'Groceries', payee_name: null, memo: null },
        { amount: -40, category_name: 'Dining Out', payee_name: null, memo: null },
      ]);
      expect(api.transactions.updateTransaction).toHaveBeenCalledWith('test-budget-id', 'txn-1', {
        transaction: {
          category_id: null,
          subtransactions: [
            { amount: -60000, category_id: 'category-groceries', payee_name: undefined, memo: undefined },
            { amount: -40000, category_id: 'category-dining', payee_name: undefined, memo: undefined },
          ],
        },
      });
    });

    it('checks the splits against a new amount when one is given', async () => {
      const response = await update({ amount: -120 });

      expect(response.success).toBe(false);
      expect(response.error).toBe('Split amounts add up to -100 but the transaction amount is -120');
      expect(api.transactions.updateTransaction).not.toHaveBeenCalled();
    });

    it('refuses to re-split a transaction that is already split', async () => {
      api.transactions.getTransactionById.mockResolvedValue({
        data: {
          transaction: {
            id: 'txn-1',
            amount: -100000,
            subtransactions: [
              { amount: -50000, deleted: false },
              { amount: -50000, deleted: false },
            ],
          },
        },
      });

      const response = await update();

      expect(response.success).toBe(false);
      expect(response.error).toContain('already split');
      expect(api.transactions.updateTransaction).not.toHaveBeenCalled();
    });

    it('rejects a categoryId alongside splits', async () => {
      const response = await update({ categoryId: 'category-groceries' });

      expect(response.success).toBe(false);
      expect(response.error).toContain('not on a split transaction itself');
      expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
    });

    it('does not read the transaction for ordinary updates', async () => {
      await update({ subtransactions: undefined, memo: 'hi' });

      expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
      expect(api.transactions.updateTransaction.mock.calls[0][2].transaction)
        .not.toHaveProperty('subtransactions');
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
      expect(UpdateTransactionTool.inputSchema).toHaveProperty('subtransactions');
    });
  });
});
