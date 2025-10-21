import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import GetUnapprovedTransactionsTool from '../tools/GetUnapprovedTransactionsTool';

vi.mock('ynab');

describe('GetUnapprovedTransactionsTool', () => {
  let tool: GetUnapprovedTransactionsTool;
  let mockApi: {
    transactions: {
      getTransactions: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockApi = {
      transactions: {
        getTransactions: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new GetUnapprovedTransactionsTool();
  });

  describe('execute', () => {
    const mockTransactionData = [
      {
        id: 'transaction-1',
        date: '2023-01-01',
        amount: -50000,
        memo: 'Test memo 1',
        approved: false,
        account_name: 'Test Account',
        payee_name: 'Test Payee 1',
        category_name: 'Test Category',
        deleted: false,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      },
      {
        id: 'transaction-2',
        date: '2023-01-02',
        amount: -25000,
        memo: 'Test memo 2',
        approved: false,
        account_name: 'Test Account 2',
        payee_name: 'Test Payee 2',
        category_name: 'Test Category 2',
        deleted: false,
        transfer_account_id: 'transfer-account-id',
        transfer_transaction_id: 'transfer-transaction-id',
        matched_transaction_id: 'matched-transaction-id',
        import_id: 'import-id',
      },
      {
        id: 'transaction-3',
        date: '2023-01-03',
        amount: -10000,
        memo: null,
        approved: false,
        account_name: 'Test Account 3',
        payee_name: null,
        category_name: null,
        deleted: true,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      },
    ];

    it('should successfully get unapproved transactions with budget ID from input', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionData },
      });

      const input = {
        budgetId: 'custom-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'custom-budget-id',
        undefined,
        ynab.GetTransactionsTypeEnum.Unapproved
      );

      expect(result).toHaveProperty('content');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('transactions');
      expect(parsedResult.transactions).toHaveLength(2);
      expect(parsedResult.transactions[0]).toEqual({
        id: 'transaction-1',
        date: '2023-01-01',
        amount: -50,
        memo: 'Test memo 1',
        approved: false,
        account_name: 'Test Account',
        payee_name: 'Test Payee 1',
        category_name: 'Test Category',
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      });
      expect(parsedResult.transactions[1]).toEqual({
        id: 'transaction-2',
        date: '2023-01-02',
        amount: -25,
        memo: 'Test memo 2',
        approved: false,
        account_name: 'Test Account 2',
        payee_name: 'Test Payee 2',
        category_name: 'Test Category 2',
        transfer_account_id: 'transfer-account-id',
        transfer_transaction_id: 'transfer-transaction-id',
        matched_transaction_id: 'matched-transaction-id',
        import_id: 'import-id',
      });
      expect(parsedResult).toHaveProperty('transaction_count', 2);
    });

    it('should successfully get unapproved transactions with budget ID from environment', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionData },
      });

      const input = {
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        ynab.GetTransactionsTypeEnum.Unapproved
      );

      expect(result).toHaveProperty('content');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('transactions');
      expect(parsedResult).toHaveProperty('transaction_count');
      expect(parsedResult.transaction_count).toBe(2);
    });

    it('should filter out deleted transactions', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionData },
      });

      const input = {
        budgetId: 'test-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transactions).toHaveLength(2);
      expect(parsedResult.transactions.find(t => t.id === 'transaction-3')).toBeUndefined();
    });

    it('should convert amounts from milliunits to currency format', async () => {
      const singleTransaction = [
        {
          id: 'transaction-1',
          date: '2023-01-01',
          amount: -123456,
          memo: 'Test',
          approved: false,
          account_name: 'Test Account',
          payee_name: 'Test Payee',
          category_name: 'Test Category',
          deleted: false,
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: singleTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transactions[0].amount).toBe(-123.456);
    });

    it('should handle positive amounts correctly', async () => {
      const singleTransaction = [
        {
          id: 'transaction-1',
          date: '2023-01-01',
          amount: 50000,
          memo: 'Income',
          approved: false,
          account_name: 'Test Account',
          payee_name: 'Employer',
          category_name: 'Income Category',
          deleted: false,
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: singleTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transactions[0].amount).toBe(50);
    });

    it('should handle empty transaction list', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: [] },
      });

      const input = {
        budgetId: 'test-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toEqual({
        transactions: [],
        transaction_count: 0,
        pagination: {
          total: 0,
          count: 0,
          offset: 0,
          limit: 50,
          has_more: false,
          next_offset: null,
        },
      });
    });

    it('should return error message when no budget ID is provided', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new GetUnapprovedTransactionsTool();

      const input = {};

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error getting unapproved transactions:');
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API error', async () => {
      const apiError = new Error('API Error: Budget not found');
      mockApi.transactions.getTransactions.mockRejectedValue(apiError);

      const input = {
        budgetId: 'invalid-budget-id',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toBe('Error getting unapproved transactions: API Error: Budget not found');
    });

    it('should handle non-Error objects in catch block', async () => {
      const nonErrorObject = { message: 'Custom error object', code: 500 };
      mockApi.transactions.getTransactions.mockRejectedValue(nonErrorObject);

      const input = {
        budgetId: 'test-budget-id',
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toBe('Error getting unapproved transactions: {"message":"Custom error object","code":500}');
    });

    it('should handle null/undefined values in transaction fields gracefully', async () => {
      const transactionWithNulls = [
        {
          id: 'transaction-1',
          date: '2023-01-01',
          amount: -25000,
          memo: null,
          approved: false,
          account_name: 'Test Account',
          payee_name: null,
          category_name: null,
          deleted: false,
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: transactionWithNulls },
      });

      const input = {
        budgetId: 'test-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transactions[0]).toEqual({
        id: 'transaction-1',
        date: '2023-01-01',
        amount: -25,
        memo: null,
        approved: false,
        account_name: 'Test Account',
        payee_name: null,
        category_name: null,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
      });
    });

    it('should handle zero amount transactions', async () => {
      const zeroAmountTransaction = [
        {
          id: 'transaction-1',
          date: '2023-01-01',
          amount: 0,
          memo: 'Zero amount',
          approved: false,
          account_name: 'Test Account',
          payee_name: 'Test Payee',
          category_name: 'Test Category',
          deleted: false,
          transfer_account_id: null,
          transfer_transaction_id: null,
          matched_transaction_id: null,
          import_id: null,
        },
      ];

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: zeroAmountTransaction },
      });

      const input = {
        budgetId: 'test-budget-id',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.transactions[0].amount).toBe(0);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_get_unapproved_transactions');
      expect(toolDef.description).toBe(
        'Gets unapproved transactions from a budget. First time pulls last 3 days, subsequent pulls use server knowledge to get only changes.'
      );
    });

    it('should have correct schema definition', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema).toHaveProperty('properties');
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties.budgetId.description).toBe(
        'The ID of the budget to fetch transactions for (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)'
      );
    });
  });
});