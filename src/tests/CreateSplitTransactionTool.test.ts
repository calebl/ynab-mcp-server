import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as CreateSplitTransactionTool from '../tools/CreateSplitTransactionTool';

vi.mock('ynab');

describe('CreateSplitTransactionTool', () => {
  let mockApi: {
    transactions: {
      createTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        createTransaction: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const validInput = {
      accountId: 'account-123',
      date: '2024-03-24',
      payeeName: 'Walmart',
      memo: 'Weekly shop',
      cleared: true,
      approved: false,
      subtransactions: [
        { amount: 60.00, categoryId: 'cat-groceries', memo: 'Produce' },
        { amount: 25.00, categoryId: 'cat-household', memo: 'Paper goods' },
        { amount: 15.00, categoryId: 'cat-personal', memo: 'Toiletries' },
      ],
    };

    const mockCreatedTransaction = {
      id: 'txn-split-123',
      account_id: 'account-123',
      date: '2024-03-24',
      amount: 100000,
      payee_name: 'Walmart',
      category_id: null,
      memo: 'Weekly shop',
      cleared: ynab.TransactionClearedStatus.Cleared,
      approved: false,
    };

    it('should create a split transaction with payeeName', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const result = await CreateSplitTransactionTool.execute(validInput, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: {
            account_id: 'account-123',
            date: '2024-03-24',
            amount: 100000,
            payee_id: undefined,
            payee_name: 'Walmart',
            category_id: null,
            memo: 'Weekly shop',
            cleared: ynab.TransactionClearedStatus.Cleared,
            approved: false,
            flag_color: undefined,
            subtransactions: [
              { amount: 60000, category_id: 'cat-groceries', memo: 'Produce', payee_id: undefined, payee_name: undefined },
              { amount: 25000, category_id: 'cat-household', memo: 'Paper goods', payee_id: undefined, payee_name: undefined },
              { amount: 15000, category_id: 'cat-personal', memo: 'Toiletries', payee_id: undefined, payee_name: undefined },
            ],
          },
        }
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(true);
      expect(parsed.transactionId).toBe('txn-split-123');
      expect(parsed.totalAmount).toBe('100.00');
      expect(parsed.subtransactionCount).toBe(3);
    });

    it('should create a split transaction with payeeId', async () => {
      const inputWithPayeeId = {
        ...validInput,
        payeeId: 'payee-456',
        payeeName: undefined,
      };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      await CreateSplitTransactionTool.execute(inputWithPayeeId, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            payee_id: 'payee-456',
            payee_name: undefined,
          }),
        })
      );
    });

    it('should use custom budgetId over env var', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      await CreateSplitTransactionTool.execute(
        { ...validInput, budgetId: 'custom-budget-id' },
        mockApi as any
      );

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'custom-budget-id',
        expect.any(Object)
      );
    });

    it('should always set category_id to null on the parent transaction', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      await CreateSplitTransactionTool.execute(validInput, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transaction: expect.objectContaining({ category_id: null }),
        })
      );
    });

    it('should compute parent amount as the sum of subtransaction amounts', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        ...validInput,
        subtransactions: [
          { amount: 10.50, categoryId: 'cat-a' },
          { amount: 5.25, categoryId: 'cat-b' },
        ],
      };

      await CreateSplitTransactionTool.execute(input, mockApi as any);

      // 10500 + 5250 = 15750
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transaction: expect.objectContaining({ amount: 15750 }),
        })
      );
    });

    it('should convert subtransaction dollar amounts to milliunits', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        ...validInput,
        subtransactions: [
          { amount: 1.23, categoryId: 'cat-a' },
          { amount: 4.56, categoryId: 'cat-b' },
        ],
      };

      await CreateSplitTransactionTool.execute(input, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transaction: expect.objectContaining({
            subtransactions: expect.arrayContaining([
              expect.objectContaining({ amount: 1230 }),
              expect.objectContaining({ amount: 4560 }),
            ]),
          }),
        })
      );
    });

    it('should handle negative amounts (expense transactions)', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        ...validInput,
        subtransactions: [
          { amount: -30.00, categoryId: 'cat-a' },
          { amount: -20.00, categoryId: 'cat-b' },
        ],
      };

      await CreateSplitTransactionTool.execute(input, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transaction: expect.objectContaining({
            amount: -50000,
            subtransactions: expect.arrayContaining([
              expect.objectContaining({ amount: -30000 }),
              expect.objectContaining({ amount: -20000 }),
            ]),
          }),
        })
      );
    });

    it('should return error when fewer than 2 subtransactions are provided', async () => {
      const input = {
        ...validInput,
        subtransactions: [{ amount: 100.00, categoryId: 'cat-a' }],
      };

      const result = await CreateSplitTransactionTool.execute(input, mockApi as any);

      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('At least 2 subtransactions');
    });

    it('should return error when neither payeeId nor payeeName is provided', async () => {
      const input = {
        ...validInput,
        payeeName: undefined,
        payeeId: undefined,
      };

      const result = await CreateSplitTransactionTool.execute(input, mockApi as any);

      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('payeeId or payeeName');
    });

    it('should return error when no budget ID is available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await CreateSplitTransactionTool.execute(validInput, mockApi as any);

      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No budget ID provided');
    });

    it('should handle API errors gracefully', async () => {
      mockApi.transactions.createTransaction.mockRejectedValue(
        new Error('API Error: 422 Unprocessable Entity')
      );

      const result = await CreateSplitTransactionTool.execute(validInput, mockApi as any);

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('API Error: 422 Unprocessable Entity');
    });

    it('should return error when API returns null transaction', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const result = await CreateSplitTransactionTool.execute(validInput, mockApi as any);

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('no transaction data returned');
    });

    it('should pass per-subtransaction payee overrides', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        ...validInput,
        subtransactions: [
          { amount: 50.00, categoryId: 'cat-a', payeeName: 'Store A' },
          { amount: 50.00, categoryId: 'cat-b', payeeId: 'payee-789' },
        ],
      };

      await CreateSplitTransactionTool.execute(input, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transaction: expect.objectContaining({
            subtransactions: [
              expect.objectContaining({ payee_name: 'Store A' }),
              expect.objectContaining({ payee_id: 'payee-789' }),
            ],
          }),
        })
      );
    });
  });

  describe('tool configuration', () => {
    it('should have the correct name', () => {
      expect(CreateSplitTransactionTool.name).toBe('ynab_create_split_transaction');
    });

    it('should have a descriptive description', () => {
      expect(CreateSplitTransactionTool.description).toContain('split');
    });

    it('should have the correct input schema fields', () => {
      const schema = CreateSplitTransactionTool.inputSchema;
      expect(schema).toHaveProperty('budgetId');
      expect(schema).toHaveProperty('accountId');
      expect(schema).toHaveProperty('date');
      expect(schema).toHaveProperty('payeeId');
      expect(schema).toHaveProperty('payeeName');
      expect(schema).toHaveProperty('memo');
      expect(schema).toHaveProperty('cleared');
      expect(schema).toHaveProperty('approved');
      expect(schema).toHaveProperty('flagColor');
      expect(schema).toHaveProperty('subtransactions');
    });
  });
});
