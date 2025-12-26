import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ApproveTransactionTool from '../tools/ApproveTransactionTool';

vi.mock('ynab');

describe('ApproveTransactionTool', () => {
  let mockApi: {
    transactions: {
      getTransactionById: Mock;
      updateTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        getTransactionById: vi.fn(),
        updateTransaction: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockExistingTransaction = {
      id: 'transaction-123',
      account_id: 'account-123',
      date: '2023-01-01',
      amount: -50000, // -$50.00 in milliunits
      payee_name: 'Test Payee',
      category_id: 'category-123',
      memo: 'Test transaction',
      approved: false,
      cleared: ynab.TransactionClearedStatus.Uncleared,
    };

    const mockUpdatedTransaction = {
      ...mockExistingTransaction,
      approved: true,
    };

    it('should successfully approve transaction with default settings', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionById).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123'
      );
      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            approved: true,
          },
        }
      );

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            transactionId: 'transaction-123',
            message: "Transaction updated successfully",
          }, null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should successfully approve transaction with custom budget ID', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      const result = await ApproveTransactionTool.execute(
        { budgetId: 'custom-budget-id', transactionId: 'transaction-123' },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionById).toHaveBeenCalledWith(
        'custom-budget-id',
        'transaction-123'
      );
      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'custom-budget-id',
        'transaction-123',
        expect.any(Object)
      );
    });

    it('should successfully unapprove transaction when approved=false', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });

      const mockUnapprovedTransaction = {
        ...mockExistingTransaction,
        approved: false,
      };

      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUnapprovedTransaction },
      });

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123', approved: false },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            approved: false,
          },
        }
      );
    });

    it('should handle transaction not found error', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: null },
      });

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'nonexistent-transaction' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Transaction not found');
      expect(mockApi.transactions.updateTransaction).not.toHaveBeenCalled();
    });

    it('should handle API error when getting transaction', async () => {
      const apiError = new Error('Get Transaction API Error: Unauthorized');
      mockApi.transactions.getTransactionById.mockRejectedValue(apiError);

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Get Transaction API Error: Unauthorized');
      expect(mockApi.transactions.updateTransaction).not.toHaveBeenCalled();
    });

    it('should handle API error when updating transaction', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });

      const apiError = new Error('Update Transaction API Error: Forbidden');
      mockApi.transactions.updateTransaction.mockRejectedValue(apiError);

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Update Transaction API Error: Forbidden');
    });

    it('should handle missing transaction data in update response', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: null },
      });

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to update transaction - no transaction data returned');
    });

    it('should throw error when no budget ID is provided', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
      expect(mockApi.transactions.getTransactionById).not.toHaveBeenCalled();
      expect(mockApi.transactions.updateTransaction).not.toHaveBeenCalled();
    });

    it('should handle approved parameter correctly with default value', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      // Test without approved parameter (should default to true)
      await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            approved: true, // Should default to true
          },
        }
      );
    });

    it('should handle approved parameter with explicit true value', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123', approved: true },
        mockApi as any
      );

      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            approved: true,
          },
        }
      );
    });

    it('should preserve existing transaction data when updating', async () => {
      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockResolvedValue({
        data: { transaction: mockUpdatedTransaction },
      });

      await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      // Verify that we only update the approved field, not other transaction data
      expect(mockApi.transactions.updateTransaction).toHaveBeenCalledWith(
        'test-budget-id',
        'transaction-123',
        {
          transaction: {
            approved: true, // Only this field should be in the update
          },
        }
      );
    });

    it('should handle complex error objects', async () => {
      const complexError = {
        message: 'Transaction locked',
        code: 'TRANSACTION_LOCKED',
        detail: 'Transaction is part of a reconciled period',
      };

      mockApi.transactions.getTransactionById.mockResolvedValue({
        data: { transaction: mockExistingTransaction },
      });
      mockApi.transactions.updateTransaction.mockRejectedValue(complexError);

      const result = await ApproveTransactionTool.execute(
        { transactionId: 'transaction-123' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      // The getErrorMessage utility will extract "Transaction locked" from the message property
      expect(response.error).toContain('Transaction locked');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ApproveTransactionTool.name).toBe('ynab_approve_transaction');
      expect(ApproveTransactionTool.description).toContain('Approves an existing transaction in your YNAB budget');
    });

    it('should have correct input schema', () => {
      expect(ApproveTransactionTool.inputSchema).toHaveProperty('budgetId');
      expect(ApproveTransactionTool.inputSchema).toHaveProperty('transactionId');
      expect(ApproveTransactionTool.inputSchema).toHaveProperty('approved');
    });
  });
});