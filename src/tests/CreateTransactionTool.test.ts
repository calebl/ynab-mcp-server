import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { z } from 'zod';
import * as ynab from 'ynab';
import * as CreateTransactionTool from '../tools/CreateTransactionTool';

vi.mock('ynab');

describe('CreateTransactionTool', () => {
  let mockApi: {
    transactions: {
      createTransaction: Mock;
    };
    accounts: {
      getAccounts: Mock;
    };
    categories: {
      getCategories: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        createTransaction: vi.fn(),
      },
      accounts: {
        getAccounts: vi.fn().mockResolvedValue({
          data: {
            accounts: [
              { id: 'account-checking', name: 'Ally Checking', deleted: false, closed: false },
              { id: 'account-card', name: 'Apple Card', deleted: false, closed: false },
              { id: 'account-old', name: 'Old Checking', deleted: false, closed: true },
            ],
          },
        }),
      },
      categories: {
        getCategories: vi.fn().mockResolvedValue({
          data: {
            category_groups: [
              {
                id: 'group-1',
                name: 'Everyday',
                deleted: false,
                hidden: false,
                categories: [
                  { id: 'category-groceries', name: 'Groceries', deleted: false, hidden: false },
                  { id: 'category-dining', name: 'Dining Out', deleted: false, hidden: false },
                  { id: 'category-hidden', name: 'Retired Category', deleted: false, hidden: true },
                ],
              },
            ],
          },
        }),
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
      cleared: 'cleared' as const,
      approved: false,
      flagColor: 'red' as const,
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

    it('should return an error when no plan ID is provided', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await CreateTransactionTool.execute(validTransactionInput, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "No plan ID provided. Please provide planId or set the YNAB_PLAN_ID environment variable.",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should handle cleared status correctly', async () => {
      const clearedInput = { ...validTransactionInput, cleared: 'cleared' as const };
      const unclearedInput = { ...validTransactionInput, cleared: 'uncleared' as const };
      const reconciledInput = { ...validTransactionInput, cleared: 'reconciled' as const };

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      // Test cleared = 'cleared'
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

      // Test cleared = 'uncleared'
      await CreateTransactionTool.execute(unclearedInput, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Uncleared,
          }),
        })
      );

      mockApi.transactions.createTransaction.mockClear();

      // Test cleared = 'reconciled'
      await CreateTransactionTool.execute(reconciledInput, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Reconciled,
          }),
        })
      );
    });

    it('should default cleared to uncleared when omitted', async () => {
      const { cleared, ...inputWithoutCleared } = validTransactionInput;

      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      await CreateTransactionTool.execute(inputWithoutCleared as any, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Uncleared,
          }),
        })
      );
    });

    it('should reject an invalid cleared value at the schema level', () => {
      const result = (CreateTransactionTool.inputSchema.cleared as z.ZodType).safeParse('invalid');
      expect(result.success).toBe(false);
    });

    it('should reject a boolean cleared value at the schema level', () => {
      const result = (CreateTransactionTool.inputSchema.cleared as z.ZodType).safeParse(true);
      expect(result.success).toBe(false);
    });

    it('should accept every flag color and pass it through unmodified', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      for (const flagColor of ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const) {
        expect((CreateTransactionTool.inputSchema.flagColor as z.ZodType).safeParse(flagColor).success).toBe(true);

        await CreateTransactionTool.execute({ ...validTransactionInput, flagColor }, mockApi as any);
        expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
          'test-budget-id',
          expect.objectContaining({
            transaction: expect.objectContaining({ flag_color: flagColor }),
          })
        );

        mockApi.transactions.createTransaction.mockClear();
      }
    });

    it('should clear a flag when flagColor is an empty string', async () => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      await CreateTransactionTool.execute({ ...validTransactionInput, flagColor: '' }, mockApi as any);
      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          transaction: expect.objectContaining({ flag_color: '' }),
        })
      );
    });

    it('should reject an invalid flag color at the schema level', () => {
      const result = (CreateTransactionTool.inputSchema.flagColor as z.ZodType).safeParse('chartreuse');
      expect(result.success).toBe(false);
    });

    it('should reject a date not in YYYY-MM-DD format at the schema level', () => {
      const result = (CreateTransactionTool.inputSchema.date as z.ZodType).safeParse('03/24/2024');
      expect(result.success).toBe(false);
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

  describe('name resolution', () => {
    beforeEach(() => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: { id: 'transaction-123' } },
      });
    });

    const byName = (overrides = {}) =>
      CreateTransactionTool.execute(
        { date: '2024-03-01', amount: -12, payeeName: 'Coffee Place', ...overrides } as any,
        mockApi as any
      );

    it('resolves an account name to an id', async () => {
      const result = await byName({ accountName: 'ally checking' });
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.matchedAccount).toBe('Ally Checking');
      expect(mockApi.transactions.createTransaction.mock.calls[0][1].transaction.account_id)
        .toBe('account-checking');
    });

    it('resolves a category name to an id', async () => {
      const result = await byName({ accountName: 'apple card', categoryName: 'groceries' });
      const response = JSON.parse(result.content[0].text);

      expect(response.matchedCategory).toBe('Groceries');
      expect(mockApi.transactions.createTransaction.mock.calls[0][1].transaction.category_id)
        .toBe('category-groceries');
    });

    it('skips the lookup entirely when ids are given', async () => {
      await byName({ accountId: 'account-explicit', categoryId: 'category-explicit' });

      expect(mockApi.accounts.getAccounts).not.toHaveBeenCalled();
      expect(mockApi.categories.getCategories).not.toHaveBeenCalled();
    });

    it('prefers an explicit id over a name', async () => {
      await byName({ accountId: 'account-explicit', accountName: 'ally checking' });

      expect(mockApi.accounts.getAccounts).not.toHaveBeenCalled();
      expect(mockApi.transactions.createTransaction.mock.calls[0][1].transaction.account_id)
        .toBe('account-explicit');
    });

    it('does not match closed accounts or hidden categories', async () => {
      const closed = JSON.parse((await byName({ accountName: 'old' })).content[0].text);
      expect(closed.success).toBe(false);
      expect(closed.error).toContain('No account matching');

      const hidden = JSON.parse(
        (await byName({ accountName: 'apple card', categoryName: 'retired' })).content[0].text
      );
      expect(hidden.success).toBe(false);
      expect(hidden.error).toContain('No category matching');
    });

    it('refuses to guess between equally good matches', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: {
          accounts: [
            { id: 'a1', name: 'Ally Checking', deleted: false, closed: false },
            { id: 'a2', name: 'Ally Savings', deleted: false, closed: false },
          ],
        },
      });

      const result = await byName({ accountName: 'ally' });
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('ambiguous');
      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
    });

    it('requires either an account id or an account name', async () => {
      const result = await byName({});
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Either accountId or accountName must be provided');
    });
  });

  describe('split transactions', () => {
    beforeEach(() => {
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: { id: 'transaction-123' } },
      });
    });

    const split = (overrides = {}) =>
      CreateTransactionTool.execute(
        {
          accountId: 'account-checking',
          date: '2024-03-01',
          amount: -100,
          payeeName: 'Costco',
          subtransactions: [
            { amount: -60, category_name: 'groceries', memo: 'food' },
            { amount: -40, category_name: 'dining', payee_name: 'Costco Food Court' },
          ],
          ...overrides,
        } as any,
        mockApi as any
      );

    it('creates subtransactions with resolved categories and milliunit amounts', async () => {
      const response = JSON.parse((await split()).content[0].text);

      expect(response.success).toBe(true);
      expect(response.matchedSplitCategories).toEqual(['Groceries', 'Dining Out']);

      const transaction = mockApi.transactions.createTransaction.mock.calls[0][1].transaction;
      expect(transaction.category_id).toBeUndefined();
      expect(transaction.subtransactions).toEqual([
        { amount: -60000, category_id: 'category-groceries', payee_name: undefined, memo: 'food' },
        { amount: -40000, category_id: 'category-dining', payee_name: 'Costco Food Court', memo: undefined },
      ]);
      expect(mockApi.categories.getCategories).toHaveBeenCalledTimes(1);
    });

    it('accepts splits exactly as ynab_get_transactions returns them', async () => {
      const response = JSON.parse((await split({
        subtransactions: [
          { amount: -60, category_name: 'Groceries', payee_name: null, memo: null },
          { amount: -40, category_name: null, payee_name: null, memo: null },
        ],
      })).content[0].text);

      expect(response.success).toBe(true);
      expect(mockApi.transactions.createTransaction.mock.calls[0][1].transaction.subtransactions[1])
        .toEqual({ amount: -40000, category_id: undefined, payee_name: undefined, memo: undefined });
    });

    it('rejects splits that do not add up to the transaction amount', async () => {
      const response = JSON.parse((await split({ amount: -99.99 })).content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Split amounts add up to -100 but the transaction amount is -99.99');
      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
    });

    it('sums in milliunits so float cents do not cause false mismatches', async () => {
      const response = JSON.parse((await split({
        amount: 0.3,
        subtransactions: [{ amount: 0.1 }, { amount: 0.2 }],
      })).content[0].text);

      expect(response.success).toBe(true);
    });

    it('rejects a category on the parent of a split', async () => {
      const response = JSON.parse((await split({ categoryName: 'groceries' })).content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('not on a split transaction itself');
      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
    });

    it('fails without writing when a split category does not match', async () => {
      const response = JSON.parse((await split({
        subtransactions: [
          { amount: -60, category_name: 'groceries' },
          { amount: -40, category_name: 'retired' },
        ],
      })).content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toContain('No category matching');
      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
    });

    it('requires at least two splits at the schema level', () => {
      const schema = CreateTransactionTool.inputSchema.subtransactions as z.ZodType;
      expect(schema.safeParse([{ amount: -10 }]).success).toBe(false);
      expect(schema.safeParse([{ amount: -5 }, { amount: -5 }]).success).toBe(true);
    });

    it('omits subtransactions from ordinary transactions', async () => {
      await split({ subtransactions: undefined });

      expect(mockApi.transactions.createTransaction.mock.calls[0][1].transaction)
        .not.toHaveProperty('subtransactions');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(CreateTransactionTool.name).toBe('ynab_create_transaction');
      expect(CreateTransactionTool.description).toContain('Creates a new transaction in your YNAB plan');
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
      expect(CreateTransactionTool.inputSchema).toHaveProperty('subtransactions');
    });
  });
});