import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListPayeesTool from '../tools/ListPayeesTool';

vi.mock('ynab');

describe('ListPayeesTool', () => {
  let mockApi: {
    payees: {
      getPayees: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      payees: {
        getPayees: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockPayeesData = [
      {
        id: 'payee-1',
        name: 'Amazon',
        transfer_account_id: null,
        deleted: false,
      },
      {
        id: 'payee-2',
        name: 'Walmart',
        transfer_account_id: null,
        deleted: false,
      },
      {
        id: 'payee-3',
        name: 'Transfer: Savings',
        transfer_account_id: 'account-savings',
        deleted: false,
      },
      {
        id: 'payee-deleted',
        name: 'Old Store',
        transfer_account_id: null,
        deleted: true,
      },
    ];

    it('should successfully list all payees', async () => {
      mockApi.payees.getPayees.mockResolvedValue({
        data: { payees: mockPayeesData },
      });

      const result = await ListPayeesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.payees.getPayees).toHaveBeenCalledWith('test-budget-id');

      const response = JSON.parse(result.content[0].text);
      expect(response.payees).toHaveLength(3); // Excludes deleted
      expect(response.payee_count).toBe(3);
    });

    it('should filter out deleted payees', async () => {
      mockApi.payees.getPayees.mockResolvedValue({
        data: { payees: mockPayeesData },
      });

      const result = await ListPayeesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const payeeNames = response.payees.map((p: any) => p.name);
      expect(payeeNames).not.toContain('Old Store');
    });

    it('should include transfer_account_id for transfer payees', async () => {
      mockApi.payees.getPayees.mockResolvedValue({
        data: { payees: mockPayeesData },
      });

      const result = await ListPayeesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const transferPayee = response.payees.find((p: any) => p.name === 'Transfer: Savings');
      expect(transferPayee.transfer_account_id).toBe('account-savings');
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.payees.getPayees.mockResolvedValue({
        data: { payees: mockPayeesData },
      });

      await ListPayeesTool.execute({}, mockApi as any);

      expect(mockApi.payees.getPayees).toHaveBeenCalledWith('test-budget-id');
    });

    it('should handle empty payee list', async () => {
      mockApi.payees.getPayees.mockResolvedValue({
        data: { payees: [] },
      });

      const result = await ListPayeesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.payees).toHaveLength(0);
      expect(response.payee_count).toBe(0);
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListPayeesTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.payees.getPayees.mockRejectedValue(new Error('API Error'));

      const result = await ListPayeesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle payees with special characters in names', async () => {
      const specialPayees = [
        {
          id: 'payee-special',
          name: 'Store "Name" & Symbols!',
          transfer_account_id: null,
          deleted: false,
        },
      ];

      mockApi.payees.getPayees.mockResolvedValue({
        data: { payees: specialPayees },
      });

      const result = await ListPayeesTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.payees[0].name).toBe('Store "Name" & Symbols!');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListPayeesTool.name).toBe('ynab_list_payees');
      expect(ListPayeesTool.description).toContain('Lists all payees');
    });

    it('should have optional budgetId in input schema', () => {
      expect(ListPayeesTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});
