import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import CreateTransactionTool from '../tools/CreateTransactionTool';

// Mock the entire ynab module
vi.mock('ynab');

describe('CreateTransactionTool', () => {
  let tool: CreateTransactionTool;
  let mockApi: {
    transactions: {
      createTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create mock API instance
    mockApi = {
      transactions: {
        createTransaction: vi.fn(),
      },
    };

    // Mock the ynab.API constructor
    (ynab.API as any).mockImplementation(() => mockApi);

    // Set environment variables
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new CreateTransactionTool();
  });

  describe('execute', () => {
    const mockCreatedTransaction = {
      id: 'transaction-123',
      account_id: 'account-456',
      payee_name: 'Test Payee',
      amount: -50000, // -$50.00 in milliunits
      category_id: 'category-789',
      memo: 'Test memo',
      date: '2023-12-01',
      cleared: ynab.TransactionClearedStatus.Uncleared,
      approved: false,
      flag_color: null,
    };

    it('should successfully create a transaction with payee_name', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'custom-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: -50.00,
        payeeName: 'Test Payee',
        categoryId: 'category-789',
        memo: 'Test memo',
        cleared: false,
        approved: false,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'custom-budget-id',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: -50000, // Converted to milliunits
            payee_id: undefined,
            payee_name: 'Test Payee',
            category_id: 'category-789',
            memo: 'Test memo',
            cleared: ynab.TransactionClearedStatus.Uncleared,
            approved: false,
            flag_color: undefined,
          },
        }
      );
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              transactionId: 'transaction-123',
              message: 'Transaction created successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should successfully create a transaction with payee_id', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 25.99,
        payeeId: 'payee-123',
        categoryId: 'category-789',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: 25990, // Converted to milliunits (25.99 * 1000)
            payee_id: 'payee-123',
            payee_name: undefined,
            category_id: 'category-789',
            memo: undefined,
            cleared: ynab.TransactionClearedStatus.Uncleared,
            approved: false,
            flag_color: undefined,
          },
        }
      );
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              transactionId: 'transaction-123',
              message: 'Transaction created successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should use budget ID from environment when not provided in input', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 10.50,
        payeeName: 'Test Payee',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id', // Should use environment variable
        expect.any(Object)
      );
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              transactionId: 'transaction-123',
              message: 'Transaction created successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should create a transaction with all optional parameters', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 75.25,
        payeeId: 'payee-123',
        categoryId: 'category-789',
        memo: 'Test transaction with all fields',
        cleared: true,
        approved: true,
        flagColor: 'red',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: 75250, // 75.25 * 1000
            payee_id: 'payee-123',
            payee_name: undefined,
            category_id: 'category-789',
            memo: 'Test transaction with all fields',
            cleared: ynab.TransactionClearedStatus.Cleared,
            approved: true,
            flag_color: 'red',
          },
        }
      );
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              transactionId: 'transaction-123',
              message: 'Transaction created successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should handle decimal amounts correctly (rounding)', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 12.996, // Should round to 12996 milliunits
        payeeName: 'Test Payee',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: expect.objectContaining({
            amount: 12996, // Math.round(12.996 * 1000) = 12996
          }),
        }
      );
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.success).toBe(true);
    });

    it('should throw error when no budget ID is provided', async () => {
      // Clear environment budget ID
      delete process.env.YNAB_BUDGET_ID;
      tool = new CreateTransactionTool();

      const input = {
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
      };

      const result = await tool.execute(input);
      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error creating transaction:');
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should throw error when neither payee_id nor payee_name is provided', async () => {
      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        // Neither payeeId nor payeeName provided
      };

      const result = await tool.execute(input);
      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Either payee_id or payee_name must be provided');
    });

    it('should return success false when API call fails', async () => {
      // Setup mock to throw API error
      const apiError = new Error('API Error: Budget not found');
      mockApi.transactions.createTransaction.mockRejectedValue(apiError);

      const input = {
        budgetId: 'invalid-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error creating transaction:');
      expect(result.content[0].text).toContain('API Error: Budget not found');
    });

    it('should return success false when API returns no transaction data', async () => {
      // Setup mock to return no transaction
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error creating transaction:');
      expect(result.content[0].text).toContain('Failed to create transaction');
    });

    it('should handle non-Error objects in catch block', async () => {
      // Setup mock to throw non-Error object
      const nonErrorObject = { message: 'Custom error object', code: 500 };
      mockApi.transactions.createTransaction.mockRejectedValue(nonErrorObject);

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error creating transaction:');
    });

    it('should handle cleared status correctly when false', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
        cleared: false,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Uncleared,
          }),
        }
      );
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.success).toBe(true);
    });

    it('should handle cleared status correctly when true', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
        cleared: true,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: expect.objectContaining({
            cleared: ynab.TransactionClearedStatus.Cleared,
          }),
        }
      );
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.success).toBe(true);
    });

    it('should handle approved status with nullish coalescing', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
        response_format: 'json' as const,
        // approved not provided, should default to false
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: expect.objectContaining({
            approved: false, // Should be false when not provided
          }),
        }
      );
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.success).toBe(true);
    });

    it('should handle flag color as enum value', async () => {
      // Setup mock
      mockApi.transactions.createTransaction.mockResolvedValue({
        data: { transaction: mockCreatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        accountId: 'account-456',
        date: '2023-12-01',
        amount: 50.00,
        payeeName: 'Test Payee',
        flagColor: 'blue',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        {
          transaction: expect.objectContaining({
            flag_color: 'blue',
          }),
        }
      );
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.success).toBe(true);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_create_transaction');
      expect(toolDef.description).toBe('Creates a new transaction in your YNAB budget. Either payee_id or payee_name must be provided in addition to the other required fields.');
    });

    it('should have correct schema definition', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema).toHaveProperty('properties');
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('accountId');
      expect(toolDef.inputSchema.properties).toHaveProperty('date');
      expect(toolDef.inputSchema.properties).toHaveProperty('amount');
      expect(toolDef.inputSchema.properties).toHaveProperty('payeeId');
      expect(toolDef.inputSchema.properties).toHaveProperty('payeeName');
      expect(toolDef.inputSchema.properties).toHaveProperty('categoryId');
      expect(toolDef.inputSchema.properties).toHaveProperty('memo');
      expect(toolDef.inputSchema.properties).toHaveProperty('cleared');
      expect(toolDef.inputSchema.properties).toHaveProperty('approved');
      expect(toolDef.inputSchema.properties).toHaveProperty('flagColor');
      
      // Check descriptions contain expected content
      expect(toolDef.inputSchema.properties.budgetId.description).toContain('budget to create the transaction in');
      expect(toolDef.inputSchema.properties.accountId.description).toContain('account to create the transaction in');
      expect(toolDef.inputSchema.properties.date.description).toContain('date of the transaction in ISO format');
      expect(toolDef.inputSchema.properties.amount.description).toContain('amount in dollars');
      expect(toolDef.inputSchema.properties.payeeId.description).toContain('payee_name is provided');
      expect(toolDef.inputSchema.properties.payeeName.description).toContain('payee_id is provided');
      expect(toolDef.inputSchema.properties.categoryId.description).toContain('category id');
      expect(toolDef.inputSchema.properties.memo.description).toContain('memo/note');
      expect(toolDef.inputSchema.properties.cleared.description).toContain('Whether the transaction is cleared');
      expect(toolDef.inputSchema.properties.approved.description).toContain('Whether the transaction is approved');
      expect(toolDef.inputSchema.properties.flagColor.description).toContain('transaction flag color');
    });

    it('should have correct required vs optional fields', () => {
      const toolDef = tool.getToolDefinition();
      // Check required fields are listed in required array
      expect(toolDef.inputSchema.required).toContain('accountId');
      expect(toolDef.inputSchema.required).toContain('date');
      expect(toolDef.inputSchema.required).toContain('amount');
      
      // Check optional fields are not in required array
      expect(toolDef.inputSchema.required).not.toContain('budgetId');
      expect(toolDef.inputSchema.required).not.toContain('payeeId');
      expect(toolDef.inputSchema.required).not.toContain('payeeName');
      expect(toolDef.inputSchema.required).not.toContain('categoryId');
      expect(toolDef.inputSchema.required).not.toContain('memo');
      expect(toolDef.inputSchema.required).not.toContain('cleared');
      expect(toolDef.inputSchema.required).not.toContain('approved');
      expect(toolDef.inputSchema.required).not.toContain('flagColor');
    });
  });
});