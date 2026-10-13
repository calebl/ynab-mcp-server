import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as UpdatePayeeTool from '../tools/UpdatePayeeTool';

describe('UpdatePayeeTool', () => {
  let mockApi: { payees: { updatePayee: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      payees: {
        updatePayee: vi.fn().mockResolvedValue({
          data: { payee: { id: 'payee-1', name: 'New Name', transfer_account_id: null, deleted: false } },
        }),
      },
    };
    delete process.env.YNAB_PLAN_ID;
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('sends only the new name and returns the renamed payee', async () => {
    const result = await UpdatePayeeTool.execute({ payeeId: 'payee-1', name: 'New Name' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(mockApi.payees.updatePayee).toHaveBeenCalledWith('test-budget-id', 'payee-1', { payee: { name: 'New Name' } });
    expect(response.success).toBe(true);
    expect(response.payee).toEqual({ id: 'payee-1', name: 'New Name', transfer_account_id: null });
    expect(response.message).toBe('Payee renamed to "New Name"');
  });

  it('rejects an empty name and a name over 500 characters', () => {
    expect(UpdatePayeeTool.inputSchema.name.safeParse('').success).toBe(false);
    expect(UpdatePayeeTool.inputSchema.name.safeParse('x'.repeat(501)).success).toBe(false);
    expect(UpdatePayeeTool.inputSchema.name.safeParse('x'.repeat(500)).success).toBe(true);
  });

  it('returns success false with the error message when the API rejects', async () => {
    mockApi.payees.updatePayee.mockRejectedValue(new Error('Transfer payees cannot be renamed'));

    const result = await UpdatePayeeTool.execute({ payeeId: 'payee-1', name: 'New Name' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Transfer payees cannot be renamed');
  });
});
