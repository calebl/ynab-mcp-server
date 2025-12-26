import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as CreateTransactionTool from '../tools/CreateTransactionTool';

vi.mock('ynab');

describe('CreateTransactionTool', () => {
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
    const validTransactionInput = {
      accountId: 'account-123',
      date: '2023-01-01',
      amount: 50.00,
      payeeName: 'Test Payee',
      categoryId: 'category-123',
      memo: 'Test transaction',
      cleared: true,
      approved: false,
      flagColor: 'red',
    };

    const mockCreatedTransaction = {
      id: 'transaction-123',
      account_id: 'account-123',
      date: '2023-01-01',
      amount: 50000, // $50.00 in milliunits
      payee_name: 'Test Payee',
      category_id: 'category-123',
      memo: 'Test transaction',
      cleared: ynab.TransactionClearedStatus.Cleared,
      approved: false,
      flag_color: 'red' as ynab.TransactionFlagColor,
    };

    it('should successfully create transaction with payee name', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const result = await CreateTransactionTool.execute(validTransactionInput, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: {
            account_id: 'account-123',
            date: '2023-01-01',
            amount: 50000, // $50.00 converted to milliunits
            payee_id: undefined,
            payee_name: 'Test Payee',
            category_id: 'category-123',
            memo: 'Test transaction',
            cleared: ynab.TransactionClearedStatus.Cleared,
            approved: false,
            flag_color: 'red',
          },
        }
      );

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            transactionId: 'transaction-123',
            message: "Transaction created successfully",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should successfully create transaction with payee ID', async () => {
      const inputWithPayeeId = {
        ...validTransactionInput,
        payeeId: 'payee-123',
        payeeName: undefined,
      };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const result = await CreateTransactionTool.execute(inputWithPayeeId, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            payee_id: 'payee-123',
            payee_name: undefined,
          }),
        })
      );
    });

    it('should successfully create transaction with custom budget ID', async () => {
      const inputWithBudgetId = {
        ...validTransactionInput,
        budgetId: 'custom-budget-id',
      };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const result = await CreateTransactionTool.execute(inputWithBudgetId, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'custom-budget-id',
        expect.any(Object)
      );
    });

    it('should handle minimal required fields', async () => {
      const minimalInput = {
        accountId: 'account-123',
        date: '2023-01-01',
        amount: 25.50,
        payeeName: 'Minimal Payee',
      };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const result = await CreateTransactionTool.execute(minimalInput, mockApi as any);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: {
            account_id: 'account-123',
            date: '2023-01-01',
            amount: 25500, // $25.50 converted to milliunits
            payee_id: undefined,
            payee_name: 'Minimal Payee',
            category_id: undefined,
            memo: undefined,
            cleared: ynab.TransactionClearedStatus.Uncleared, // Default when cleared not specified
            approved: false, // Default when approved not specified
            flag_color: undefined,
          },
        }
      );
    });

    it('should convert dollars to milliunits correctly', async () => {
      const testAmounts = [
        { dollars: 1.23, milliunits: 1230 },
        { dollars: 50.00, milliunits: 50000 },
        { dollars: 0.01, milliunits: 10 },
        { dollars: 123.456, milliunits: 123456 }, // Should round to 123456
        { dollars: -25.75, milliunits: -25750 },
      ];

      for (const { dollars, milliunits } of testAmounts) {
        const input = {
          ...validTransactionInput,
          amount: dollars,
        };

        mockApi.transactions.createTransaction.mockResolvedValue({
          data: { transaction: mockCreatedTransaction },
        });

        await CreateTransactionTool.execute(input, mockApi as any);

        expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
          'test-budget-id',
          expect.objectContaining({
            transaction: expect.objectContaining({
              amount: milliunits,
            }),
          })
        );

        mockApi.transactions.createTransaction.mockClear();
      }
    });

    it('should return error when neither payeeId nor payeeName is provided', async () => {
      const invalidInput = {
        accountId: 'account-123',
        date: '2023-01-01',
        amount: 50.00,
        // Missing both payeeId and payeeName
      };

      const result = await CreateTransactionTool.execute(invalidInput, mockApi as any);

      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Either payeeId or payeeName must be provided",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should handle API error', async () => {
      const apiError = new Error('API Error: Unauthorized');
      mockApi.transactions.createTransaction.mockRejectedValue(apiError);

      const result = await CreateTransactionTool.execute(validTransactionInput, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "API Error: Unauthorized",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should handle missing transaction data in response', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const result = await CreateTransactionTool.execute(validTransactionInput, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Failed to create transaction - no transaction data returned",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should throw error when no budget ID is provided', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await CreateTransactionTool.execute(validTransactionInput, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should handle cleared status correctly', async () => {
      const clearedInput = { ...validTransactionInput, cleared: true };
      const unclearedInput = { ...validTransactionInput, cleared: false };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      // Test cleared = true
      await CreateTransactionTool.execute(clearedInput, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Cleared,
          }),
        })
      );

      mockApi.transactions.createTransaction.mockClear();

      // Test cleared = false
      await CreateTransactionTool.execute(unclearedInput, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Uncleared,
          }),
        })
      );
    });

    it('should handle approved status correctly', async () => {
      const approvedInput = { ...validTransactionInput, approved: true };
      const unapprovedInput = { ...validTransactionInput, approved: false };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      // Test approved = true
      await CreateTransactionTool.execute(approvedInput, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            approved: true,
          }),
        })
      );

      mockApi.transactions.createTransaction.mockClear();

      // Test approved = false
      await CreateTransactionTool.execute(unapprovedInput, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            approved: false,
          }),
        })
      );
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(CreateTransactionTool.name).toBe('ynab_create_transaction');
      expect(CreateTransactionTool.description).toContain('Creates a new transaction in your YNAB budget');
    });

    it('should have correct input schema', () => {
      expect(CreateTransactionTool.inputSchema).toHaveProperty('budgetId');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('accountId');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('date');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('amount');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('payeeId');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('payeeName');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('categoryId');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('memo');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('cleared');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('approved');
      expect(CreateTransactionTool.inputSchema).toHaveProperty('flagColor');
    });
  });
});