import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as GetPayeeTool from '../tools/GetPayeeTool';

describe('GetPayeeTool', () => {
  let mockApi: { payees: { getPayeeById: Mock } };

  const payee = { id: 'payee-1', name: 'Grocer', transfer_account_id: null, deleted: false };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      payees: { getPayeeById: vi.fn().mockResolvedValue({ data: { payee } }) },
    };
    delete process.env.YNAB_PLAN_ID;
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('returns the payee fields unchanged', async () => {
    const result = await GetPayeeTool.execute({ payeeId: 'payee-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(mockApi.payees.getPayeeById).toHaveBeenCalledWith('test-budget-id', 'payee-1');
    expect(response.payee).toEqual(payee);
  });

  it('returns success false with the error message when the API rejects', async () => {
    mockApi.payees.getPayeeById.mockRejectedValue(new Error('Payee not found'));

    const result = await GetPayeeTool.execute({ payeeId: 'payee-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Payee not found');
  });
});
