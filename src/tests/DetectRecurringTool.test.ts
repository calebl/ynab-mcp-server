import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as DetectRecurringTool from '../tools/DetectRecurringTool';

// Every test runs on 2026-06-15, so the default window starts 2025-06-15.
const TODAY = '2026-06-15';

let seq = 0;
function txn(date: string, amount: number, payee_name: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: `t${seq++}`, date, amount, payee_name, deleted: false,
    category_id: 'c-subs', category_name: 'Subscriptions',
    transfer_account_id: null, subtransactions: [], ...extra,
  };
}

/** One charge per date, all for the same payee. */
function series(payee: string | null, dates: string[], amounts: number | number[], extra: Record<string, unknown> = {}) {
  return dates.map((date, i) => txn(date, Array.isArray(amounts) ? amounts[i] : amounts, payee, extra));
}

const MONTHLY_15TH = ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'];
const NETFLIX = series('Netflix', MONTHLY_15TH, [-15490, -15490, -15490, -15490, -16990, -16990]);

describe('DetectRecurringTool', () => {
  let mockApi: {
    transactions: { getTransactions: Mock };
    scheduledTransactions: { getScheduledTransactions: Mock };
    plans: { getPlanSettingsById: Mock };
  };

  function given(transactions: unknown[], scheduled: unknown[] = []) {
    mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions } });
    mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue({ data: { scheduled_transactions: scheduled } });
  }

  async function detect(input: Record<string, unknown> = {}) {
    const result = await DetectRecurringTool.execute(input, mockApi as any);
    return JSON.parse(result.content[0].text);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    mockApi = {
      transactions: { getTransactions: vi.fn() },
      scheduledTransactions: { getScheduledTransactions: vi.fn() },
      plans: { getPlanSettingsById: vi.fn().mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 2 } } } }) },
    };
    given([]);
    process.env.YNAB_PLAN_ID = 'test-plan-id';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a year of transactions plus the scheduled list, and reports a monthly charge', async () => {
    given(NETFLIX);

    const response = await detect();

    expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('test-plan-id', '2025-06-15');
    expect(mockApi.scheduledTransactions.getScheduledTransactions).toHaveBeenCalledWith('test-plan-id');
    expect(response).toEqual({
      since_date: '2025-06-15',
      count: 1,
      annual_cost_active: 185.88,
      recurring: [{
        payee_name: 'Netflix',
        category_name: 'Subscriptions',
        cadence: 'monthly',
        occurrences: 6,
        // Median of four 15.49 charges and two 16.99 ones.
        typical_amount: 15.49,
        latest_amount: 16.99,
        annual_cost: 185.88,
        first_date: '2026-01-15',
        last_date: '2026-06-15',
        next_expected_date: '2026-07-15',
        possibly_lapsed: false,
        already_scheduled: false,
      }],
    });
  });

  it('keeps a price change within amountTolerancePct in one series, and splits it at a tighter tolerance', async () => {
    given(NETFLIX);

    // 15.49 to 16.99 is a 9.7% rise.
    expect((await detect()).recurring.map((r: any) => r.occurrences)).toEqual([6]);

    // At 5% the two 16.99 charges form their own group, too small to be a pattern.
    const strict = await detect({ amountTolerancePct: 5 });
    expect(strict.recurring.map((r: any) => [r.occurrences, r.typical_amount])).toEqual([[4, 15.49]]);
  });

  it('separates two subscriptions from one payee by amount', async () => {
    const dates = ['2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10'];
    given([...series('Apple', dates, -990), ...series('Apple', dates, -9990)]);

    const response = await detect();

    expect(response.recurring.map((r: any) => [r.payee_name, r.typical_amount])).toEqual([['Apple', 9.99], ['Apple', 0.99]]);
  });

  it('finds weekly and biweekly charges', async () => {
    given([
      ...series('Car Wash', ['2026-05-16', '2026-05-23', '2026-05-30', '2026-06-06', '2026-06-13'], -5000),
      ...series('Dog Walker', ['2026-04-24', '2026-05-08', '2026-05-22', '2026-06-05'], -40000),
    ]);

    const response = await detect();

    expect(response.recurring.map((r: any) => [r.payee_name, r.cadence, r.annual_cost, r.next_expected_date])).toEqual([
      ['Dog Walker', 'biweekly', 1040, '2026-06-19'],
      ['Car Wash', 'weekly', 260, '2026-06-20'],
    ]);
  });

  it('finds a yearly charge when sinceDate reaches back far enough', async () => {
    given(series('Warehouse Club', ['2023-07-01', '2024-07-01', '2025-07-01'], -65000));

    const response = await detect({ sinceDate: '2023-01-01' });

    expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('test-plan-id', '2023-01-01');
    expect(response.recurring).toEqual([expect.objectContaining({
      payee_name: 'Warehouse Club',
      cadence: 'yearly',
      annual_cost: 65,
      next_expected_date: '2026-07-01',
      possibly_lapsed: false,
    })]);
  });

  it('keeps a month-end charge on the last day of a shorter month', async () => {
    given(series('Landlord', ['2026-03-31', '2026-04-30', '2026-05-31'], -150000, { category_name: 'Rent' }));

    const [rent] = (await detect()).recurring;

    expect(rent).toMatchObject({ cadence: 'monthly', category_name: 'Rent', next_expected_date: '2026-06-30' });
  });

  it('does not report a lone charge or irregular spending', async () => {
    given([
      txn('2026-05-02', -120000, 'Furniture Store'),
      ...series('Kroger', ['2026-01-26', '2026-04-06', '2026-05-13', '2026-05-16', '2026-06-06', '2026-06-12'], -60000),
    ]);

    expect((await detect()).recurring).toEqual([]);
    expect((await detect({ minOccurrences: 2 })).recurring).toEqual([]);
  });

  it('treats payee names that differ only in case or spacing as one payee', async () => {
    given(
      [
        txn('2026-03-03', -16990, 'SPOTIFY FAMILY'),
        txn('2026-04-03', -16990, ' spotify  family'),
        txn('2026-05-03', -16990, 'Spotify Family '),
        txn('2026-06-03', -16990, 'Spotify Family'),
      ],
      [{ id: 's1', payee_name: 'spotify family', deleted: false }],
    );

    const response = await detect();

    expect(response.recurring).toEqual([expect.objectContaining({
      payee_name: 'Spotify Family',
      occurrences: 4,
      already_scheduled: true,
    })]);
  });

  it('ignores deleted scheduled transactions when deciding already_scheduled', async () => {
    given(NETFLIX, [{ id: 's1', payee_name: 'Netflix', deleted: true }]);

    expect((await detect()).recurring[0].already_scheduled).toBe(false);
  });

  it('flags a charge that stopped and leaves it out of annual_cost_active', async () => {
    given([
      ...NETFLIX,
      ...series('Old Gym', ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'], -40000, { category_name: 'Fitness' }),
    ]);

    const response = await detect();

    // Largest yearly cost first.
    expect(response.recurring.map((r: any) => [r.payee_name, r.annual_cost, r.possibly_lapsed])).toEqual([
      ['Old Gym', 480, true],
      ['Netflix', 185.88, false],
    ]);
    expect(response.annual_cost_active).toBe(185.88);
  });

  it('excludes inflows, transfers, payee-less rows and deleted rows', async () => {
    given([
      ...series('Employer', MONTHLY_15TH, 300000, { category_name: 'Inflow: Ready to Assign' }),
      ...series('Transfer : Savings', MONTHLY_15TH, -50000, { transfer_account_id: 'acct-savings' }),
      ...series(null, MONTHLY_15TH, -1000),
      ...series('Netflix', MONTHLY_15TH, -15490, { deleted: true }),
    ]);

    expect((await detect()).recurring).toEqual([]);
  });

  // YNAB lists a split's subtransactions with payee_name null unless the leg has its own payee.
  // spending.ts counts each leg under its own payee when it has one and under the parent's otherwise.
  it('counts split legs under their own payee, or the parent payee when they have none', async () => {
    const split = (date: string) => txn(date, -104950, 'Comcast', {
      category_id: null, category_name: 'Split',
      subtransactions: [
        { id: `${date}-a`, amount: -70000, deleted: false, category_id: 'c-net', category_name: 'Internet', payee_name: null, transfer_account_id: null },
        { id: `${date}-b`, amount: -20000, deleted: false, category_id: 'c-phone', category_name: 'Phone', payee_name: null, transfer_account_id: null },
        { id: `${date}-c`, amount: -14950, deleted: false, category_id: 'c-subs', category_name: 'Subscriptions', payee_name: 'Audible', transfer_account_id: null },
      ],
    });
    given(['2026-03-20', '2026-04-20', '2026-05-20'].map(split));

    const response = await detect();

    expect(response.recurring.map((r: any) => [r.payee_name, r.category_name, r.typical_amount])).toEqual([
      ['Comcast', 'Internet', 70],
      ['Comcast', 'Phone', 20],
      ['Audible', 'Subscriptions', 14.95],
    ]);
  });

  it('returns the same response when the defaults are given explicitly', async () => {
    given(NETFLIX);

    expect(await detect({ sinceDate: '2025-06-15', minOccurrences: 3, amountTolerancePct: 10 })).toEqual(await detect());
  });

  it('returns success: false when YNAB fails', async () => {
    mockApi.transactions.getTransactions.mockRejectedValue(new Error('boom'));

    expect(await detect()).toEqual({ success: false, error: 'boom' });
  });
});
