import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import ListTransactionsTool from '../tools/ListTransactionsTool';

vi.mock('ynab');

describe('ListTransactionsTool', () => {
  let tool: ListTransactionsTool;
  let mockApi: {
    transactions: {
      getTransactions: Mock;
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
        getTransactions: vi.fn(),
      },
      accounts: {
        getAccounts: vi.fn(),
      },
      categories: {
        getCategories: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new ListTransactionsTool();
  });

  describe('execute', () => {
    const mockTransactionData = [
      {
        id: 'transaction-1',
        date: '2023-01-01',
        amount: -50000, // -$50.00
        memo: 'Test memo 1',
        approved: false,
        cleared: ynab.TransactionClearedStatus.Uncleared,
        account_id: 'account-1',
        account_name: 'Chase Bank',
        payee_name: 'Test Payee 1',
        category_name: 'Test Category',
        deleted: false,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
        flag_color: null,
        flag_name: null,
      },
      {
        id: 'transaction-2',
        date: '2023-01-02',
        amount: 25000, // $25.00
        memo: 'Test memo 2',
        approved: true,
        cleared: ynab.TransactionClearedStatus.Cleared,
        account_id: 'account-1',
        account_name: 'Chase Bank',
        payee_name: 'Test Payee 2',
        category_name: 'Test Category 2',
        deleted: false,
        transfer_account_id: 'transfer-account-id',
        transfer_transaction_id: 'transfer-transaction-id',
        matched_transaction_id: 'matched-transaction-id',
        import_id: 'import-id',
        flag_color: 'red',
        flag_name: 'Important',
      },
      {
        id: 'transaction-3',
        date: '2023-01-03',
        amount: -10000, // -$10.00
        memo: null,
        approved: true,
        cleared: ynab.TransactionClearedStatus.Reconciled,
        account_id: 'account-2',
        account_name: 'Savings Account',
        payee_name: null,
        category_name: null,
        deleted: false,
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
        flag_color: null,
        flag_name: null,
      },
      {
        id: 'transaction-4',
        date: '2023-01-04',
        amount: -75000, // -$75.00
        memo: 'Deleted transaction',
        approved: false,
        cleared: ynab.TransactionClearedStatus.Uncleared,
        account_id: 'account-1',
        account_name: 'Chase Bank',
        payee_name: 'Test Payee 3',
        category_name: 'Test Category 3',
        deleted: true, // This should be filtered out
        transfer_account_id: null,
        transfer_transaction_id: null,
        matched_transaction_id: null,
        import_id: null,
        flag_color: null,
        flag_name: null,
      },
    ];

    const mockAccountData = [
      {
        id: 'account-1',
        name: 'Chase Bank',
        type: 'checking',
        on_budget: true,
        closed: false,
        note: null,
        balance: 100000,
        cleared_balance: 50000,
        uncleared_balance: 50000,
        transfer_payee_id: 'transfer-payee-1',
        direct_import_linked: false,
        direct_import_in_error: false,
        deleted: false,
      },
      {
        id: 'account-2',
        name: 'Savings Account',
        type: 'savings',
        on_budget: true,
        closed: false,
        note: null,
        balance: 500000,
        cleared_balance: 500000,
        uncleared_balance: 0,
        transfer_payee_id: 'transfer-payee-2',
        direct_import_linked: false,
        direct_import_in_error: false,
        deleted: false,
      },
    ];

    const mockCategoryData = {
      category_groups: [
        {
          id: 'group-1',
          name: 'Test Group',
          hidden: false,
          deleted: false,
          categories: [
            {
              id: 'category-1',
              name: 'Test Category',
              category_group_id: 'group-1',
              hidden: false,
              original_category_group_id: 'group-1',
              note: null,
              budgeted: 0,
              activity: 0,
              balance: 0,
              goal_type: null,
              goal_day: null,
              goal_cadence: null,
              goal_cadence_frequency: null,
              goal_creation_month: null,
              goal_target: null,
              goal_target_month: null,
              goal_percentage_complete: null,
              goal_months_to_budget: null,
              goal_under_funded: null,
              goal_overall_funded: null,
              goal_overall_left: null,
              deleted: false,
            },
          ],
        },
      ],
    };

    beforeEach(() => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionData },
      });
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccountData },
      });
      mockApi.categories.getCategories.mockResolvedValue({
        data: mockCategoryData,
      });
    });

    it('should successfully list all transactions with default parameters', async () => {
      const input = {
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('test-budget-id');
      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');
      expect(mockApi.categories.getCategories).toHaveBeenCalledWith('test-budget-id');

      expect(result).toHaveProperty('content');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const responseData = JSON.parse(result.content[0].text);
      expect(responseData).toHaveProperty('transactions');
      expect(responseData).toHaveProperty('pagination');
      expect(responseData.transactions).toHaveLength(3); // 3 non-deleted transactions
      expect(responseData.pagination.total).toBe(3);
    });

    it('should filter transactions by account ID', async () => {
      const input = {
        accountId: 'account-1',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(2); // Only Chase Bank transactions
      expect(responseData.transactions.every((t: any) => t.account_name === 'Chase Bank')).toBe(true);
    });

    it('should filter transactions by account name', async () => {
      const input = {
        accountName: 'Chase',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(2); // Only Chase Bank transactions
      expect(responseData.transactions.every((t: any) => t.account_name === 'Chase Bank')).toBe(true);
    });

    it('should filter transactions by approval status', async () => {
      const input = {
        filters: {
          approved: false,
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1); // Only unapproved transaction
      expect(responseData.transactions[0].approved).toBe(false);
    });

    it('should filter transactions by cleared status', async () => {
      const input = {
        filters: {
          cleared: 'cleared' as const,
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1); // Only cleared transaction
      expect(responseData.transactions[0].cleared).toBe('cleared');
    });


    it('should filter transactions by payee name', async () => {
      const input = {
        filters: {
          payee: 'Test Payee 1',
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1);
      expect(responseData.transactions[0].payee_name).toBe('Test Payee 1');
    });

    it('should filter transactions by category name', async () => {
      const input = {
        filters: {
          category: 'Test Category 2',
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1);
      expect(responseData.transactions[0].category_name).toBe('Test Category 2');
    });

    it('should filter transactions by amount range', async () => {
      const input = {
        filters: {
          minAmount: 20,
          maxAmount: 30,
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1);
      expect(responseData.transactions[0].amount).toBe(25); // $25.00
    });

    it('should filter transactions by date range', async () => {
      const input = {
        filters: {
          startDate: '2023-01-02',
          endDate: '2023-01-03',
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(2);
      expect(responseData.transactions.every((t: any) => 
        t.date >= '2023-01-02' && t.date <= '2023-01-03'
      )).toBe(true);
    });

    it('should filter transactions by memo', async () => {
      const input = {
        filters: {
          memo: 'Test memo 1',
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1);
      expect(responseData.transactions[0].memo).toBe('Test memo 1');
    });

    it('should apply pagination correctly', async () => {
      const input = {
        limit: 2,
        offset: 1,
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(2);
      expect(responseData.pagination.total).toBe(3);
      expect(responseData.pagination.offset).toBe(1);
      expect(responseData.pagination.limit).toBe(2);
      expect(responseData.pagination.has_more).toBe(false);
    });

    it('should return error when account not found', async () => {
      const input = {
        accountName: 'Non-existent Account',
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Account not found');
    });

    it('should handle API errors gracefully', async () => {
      mockApi.transactions.getTransactions.mockRejectedValue(new Error('API Error'));

      const input = {
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error listing transactions');
    });

    it('should use custom budget ID when provided', async () => {
      const input = {
        budgetId: 'custom-budget-id',
        response_format: 'json' as const,
      };

      await tool.execute(input);

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('custom-budget-id');
      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('custom-budget-id');
      expect(mockApi.categories.getCategories).toHaveBeenCalledWith('custom-budget-id');
    });

    it('should return markdown format by default', async () => {
      const input = {};

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      expect(result.content[0].text).toContain('# YNAB Transactions');
      expect(result.content[0].text).toContain('## Transactions');
    });

    it('should transform transactions correctly', async () => {
      const input = {
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      
      const transaction = responseData.transactions[0];
      expect(transaction).toHaveProperty('id', 'transaction-1');
      expect(transaction).toHaveProperty('date', '2023-01-01');
      expect(transaction).toHaveProperty('amount', -50); // Converted from milliunits
      expect(transaction).toHaveProperty('memo', 'Test memo 1');
      expect(transaction).toHaveProperty('approved', false);
      expect(transaction).toHaveProperty('cleared', 'uncleared');
      expect(transaction).toHaveProperty('account_name', 'Chase Bank');
      expect(transaction).toHaveProperty('payee_name', 'Test Payee 1');
      expect(transaction).toHaveProperty('category_name', 'Test Category');
    });

    it('should handle transactions with null values correctly', async () => {
      const input = {
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      
      // Find the transaction with null values (transaction-3)
      const transaction = responseData.transactions.find((t: any) => t.id === 'transaction-3');
      expect(transaction.memo).toBeUndefined();
      expect(transaction.payee_name).toBeUndefined();
      expect(transaction.category_name).toBeUndefined();
    });

    it('should handle multiple filters correctly', async () => {
      const input = {
        filters: {
          approved: true,
          cleared: 'reconciled',
          minAmount: -15, // Allow negative amounts
        },
        response_format: 'json' as const,
      };

      const result = await tool.execute(input);

      expect(result).toHaveProperty('content');
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.transactions).toHaveLength(1);
      expect(responseData.transactions[0].approved).toBe(true);
      expect(responseData.transactions[0].cleared).toBe('reconciled');
      expect(responseData.transactions[0].amount).toBe(-10); // -$10.00
    });
  });

  describe('getToolDefinition', () => {
    it('should return correct tool definition', () => {
      const definition = tool.getToolDefinition();

      expect(definition).toHaveProperty('name', 'ynab_list_transactions');
      expect(definition).toHaveProperty('description');
      expect(definition).toHaveProperty('inputSchema');
      expect(definition).toHaveProperty('annotations');
      
      expect(definition.inputSchema.properties).toHaveProperty('budgetId');
      expect(definition.inputSchema.properties).toHaveProperty('accountId');
      expect(definition.inputSchema.properties).toHaveProperty('accountName');
      expect(definition.inputSchema.properties).toHaveProperty('filters');
      expect(definition.inputSchema.properties).toHaveProperty('response_format');
      expect(definition.inputSchema.properties).toHaveProperty('limit');
      expect(definition.inputSchema.properties).toHaveProperty('offset');
      
      expect(definition.annotations).toHaveProperty('readOnlyHint', true);
      expect(definition.annotations).toHaveProperty('destructiveHint', false);
      expect(definition.annotations).toHaveProperty('idempotentHint', true);
    });
  });
});
