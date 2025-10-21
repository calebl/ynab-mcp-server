import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import ApproveTransactionTool from '../tools/ApproveTransactionTool';

// Mock the entire ynab module
vi.mock('ynab');

describe('ApproveTransactionTool', () => {
  let tool: ApproveTransactionTool;
  let mockApi: {
    transactions: {
      getTransactionById: Mock;
      updateTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create mock API instance
    mockApi = {
      transactions: {
        getTransactionById: vi.fn(),
        updateTransaction: vi.fn(),
      },
    };

    // Mock the ynab.API constructor
    (ynab.API as any).mockImplementation(() => mockApi);

    // Set environment variables
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new ApproveTransactionTool();
  });

  describe('execute', () => {
    const mockExistingTransaction = {
      id: 'transaction-123',
      account_id: 'account-456',
      date: '2023-12-01',
      amount: -50000,
      payee_id: 'payee-789',
      payee_name: 'Test Payee',
      category_id: undefined,
      memo: undefined,
      cleared: undefined,
      approved: false,
      flag_color: undefined,
      subtransactions: undefined,
    };

    const mockUpdatedTransaction = {
      id: 'transaction-123',
      account_id: 'account-456',
      payee_name: 'Test Payee',
      amount: -50000,
      approved: true,
    };

    it('should successfully approve a transaction with budget ID from input', async () => {
      // Setup mocks
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      const input = {
        budgetId: 'custom-budget-id',
        transactionId: 'transaction-123',
        approved: true,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.getTransactionById).toHaveBeenCalledWith(
        'custom-budget-id',
        'transaction-123'
      );
      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'custom-budget-id',
        'transaction-123',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: -50000,
            payee_id: 'payee-789',
            payee_name: 'Test Payee',
            category_id: undefined,
            memo: undefined,
            cleared: undefined,
            approved: true,
            flag_color: undefined,
            subtransactions: undefined,
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
              message: 'Transaction updated successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should successfully approve a transaction with budget ID from environment', async () => {
      // Setup mocks
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      const input = {
        transactionId: 'transaction-123',
        approved: true,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.getTransactionById).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123'
      );
      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: -50000,
            payee_id: 'payee-789',
            payee_name: 'Test Payee',
            category_id: undefined,
            memo: undefined,
            cleared: undefined,
            approved: true,
            flag_color: undefined,
            subtransactions: undefined,
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
              message: 'Transaction updated successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should successfully disapprove a transaction', async () => {
      const mockDisapprovedTransaction = {
        ...mockExistingTransaction,
        approved: false,
      };

      // Setup mocks
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockDisapprovedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        transactionId: 'transaction-123',
        approved: false,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: -50000,
            payee_id: 'payee-789',
            payee_name: 'Test Payee',
            category_id: undefined,
            memo: undefined,
            cleared: undefined,
            approved: false,
            flag_color: undefined,
            subtransactions: undefined,
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
              message: 'Transaction updated successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should throw error when no budget ID is provided', async () => {
      // Clear environment budget ID
      delete process.env.YNAB_BUDGET_ID;
      tool = new ApproveTransactionTool();

      const input = {
        transactionId: 'transaction-123',
        approved: true,
      };

      const result = await tool.execute(input);
      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error updating transaction:');
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle transaction not found error', async () => {
      // Setup mock to return no transaction
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: null },
      });

      const input = {
        budgetId: 'test-budget-id',
        transactionId: 'nonexistent-transaction',
        approved: true,
      };

      const result = await tool.execute(input);

      expect(result.content[0].text).toMatch(/Error updating transaction: Transaction not found/);
    });

    it('should handle API error when getting existing transaction', async () => {
      // Setup mock to throw API error
      const apiError = new Error('API Error: Budget not found');
      mockApi.transactions.getTransactionById.mockRejectedValue(apiError);

      const input = {
        budgetId: 'invalid-budget-id',
        transactionId: 'transaction-123',
        approved: true,
      };

      const result = await tool.execute(input);

      expect(result.content[0].text).toMatch(/Error updating transaction: API Error: Budget not found/);
    });

    it('should handle API error when updating transaction', async () => {
      // Setup mocks
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      
      const apiError = new Error('API Error: Transaction update failed');
      mockApi.transactions.updateTransaction.mockRejectedValue(apiError);

      const input = {
        budgetId: 'test-budget-id',
        transactionId: 'transaction-123',
        approved: true,
      };

      const result = await tool.execute(input);

      expect(result.content[0].text).toMatch(/Error updating transaction: API Error: Transaction update failed/);
    });

    it('should handle case when update returns no transaction data', async () => {
      // Setup mocks
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const input = {
        budgetId: 'test-budget-id',
        transactionId: 'transaction-123',
        approved: true,
      };

      const result = await tool.execute(input);

      expect(result.content[0].text).toMatch(/Error updating transaction: Failed to update transaction - no transaction data returned/);
    });

    it('should use default approved value of true when not specified', async () => {
      // Setup mocks
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        transactionId: 'transaction-123',
        response_format: 'json' as const,
        // approved not specified, should default to true
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            account_id: 'account-456',
            date: '2023-12-01',
            amount: -50000,
            payee_id: 'payee-789',
            payee_name: 'Test Payee',
            category_id: undefined,
            memo: undefined,
            cleared: undefined,
            approved: true, // Default value when not specified
            flag_color: undefined,
            subtransactions: undefined,
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
              message: 'Transaction updated successfully',
            }, null, 2),
          },
        ],
      });
    });

    it('should handle non-Error objects in catch block', async () => {
      // Setup mock to throw non-Error object
      const nonErrorObject = { message: 'Custom error object', code: 500 };
      mockApi.transactions.getTransactionById.mockRejectedValue(nonErrorObject);

      const input = {
        budgetId: 'test-budget-id',
        transactionId: 'transaction-123',
        approved: true,
      };

      const result = await tool.execute(input);

      expect(result.content[0].text).toMatch(/Error updating transaction: {"message":"Custom error object","code":500}/);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_approve_transaction');
      expect(toolDef.description).toBe('Approves an existing transaction in your YNAB budget.');
    });

    it('should have correct schema definition', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema).toHaveProperty('properties');
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('transactionId');
      expect(toolDef.inputSchema.properties).toHaveProperty('approved');
      
      expect(toolDef.inputSchema.properties.budgetId.description).toContain('budget containing the transaction');
      expect(toolDef.inputSchema.properties.transactionId.description).toContain('id of the transaction to approve');
      expect(toolDef.inputSchema.properties.approved.description).toContain('Whether the transaction should be marked as approved');
    });
  });
});