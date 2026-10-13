import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as GetAccountTool from '../tools/GetAccountTool';

describe('GetAccountTool', () => {
  let mockApi: { accounts: { getAccountById: Mock } };

  // Optional SDK fields (note, direct_import_*, last_reconciled_at) are deliberately absent.
  const account = {
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      accounts: { getAccountById: vi.fn().mockResolvedValue({ data: { account } }) },
    };
    delete process.env.YNAB_PLAN_ID;
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('returns the account with balances in dollars', async () => {
    const result = await GetAccountTool.execute({ accountId: 'account-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(mockApi.accounts.getAccountById).toHaveBeenCalledWith('test-budget-id', 'account-1');
    expect(response.account).toMatchObject({
      id: 'account-1',
      name: 'Checking',
      type: 'checking',
      on_budget: true,
      closed: false,
      deleted: false,
      balance: 5000,
      cleared_balance: 4500,
      uncleared_balance: 500,
      transfer_payee_id: 'payee-transfer-1',
    });
  });

  it('returns null for optional fields the SDK omits', async () => {
    const result = await GetAccountTool.execute({ accountId: 'account-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.account.note).toBeNull();
    expect(response.account.direct_import_linked).toBeNull();
    expect(response.account.direct_import_in_error).toBeNull();
    expect(response.account.last_reconciled_at).toBeNull();
  });

  it('returns success false with the error message when the API rejects', async () => {
    mockApi.accounts.getAccountById.mockRejectedValue(new Error('API Error'));

    const result = await GetAccountTool.execute({ accountId: 'account-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
  });

  it('returns an error when no plan ID is available', async () => {
    delete process.env.YNAB_BUDGET_ID;

    const result = await GetAccountTool.execute({ accountId: 'account-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toContain('No plan ID provided');
    expect(mockApi.accounts.getAccountById).not.toHaveBeenCalled();
  });

  it('exposes its name and accountId input', () => {
    expect(GetAccountTool.name).toBe('ynab_get_account');
    expect(GetAccountTool.inputSchema).toHaveProperty('accountId');
  });
});
