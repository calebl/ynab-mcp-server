import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import { z } from 'zod';
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

      expect(mockApi.payees.getPayees).toHaveBeenCalledWith('test-budget-id', undefined);

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

      expect(mockApi.payees.getPayees).toHaveBeenCalledWith('test-budget-id', undefined);
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

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListPayeesTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
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

  describe('delta sync', () => {
    const rows = [
      { id: 'p1', name: 'Shop', transfer_account_id: null, deleted: false },
      { id: 'p2', name: 'Old', transfer_account_id: null, deleted: true },
    ];
    const run = (input: Record<string, unknown>) => {
      mockApi.payees.getPayees.mockResolvedValue({ data: { payees: rows, server_knowledge: 42 } });
      return ListPayeesTool.execute({ budgetId: 'test-budget-id', ...input }, mockApi as any);
    };

    it.each([[5], [0]])('passes lastKnowledgeOfServer %s to the SDK and keeps deleted rows', async (value) => {
      const response = JSON.parse((await run({ lastKnowledgeOfServer: value })).content[0].text);
      expect(mockApi.payees.getPayees).toHaveBeenCalledWith('test-budget-id', value);
      expect(response.server_knowledge).toBe(42);
      expect(response.payees.map((r: any) => r.deleted)).toEqual([false, true]);
      expect(response.payee_count).toBe(2);
    });

    it('passes undefined and drops deleted rows when omitted', async () => {
      const response = JSON.parse((await run({})).content[0].text);
      expect(mockApi.payees.getPayees).toHaveBeenCalledWith('test-budget-id', undefined);
      expect(response.payees).toHaveLength(1);
      expect(response.payees[0].deleted).toBe(false);
      expect(response.server_knowledge).toBe(42);
    });

    it('rejects negative and fractional values', () => {
      const schema = z.object(ListPayeesTool.inputSchema);
      expect(schema.safeParse({ lastKnowledgeOfServer: -1 }).success).toBe(false);
      expect(schema.safeParse({ lastKnowledgeOfServer: 1.5 }).success).toBe(false);
      expect(schema.safeParse({ lastKnowledgeOfServer: 0 }).success).toBe(true);
    });

    it('documents the parameter in the description', () => {
      for (const text of ['lastKnowledgeOfServer', 'server_knowledge', 'deleted: true']) {
        expect(ListPayeesTool.description).toContain(text);
      }
    });
  });
});
