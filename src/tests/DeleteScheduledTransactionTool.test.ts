import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as DeleteScheduledTransactionTool from '../tools/DeleteScheduledTransactionTool';

vi.mock('ynab');

describe('DeleteScheduledTransactionTool', () => {
  let mockApi: {
    scheduledTransactions: {
      deleteScheduledTransaction: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      scheduledTransactions: {
        deleteScheduledTransaction: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    it('should delete the scheduled transaction', async () => {
      mockApi.scheduledTransactions.deleteScheduledTransaction.mockResolvedValue({
        data: { scheduled_transaction: { id: 'st-1', deleted: true } },
      });

      const result = await DeleteScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1' },
        mockApi as any
      );

      expect(mockApi.scheduledTransactions.deleteScheduledTransaction).toHaveBeenCalledWith('test-budget-id', 'st-1');
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        scheduledTransactionId: 'st-1',
        message: 'Scheduled transaction deleted successfully',
      });
    });

    it('should report a missing response row', async () => {
      mockApi.scheduledTransactions.deleteScheduledTransaction.mockResolvedValue({ data: {} });

      const result = await DeleteScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Failed to delete scheduled transaction');
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await DeleteScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should handle API error', async () => {
      mockApi.scheduledTransactions.deleteScheduledTransaction.mockRejectedValue(new Error('API Error'));

      const result = await DeleteScheduledTransactionTool.execute(
        { scheduledTransactionId: 'st-1' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and schema fields', () => {
      expect(DeleteScheduledTransactionTool.name).toBe('ynab_delete_scheduled_transaction');
      expect(DeleteScheduledTransactionTool.inputSchema).toHaveProperty('planId');
      expect(DeleteScheduledTransactionTool.inputSchema).toHaveProperty('budgetId');
      expect(DeleteScheduledTransactionTool.inputSchema).toHaveProperty('scheduledTransactionId');
    });
  });
});
