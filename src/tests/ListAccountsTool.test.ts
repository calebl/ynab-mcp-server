import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListAccountsTool from '../tools/ListAccountsTool';

vi.mock('ynab');

describe('ListAccountsTool', () => {
  let mockApi: {
    accounts: {
      getAccounts: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      accounts: {
        getAccounts: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockAccountsData = {
      data: {
        accounts: [
          {
            id: 'account-1',
            name: 'Checking',
            type: 'checking',
            on_budget: true,
            closed: false,
            deleted: false,
            balance: 5000000,
            cleared_balance: 4500000,
            uncleared_balance: 500000,
            transfer_payee_id: 'payee-transfer-1',
          },
          {
            id: 'account-2',
            name: 'Savings',
            type: 'savings',
            on_budget: true,
            closed: false,
            deleted: false,
            balance: 10000000,
            cleared_balance: 10000000,
            uncleared_balance: 0,
            transfer_payee_id: 'payee-transfer-2',
          },
          {
            id: 'account-closed',
            name: 'Old Account',
            type: 'checking',
            on_budget: true,
            closed: true,
            deleted: false,
            balance: 0,
            cleared_balance: 0,
            uncleared_balance: 0,
            transfer_payee_id: 'payee-transfer-3',
          },
          {
            id: 'account-deleted',
            name: 'Deleted Account',
            type: 'checking',
            on_budget: true,
            closed: false,
            deleted: true,
            balance: 0,
            cleared_balance: 0,
            uncleared_balance: 0,
            transfer_payee_id: 'payee-transfer-4',
          },
        ],
      },
    };

    it('should successfully list all open accounts', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccountsData);

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');

      const response = JSON.parse(result.content[0].text);
      expect(response.account_count).toBe(2); // Excludes closed and deleted
    });

    it('should include closed accounts when requested', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccountsData);

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id', includeClosedAccounts: true },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.account_count).toBe(3); // Includes closed, excludes deleted
      const accountNames = response.accounts.map((a: any) => a.name);
      expect(accountNames).toContain('Old Account');
    });

    it('should filter out deleted accounts', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccountsData);

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id', includeClosedAccounts: true },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const accountNames = response.accounts.map((a: any) => a.name);
      expect(accountNames).not.toContain('Deleted Account');
    });

    it('should format amounts correctly', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccountsData);

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const checking = response.accounts.find((a: any) => a.name === 'Checking');
      expect(checking.balance).toBe('5000.00');
      expect(checking.cleared_balance).toBe('4500.00');
      expect(checking.uncleared_balance).toBe('500.00');
    });

    it('should include account metadata', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccountsData);

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const checking = response.accounts.find((a: any) => a.name === 'Checking');
      expect(checking.type).toBe('checking');
      expect(checking.on_budget).toBe(true);
      expect(checking.transfer_payee_id).toBe('payee-transfer-1');
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue(mockAccountsData);

      await ListAccountsTool.execute({}, mockApi as any);

      expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListAccountsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.accounts.getAccounts.mockRejectedValue(new Error('API Error'));

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle empty accounts list', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [] },
      });

      const result = await ListAccountsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.account_count).toBe(0);
      expect(response.accounts).toHaveLength(0);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListAccountsTool.name).toBe('ynab_list_accounts');
      expect(ListAccountsTool.description).toContain('Lists all accounts');
    });

    it('should have input schema fields', () => {
      expect(ListAccountsTool.inputSchema).toHaveProperty('budgetId');
      expect(ListAccountsTool.inputSchema).toHaveProperty('includeClosedAccounts');
    });
  });
});
