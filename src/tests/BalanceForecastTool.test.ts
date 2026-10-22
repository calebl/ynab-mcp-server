import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import { z } from 'zod';
import * as BalanceForecastTool from '../tools/BalanceForecastTool';
import { occurrences, scheduleDates, scheduledDayOfMonth } from '../tools/BalanceForecastTool';

const TODAY = '2026-01-30';

const account = (id: string, name: string, balance: number, extra: Record<string, unknown> = {}) => ({
  id, name, balance, on_budget: true, closed: false, deleted: false, ...extra,
});

const scheduled = (id: string, date_next: string, frequency: string, amount: number, extra: Record<string, unknown> = {}) => ({
  id, date_first: date_next, date_next, frequency, amount,
  account_id: 'chk', account_name: 'Checking', payee_name: 'Payee', category_name: 'Bills',
  memo: null, transfer_account_id: null, deleted: false, subtransactions: [], ...extra,
});

const leg = (amount: number, extra: Record<string, unknown> = {}) => ({
  id: `leg-${amount}`, scheduled_transaction_id: 'split', amount, payee_name: null,
  category_name: 'Groceries', transfer_account_id: null, deleted: false, ...extra,
});

const ACCOUNTS = [
  account('chk', 'Checking', 1000000),
  account('sav', 'Savings', 5000000),
  account('card', 'Credit Card', -300000),
  account('brk', 'Brokerage', 9000000, { on_budget: false }),
  account('old', 'Old Card', -50000, { closed: true }),
  account('gone', 'Deleted', 70000, { deleted: true }),
];

describe('occurrences', () => {
  it('repeats each day-based frequency from the next date', () => {
    expect(occurrences('2026-01-01', 'daily', '2026-01-03')).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(occurrences('2026-01-01', 'weekly', '2026-01-20')).toEqual(['2026-01-01', '2026-01-08', '2026-01-15']);
    expect(occurrences('2026-01-01', 'everyOtherWeek', '2026-02-12')).toEqual(['2026-01-01', '2026-01-15', '2026-01-29', '2026-02-12']);
    expect(occurrences('2026-01-01', 'every4Weeks', '2026-03-01')).toEqual(['2026-01-01', '2026-01-29', '2026-02-26']);
  });

  it('repeats each month-based frequency by calendar months', () => {
    expect(occurrences('2026-01-15', 'monthly', '2026-03-15')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(occurrences('2026-01-15', 'everyOtherMonth', '2026-06-30')).toEqual(['2026-01-15', '2026-03-15', '2026-05-15']);
    expect(occurrences('2026-01-15', 'every3Months', '2026-12-31')).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
    expect(occurrences('2026-01-15', 'every4Months', '2026-12-31')).toEqual(['2026-01-15', '2026-05-15', '2026-09-15']);
    expect(occurrences('2026-01-15', 'twiceAYear', '2027-01-15')).toEqual(['2026-01-15', '2026-07-15', '2027-01-15']);
    expect(occurrences('2026-01-15', 'yearly', '2028-01-14')).toEqual(['2026-01-15', '2027-01-15']);
    expect(occurrences('2026-01-15', 'everyOtherYear', '2030-12-31')).toEqual(['2026-01-15', '2028-01-15', '2030-01-15']);
  });

  it('keeps the day of the month after a short month, and uses the last day where the month has no such day', () => {
    expect(occurrences('2026-01-31', 'monthly', '2026-05-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(occurrences('2026-08-31', 'every3Months', '2027-03-01')).toEqual(['2026-08-31', '2026-11-30', '2027-02-28']);
    expect(occurrences('2024-01-31', 'monthly', '2024-02-29')).toEqual(['2024-01-31', '2024-02-29']);
    expect(occurrences('2024-02-29', 'yearly', '2028-03-01')).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    expect(occurrences('2024-02-29', 'everyOtherYear', '2028-03-01')).toEqual(['2024-02-29', '2026-02-28', '2028-02-29']);
  });

  it('lands month-based schedules on the given day of the month, not the day of a short-month next date', () => {
    expect(occurrences('2026-02-28', 'monthly', '2026-05-31', 31)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(occurrences('2026-04-30', 'everyOtherMonth', '2026-08-31', 31)).toEqual(['2026-04-30', '2026-06-30', '2026-08-31']);
  });

  it("takes the schedule's day from date_first only when date_next was moved to a short month's last day", () => {
    expect(scheduledDayOfMonth('2026-01-31', '2026-02-28')).toBe(31);
    expect(scheduledDayOfMonth('2024-01-30', '2024-02-29')).toBe(30);
    expect(scheduledDayOfMonth('2026-01-31', '2026-03-31')).toBe(31);
    // date_first from before the schedule was moved to another day keeps date_next's day.
    expect(scheduledDayOfMonth('2025-06-10', '2026-02-15')).toBe(15);
    expect(scheduledDayOfMonth('2025-06-10', '2026-02-28')).toBe(28);
  });

  it('anchors twiceAMonth on date_first, approximating the second date as 15 days later only when YNAB does not give it', () => {
    // date_next is on date_first's day, so it is the first of a pair and the second is unknown.
    expect(scheduleDates('2025-12-01', '2026-01-01', 'twiceAMonth', '2026-02-20')).toEqual([
      { date: '2026-01-01' }, { date: '2026-01-16', approximate: true }, { date: '2026-02-01' }, { date: '2026-02-16', approximate: true },
    ]);
    // date_next is on another day, so it is the second of a pair and both days are known.
    expect(scheduleDates('2025-12-01', '2026-01-20', 'twiceAMonth', '2026-03-10')).toEqual([
      { date: '2026-01-20' }, { date: '2026-02-01' }, { date: '2026-02-20' }, { date: '2026-03-01' },
    ]);
    // A pair that spans the end of a month: the next first date is later in date_next's month.
    expect(scheduleDates('2025-12-20', '2026-01-04', 'twiceAMonth', '2026-03-10')).toEqual([
      { date: '2026-01-04' }, { date: '2026-01-20' }, { date: '2026-02-04' }, { date: '2026-02-20' }, { date: '2026-03-04' },
    ]);
    // A first date on the 31st that YNAB moved to February's last day.
    expect(scheduleDates('2026-01-31', '2026-02-28', 'twiceAMonth', '2026-03-31')).toEqual([
      { date: '2026-02-28' }, { date: '2026-03-15', approximate: true }, { date: '2026-03-31' },
    ]);
  });

  it('expands other frequencies from date_next on the scheduled day of the month', () => {
    expect(scheduleDates('2025-10-31', '2026-02-28', 'monthly', '2026-04-30')).toEqual([
      { date: '2026-02-28' }, { date: '2026-03-31' }, { date: '2026-04-30' },
    ]);
  });

  it('happens once for never, and not at all past the horizon', () => {
    expect(occurrences('2026-01-01', 'never', '2026-12-31')).toEqual(['2026-01-01']);
    expect(occurrences('2027-01-01', 'never', '2026-12-31')).toEqual([]);
    expect(occurrences('2027-01-01', 'monthly', '2026-12-31')).toEqual([]);
  });

  it('supports every frequency the YNAB SDK defines', () => {
    for (const frequency of Object.values(ynab.ScheduledTransactionFrequency)) {
      expect(() => scheduleDates('2026-01-01', '2026-01-01', frequency, '2026-12-31'), frequency).not.toThrow();
    }
  });
});

describe('BalanceForecastTool', () => {
  let mockApi: {
    accounts: { getAccounts: Mock };
    scheduledTransactions: { getScheduledTransactions: Mock };
    plans: { getPlanSettingsById: Mock };
  };

  const setScheduled = (rows: unknown[]) =>
    mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue({ data: { scheduled_transactions: rows } });

  const forecast = async (input: Record<string, unknown> = {}) => {
    const result = await BalanceForecastTool.execute(input, mockApi as any);
    return JSON.parse(result.content[0].text);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    mockApi = {
      accounts: { getAccounts: vi.fn().mockResolvedValue({ data: { accounts: ACCOUNTS } }) },
      scheduledTransactions: { getScheduledTransactions: vi.fn() },
      plans: {
        getPlanSettingsById: vi.fn().mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 2 } } } }),
      },
    };
    setScheduled([]);
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects the running balance and low point of the open on-budget accounts', async () => {
    setScheduled([
      scheduled('rent', '2026-02-01', 'monthly', -1500000, { payee_name: 'Landlord', category_name: 'Rent' }),
      scheduled('pay', '2026-02-06', 'never', 2000000, { payee_name: 'Employer', category_name: 'Inflow: Ready to Assign' }),
      scheduled('gym', '2026-01-31', 'weekly', -10000, { payee_name: 'Gym', category_name: 'Fitness' }),
    ]);

    const response = await forecast({ days: 10 });

    expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith('test-budget-id');
    expect(mockApi.scheduledTransactions.getScheduledTransactions).toHaveBeenCalledWith('test-budget-id');
    expect(response.from_date).toBe('2026-01-30');
    expect(response.until_date).toBe('2026-02-09');
    expect(response.accounts).toEqual(['Checking', 'Savings', 'Credit Card']);
    expect(response.starting_balance).toBe(5700);
    expect(response.events).toEqual([
      { date: '2026-01-31', amount: -10, payee_name: 'Gym', category_name: 'Fitness', account_name: 'Checking', scheduled_transaction_id: 'gym' },
      { date: '2026-02-01', amount: -1500, payee_name: 'Landlord', category_name: 'Rent', account_name: 'Checking', scheduled_transaction_id: 'rent' },
      { date: '2026-02-06', amount: 2000, payee_name: 'Employer', category_name: 'Inflow: Ready to Assign', account_name: 'Checking', scheduled_transaction_id: 'pay' },
      { date: '2026-02-07', amount: -10, payee_name: 'Gym', category_name: 'Fitness', account_name: 'Checking', scheduled_transaction_id: 'gym' },
    ]);
    expect(response.event_count).toBe(4);
    expect(response.running_balance).toEqual([
      { date: '2026-01-31', balance: 5690 },
      { date: '2026-02-01', balance: 4190 },
      { date: '2026-02-06', balance: 6190 },
      { date: '2026-02-07', balance: 6180 },
    ]);
    expect(response.low_point).toEqual({ date: '2026-02-01', balance: 4190 });
    expect(response.ending_balance).toBe(6180);
    expect(response.note).toMatch(/Only scheduled transactions/);
  });

  it('judges the low point by end-of-day balance, so a same-day paycheck covers a same-day bill', async () => {
    setScheduled([
      scheduled('bill', '2026-02-02', 'never', -6000000),
      scheduled('pay', '2026-02-02', 'never', 6500000),
    ]);

    const response = await forecast();

    expect(response.running_balance).toEqual([{ date: '2026-02-02', balance: 6200 }]);
    expect(response.low_point).toEqual({ date: '2026-01-30', balance: 5700 });
  });

  it('starts at today with the starting balance when nothing is scheduled, defaulting to 30 days', async () => {
    const response = await forecast();

    expect(response.until_date).toBe('2026-03-01');
    expect(response).toMatchObject({ event_count: 0, events: [], running_balance: [], starting_balance: 5700, ending_balance: 5700 });
    expect(response.low_point).toEqual({ date: '2026-01-30', balance: 5700 });
  });

  it('nets out transfers between included accounts, including credit card payments', async () => {
    setScheduled([
      scheduled('save', '2026-02-01', 'monthly', -200000, { transfer_account_id: 'sav', payee_name: 'Transfer : Savings', category_name: null }),
      scheduled('card', '2026-02-03', 'monthly', -300000, { transfer_account_id: 'card', payee_name: 'Transfer : Credit Card', category_name: null }),
    ]);

    const response = await forecast();

    expect(response.event_count).toBe(0);
    expect(response.ending_balance).toBe(5700);
  });

  it('counts a transfer once, on the included side, when the other account is outside the forecast', async () => {
    // YNAB lists a scheduled transfer once, on the account it is scheduled from;
    // transfer_account_id names the other side.
    const transfer = scheduled('save', '2026-02-01', 'never', -200000, { transfer_account_id: 'sav', payee_name: 'Transfer : Savings', category_name: null });
    const invest = scheduled('invest', '2026-02-02', 'never', -100000, { transfer_account_id: 'brk', payee_name: 'Transfer : Brokerage', category_name: null });
    setScheduled([transfer, invest]);

    const onlySavings = await forecast({ accountIds: ['sav'] });
    expect(onlySavings.events).toEqual([
      { date: '2026-02-01', amount: 200, payee_name: 'Transfer : Checking', category_name: null, account_name: 'Savings', scheduled_transaction_id: 'save' },
    ]);
    expect(onlySavings.ending_balance).toBe(5200);

    // On the receiving side the payee reads the way YNAB shows the transfer there.
    // The off-budget brokerage is outside the default set, so money sent there leaves.
    const byDefault = await forecast();
    expect(byDefault.events.map((e: any) => [e.scheduled_transaction_id, e.amount, e.account_name])).toEqual([['invest', -100, 'Checking']]);
  });

  it('counts a scheduled split leg by leg, netting out a leg that transfers to an included account', async () => {
    setScheduled([
      scheduled('split', '2026-02-01', 'never', -500000, {
        payee_name: 'Costco',
        category_name: 'Split',
        subtransactions: [
          leg(-300000),
          leg(-150000, { payee_name: 'Pharmacy', category_name: 'Health' }),
          leg(-50000, { transfer_account_id: 'sav', payee_name: 'Transfer : Savings', category_name: null }),
          leg(-999000, { deleted: true }),
        ],
      }),
    ]);

    const response = await forecast();

    expect(response.events).toEqual([
      { date: '2026-02-01', amount: -300, payee_name: 'Costco', category_name: 'Groceries', account_name: 'Checking', scheduled_transaction_id: 'split' },
      { date: '2026-02-01', amount: -150, payee_name: 'Pharmacy', category_name: 'Health', account_name: 'Checking', scheduled_transaction_id: 'split' },
    ]);
    expect(response.ending_balance).toBe(5250);
  });

  it('counts a split leg that transfers into an included account from one outside the forecast', async () => {
    setScheduled([
      scheduled('split', '2026-02-01', 'never', -500000, {
        account_id: 'brk', account_name: 'Brokerage', payee_name: 'Dividends', category_name: 'Split',
        subtransactions: [
          leg(-400000, { category_name: null }),
          leg(-100000, { transfer_account_id: 'chk', payee_name: 'Transfer : Checking', category_name: null }),
        ],
      }),
    ]);

    const response = await forecast();

    expect(response.events).toEqual([
      { date: '2026-02-01', amount: 100, payee_name: 'Transfer : Brokerage', category_name: null, account_name: 'Checking', scheduled_transaction_id: 'split' },
    ]);
  });

  it("keeps a monthly schedule on the 31st after YNAB moves date_next to February's last day", async () => {
    setScheduled([
      scheduled('rent', '2026-02-28', 'monthly', -1000000, { date_first: '2025-10-31' }),
    ]);

    const response = await forecast({ days: 60 });

    expect(response.events.map((e: any) => e.date)).toEqual(['2026-02-28', '2026-03-31']);
  });

  it('counts an occurrence that is past but not yet entered on the first day, keeping later dates aligned', async () => {
    setScheduled([
      scheduled('gym', '2026-01-29', 'weekly', -100000),
      scheduled('coffee', '2026-01-28', 'daily', -5000),
    ]);

    const response = await forecast({ days: 7 });

    expect(response.events.filter((e: any) => e.scheduled_transaction_id === 'gym').map((e: any) => e.date))
      .toEqual(['2026-01-30', '2026-02-05']);
    expect(response.events.filter((e: any) => e.scheduled_transaction_id === 'coffee').map((e: any) => e.date))
      .toEqual(['2026-01-30', '2026-01-30', '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06']);
    expect(response.running_balance[0]).toEqual({ date: '2026-01-30', balance: 5585 });
    expect(response.low_point.date >= response.from_date).toBe(true);

    // Overdue occurrences say when they were scheduled for, and are summarised per schedule.
    expect(response.events.filter((e: any) => e.overdue).map((e: any) => [e.scheduled_transaction_id, e.date, e.scheduled_date])).toEqual([
      ['gym', '2026-01-30', '2026-01-29'],
      ['coffee', '2026-01-30', '2026-01-28'],
      ['coffee', '2026-01-30', '2026-01-29'],
    ]);
    expect(response.events.find((e: any) => e.scheduled_transaction_id === 'coffee' && !e.overdue && e.date === '2026-01-30'))
      .not.toHaveProperty('scheduled_date');
    expect(response.overdue_schedules).toEqual([
      { scheduled_transaction_id: 'gym', count: 1, oldest_date: '2026-01-29' },
      { scheduled_transaction_id: 'coffee', count: 2, oldest_date: '2026-01-28' },
    ]);

    // A schedule outside the forecast is not reported as overdue.
    const otherAccount = await forecast({ accountIds: ['sav'] });
    expect(otherAccount).not.toHaveProperty('overdue_schedules');
  });

  it('leaves out events past the horizon, deleted schedules and accounts outside the forecast', async () => {
    setScheduled([
      scheduled('late', '2026-03-02', 'never', -1000),
      scheduled('deleted', '2026-02-01', 'never', -1000, { deleted: true }),
      scheduled('brokerage', '2026-02-01', 'never', -1000, { account_id: 'brk', account_name: 'Brokerage' }),
      scheduled('closed', '2026-02-01', 'never', -1000, { account_id: 'old', account_name: 'Old Card' }),
    ]);

    const response = await forecast({ days: 30 });

    expect(response.event_count).toBe(0);
  });

  it('marks twiceAMonth events approximate and reports unknown frequencies instead of guessing', async () => {
    setScheduled([
      scheduled('half', '2026-02-01', 'twiceAMonth', -1000),
      scheduled('odd', '2026-02-01', 'everyFullMoon', -1000),
    ]);

    const response = await forecast({ days: 20 });

    expect(response.events.map((e: any) => [e.date, e.approximate])).toEqual([['2026-02-01', undefined], ['2026-02-16', true]]);
    expect(response.unsupported_schedules).toEqual([{ scheduled_transaction_id: 'odd', frequency: 'everyFullMoon' }]);
  });

  it('returns the same response shape for explicit defaults as for omitted ones', async () => {
    setScheduled([scheduled('rent', '2026-02-01', 'monthly', -1500000)]);

    const omitted = await forecast();
    const explicit = await forecast({ days: 30, accountIds: ['chk', 'sav', 'card'], limit: 100 });

    expect(explicit).toEqual(omitted);
    expect(omitted.events_truncated).toBe(false);
    expect(omitted).not.toHaveProperty('unsupported_schedules');
    expect(omitted).not.toHaveProperty('overdue_schedules');
    expect(omitted.events[0]).not.toHaveProperty('overdue');
    expect(omitted.events[0]).not.toHaveProperty('approximate');
  });

  it('caps the events at limit while the balances still cover every event', async () => {
    setScheduled([scheduled('coffee', '2026-01-31', 'daily', -5000)]);

    const capped = await forecast({ limit: 5 });
    expect(capped.event_count).toBe(30);
    expect(capped.events_truncated).toBe(true);
    expect(capped.events.map((e: any) => e.date)).toEqual(['2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04']);
    expect(capped.running_balance).toHaveLength(30);
    expect(capped.ending_balance).toBe(5550);
    expect(capped.low_point).toEqual({ date: '2026-03-01', balance: 5550 });

    const without = await forecast({ limit: 0 });
    expect(without.events).toEqual([]);
    expect(without.event_count).toBe(30);
    expect(without.ending_balance).toBe(5550);

    const byDefault = await forecast({ days: 365 });
    expect(byDefault.events).toHaveLength(100);
    expect(byDefault.event_count).toBe(365);
  });

  it('rejects an empty accountIds list instead of forecasting nothing', () => {
    expect(z.object(BalanceForecastTool.inputSchema).safeParse({ accountIds: [] }).success).toBe(false);
  });

  it('includes closed or off-budget accounts when they are asked for', async () => {
    const response = await forecast({ accountIds: ['brk', 'old'] });

    expect(response.accounts).toEqual(['Brokerage', 'Old Card']);
    expect(response.starting_balance).toBe(8950);
  });

  it('uses the currency precision of the plan', async () => {
    mockApi.plans.getPlanSettingsById.mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 3 } } } });
    setScheduled([scheduled('fee', '2026-02-01', 'never', -1234)]);

    const response = await forecast({ accountIds: ['chk'] });

    expect(response.events[0].amount).toBe(-1.234);
    expect(response.ending_balance).toBe(998.766);
  });

  it('rejects unknown and deleted account ids', async () => {
    const response = await forecast({ accountIds: ['chk', 'nope', 'gone'] });

    expect(response.success).toBe(false);
    expect(response.error).toBe('Unknown account id(s): nope, gone');
  });

  it('returns success: false when the API call fails', async () => {
    mockApi.accounts.getAccounts.mockRejectedValue(new Error('boom'));

    expect(await forecast()).toEqual({ success: false, error: 'boom' });
  });
});
