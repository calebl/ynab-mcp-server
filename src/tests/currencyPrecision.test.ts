import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ListAccountsTool from '../tools/ListAccountsTool';
import * as GetTransactionsTool from '../tools/GetTransactionsTool';
import * as SpendingByCategoryTool from '../tools/SpendingByCategoryTool';
import * as CashFlowTool from '../tools/CashFlowTool';
import * as MoveMoneyTool from '../tools/MoveMoneyTool';
import * as UpdateTransactionTool from '../tools/UpdateTransactionTool';

/** Plan settings for a Kuwaiti dinar plan, whose currency has three decimal places. */
function planSettings(decimalDigits: number) {
  return vi.fn().mockResolvedValue({
    data: { settings: { currency_format: { iso_code: decimalDigits === 3 ? 'KWD' : 'USD', decimal_digits: decimalDigits } } },
  });
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

describe('amounts in a 3-decimal currency plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // YNAB_PLAN_ID wins over YNAB_BUDGET_ID, so a developer's own setting must not leak in.
    vi.stubEnv('YNAB_PLAN_ID', 'plan-kwd');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists account balances with all three decimals', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      accounts: {
        getAccounts: vi.fn().mockResolvedValue({
          data: {
            accounts: [{
              id: 'a1', name: 'Checking', type: 'checking', on_budget: true, closed: false, deleted: false,
              balance: 1234, cleared_balance: 12345, uncleared_balance: -11111,
            }],
          },
        }),
      },
    };

    const response = parse(await ListAccountsTool.execute({}, api as any));

    expect(api.plans.getPlanSettingsById).toHaveBeenCalledWith('plan-kwd');
    expect(response.accounts[0]).toMatchObject({ balance: 1.234, cleared_balance: 12.345, uncleared_balance: -11.111 });
  });

  it('lists transactions and their splits with all three decimals', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      transactions: {
        getTransactions: vi.fn().mockResolvedValue({
          data: {
            transactions: [{
              id: 't1', date: '2024-03-01', amount: -12345, deleted: false,
              subtransactions: [
                { id: 's1', transaction_id: 't1', amount: -10001, deleted: false },
                { id: 's2', transaction_id: 't1', amount: -2344, deleted: false },
              ],
            }],
          },
        }),
      },
    };

    const response = parse(await GetTransactionsTool.execute({}, api as any));

    expect(response.transactions[0].amount).toBe(-12.345);
    expect(response.transactions[0].subtransactions.map((sub: any) => sub.amount)).toEqual([-10.001, -2.344]);
  });

  it('totals spending without losing the third decimal', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      transactions: {
        getTransactions: vi.fn().mockResolvedValue({
          data: {
            transactions: [
              { id: 't1', date: '2024-03-01', amount: -1234, deleted: false, category_name: 'Groceries', payee_name: 'Market', subtransactions: [] },
              { id: 't2', date: '2024-03-02', amount: -1001, deleted: false, category_name: 'Groceries', payee_name: 'Market', subtransactions: [] },
            ],
          },
        }),
      },
    };

    const response = parse(await SpendingByCategoryTool.execute({ sinceDate: '2024-03-01' }, api as any));

    expect(response.total_spent).toBe(2.235);
    expect(response.categories[0]).toMatchObject({ total: 2.235, average: 1.118 });
  });

  it('rounds a spending average that falls on a half unit away from zero', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      transactions: {
        getTransactions: vi.fn().mockResolvedValue({
          data: {
            transactions: [
              { id: 't1', date: '2024-03-01', amount: -2, deleted: false, category_name: 'Fees', payee_name: 'Bank', subtransactions: [] },
              { id: 't2', date: '2024-03-02', amount: -19, deleted: false, category_name: 'Fees', payee_name: 'Bank', subtransactions: [] },
            ],
          },
        }),
      },
    };

    const response = parse(await SpendingByCategoryTool.execute({ sinceDate: '2024-03-01' }, api as any));

    expect(response.categories[0]).toMatchObject({ total: 0.021, average: 0.011 });
  });

  it('rounds a monthly net average that falls on a half unit away from zero', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      months: {
        getPlanMonths: vi.fn().mockResolvedValue({
          data: {
            months: [
              { month: '2024-03-01', income: 2, activity: 0, budgeted: 0, deleted: false },
              { month: '2024-04-01', income: 19, activity: 0, budgeted: 0, deleted: false },
            ],
          },
        }),
      },
    };

    const response = parse(await CashFlowTool.execute({}, api as any));

    expect(response.net).toBe(0.021);
    expect(response.average_monthly_net).toBe(0.011);
  });

  it('reports cash flow without losing the third decimal', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      months: {
        getPlanMonths: vi.fn().mockResolvedValue({
          data: { months: [{ month: '2024-03-01', income: 500125, activity: -200005, budgeted: 300001, deleted: false }] },
        }),
      },
    };

    const response = parse(await CashFlowTool.execute({}, api as any));

    expect(response.months[0]).toMatchObject({ income: 500.125, spent: 200.005, net: 300.12, budgeted: 300.001 });
    expect(response.net).toBe(300.12);
  });

  it('moves a 3-decimal amount and reports it with three decimals', async () => {
    const source = { id: 'cat-from', name: 'Dining Out', budgeted: 10000, balance: 5000 };
    const destination = { id: 'cat-to', name: 'Groceries', budgeted: 2000, balance: 0 };
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      categories: {
        getMonthCategoryById: vi.fn(async (_p: string, _m: string, id: string) => ({
          data: { category: id === source.id ? source : destination },
        })),
        updateMonthCategory: vi.fn(async (_p: string, _m: string, id: string, body: any) => ({
          data: { category: { ...(id === source.id ? source : destination), budgeted: body.category.budgeted } },
        })),
      },
    };

    const response = parse(await MoveMoneyTool.execute(
      { fromCategoryId: 'cat-from', toCategoryId: 'cat-to', amount: 1.234 },
      api as any,
    ));

    expect(api.categories.updateMonthCategory.mock.calls[0][3]).toEqual({ category: { budgeted: 8766 } });
    expect(api.categories.updateMonthCategory.mock.calls[1][3]).toEqual({ category: { budgeted: 3234 } });
    expect(response.from.budgeted).toBe(8.766);
    expect(response.to.budgeted).toBe(3.234);
    expect(response.message).toBe('Moved $1.234 from Dining Out to Groceries');
  });

  it('reports the rounded amount actually moved', async () => {
    const source = { id: 'cat-from', name: 'Dining Out', budgeted: 10000, balance: 5000 };
    const destination = { id: 'cat-to', name: 'Groceries', budgeted: 2000, balance: 0 };
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      categories: {
        getMonthCategoryById: vi.fn(async (_p: string, _m: string, id: string) => ({
          data: { category: id === source.id ? source : destination },
        })),
        updateMonthCategory: vi.fn(async (_p: string, _m: string, id: string, body: any) => ({
          data: { category: { ...(id === source.id ? source : destination), budgeted: body.category.budgeted } },
        })),
      },
    };

    const response = parse(await MoveMoneyTool.execute(
      { fromCategoryId: 'cat-from', toCategoryId: 'cat-to', amount: 1.2345 },
      api as any,
    ));

    expect(api.categories.updateMonthCategory.mock.calls[0][3]).toEqual({ category: { budgeted: 8765 } });
    expect(api.categories.updateMonthCategory.mock.calls[1][3]).toEqual({ category: { budgeted: 3235 } });
    expect(response.amount).toBe(1.235);
    expect(response.message).toBe('Moved $1.235 from Dining Out to Groceries');
  });

  it('writes a 3-decimal amount intact and reads it back the same', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(3) },
      transactions: {
        updateTransaction: vi.fn(async (_p: string, id: string, body: any) => ({
          data: { transaction: { id, date: '2024-03-01', amount: body.transaction.amount, subtransactions: [] } },
        })),
      },
    };

    const response = parse(await UpdateTransactionTool.execute({ transactionId: 't1', amount: -12.345 }, api as any));

    expect(api.transactions.updateTransaction.mock.calls[0][2]).toEqual({ transaction: { amount: -12345 } });
    expect(response.transaction.amount).toBe(-12.345);
  });
});

describe('amounts in a 2-decimal currency plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('YNAB_PLAN_ID', 'plan-usd');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('aggregates raw milliunits before rounding totals and averages', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(2) },
      transactions: {
        getTransactions: vi.fn().mockResolvedValue({
          data: {
            transactions: [
              { id: 't1', date: '2024-03-01', amount: -4, deleted: false, category_name: 'Fees', payee_name: 'Bank', subtransactions: [] },
              { id: 't2', date: '2024-03-02', amount: -4, deleted: false, category_name: 'Fees', payee_name: 'Bank', subtransactions: [] },
              { id: 't3', date: '2024-03-03', amount: -7, deleted: false, category_name: 'Fees', payee_name: 'Bank', subtransactions: [] },
            ],
          },
        }),
      },
    };

    const response = parse(await SpendingByCategoryTool.execute({ sinceDate: '2024-03-01' }, api as any));

    expect(response.total_spent).toBe(0.02);
    expect(response.categories[0]).toMatchObject({ total: 0.02, average: 0.01 });
  });

  it('reports and formats the amount represented by the applied milliunits', async () => {
    const source = { id: 'cat-from', name: 'Dining Out', budgeted: 10000, balance: 5000 };
    const destination = { id: 'cat-to', name: 'Groceries', budgeted: 2000, balance: 0 };
    const api = {
      plans: { getPlanSettingsById: planSettings(2) },
      categories: {
        getMonthCategoryById: vi.fn(async (_p: string, _m: string, id: string) => ({
          data: { category: id === source.id ? source : destination },
        })),
        updateMonthCategory: vi.fn(async (_p: string, _m: string, id: string, body: any) => ({
          data: { category: { ...(id === source.id ? source : destination), budgeted: body.category.budgeted } },
        })),
      },
    };

    const response = parse(await MoveMoneyTool.execute(
      { fromCategoryId: 'cat-from', toCategoryId: 'cat-to', amount: 1.2345 },
      api as any,
    ));

    expect(api.categories.updateMonthCategory.mock.calls[0][3]).toEqual({ category: { budgeted: 8765 } });
    expect(api.categories.updateMonthCategory.mock.calls[1][3]).toEqual({ category: { budgeted: 3235 } });
    expect(response.amount).toBe(1.24);
    expect(response.message).toBe('Moved $1.24 from Dining Out to Groceries');
  });

  it('rounds an outflow and an inflow of the same size to the same magnitude', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(2) },
      transactions: {
        getTransactions: vi.fn().mockResolvedValue({
          data: {
            transactions: [
              { id: 'out', date: '2024-03-01', amount: -1005, deleted: false },
              { id: 'in', date: '2024-03-01', amount: 1005, deleted: false },
            ],
          },
        }),
      },
    };

    const response = parse(await GetTransactionsTool.execute({}, api as any));

    expect(response.transactions.map((txn: any) => txn.amount)).toEqual([-1.01, 1.01]);
  });

  it('keeps two decimals when the plan settings cannot be read', async () => {
    const api = {
      plans: { getPlanSettingsById: vi.fn().mockRejectedValue(new Error('rate limited')) },
      accounts: {
        getAccounts: vi.fn().mockResolvedValue({
          data: { accounts: [{ id: 'a1', name: 'Checking', closed: false, deleted: false, balance: 1234, cleared_balance: 1234, uncleared_balance: 0 }] },
        }),
      },
    };

    const response = parse(await ListAccountsTool.execute({}, api as any));

    expect(response.accounts[0].balance).toBe(1.23);
  });

  it('reads the plan settings once across tool calls on the same client', async () => {
    const api = {
      plans: { getPlanSettingsById: planSettings(2) },
      accounts: {
        getAccounts: vi.fn().mockResolvedValue({
          data: { accounts: [{ id: 'a1', name: 'Checking', closed: false, deleted: false, balance: 1234, cleared_balance: 1234, uncleared_balance: 0 }] },
        }),
      },
      transactions: {
        getTransactions: vi.fn().mockResolvedValue({
          data: { transactions: [{ id: 't1', date: '2024-03-01', amount: -1005, deleted: false, subtransactions: [] }] },
        }),
      },
    };

    await ListAccountsTool.execute({}, api as any);
    await ListAccountsTool.execute({}, api as any);
    await GetTransactionsTool.execute({}, api as any);
    await SpendingByCategoryTool.execute({ sinceDate: '2024-03-01' }, api as any);

    expect(api.accounts.getAccounts).toHaveBeenCalledTimes(2);
    expect(api.transactions.getTransactions).toHaveBeenCalledTimes(2);
    expect(api.plans.getPlanSettingsById).toHaveBeenCalledTimes(1);
  });
});
