import * as ynab from "ynab";
import { toDollars } from "./money.js";

/**
 * Shared plumbing for the spending reports. The awkward parts of turning YNAB
 * transactions into "where did the money go" totals live here: split
 * transactions have to be counted through their subtransactions, and transfers
 * between your own accounts are movement rather than spending.
 */

/** One outflow, already flattened out of any split it belonged to. */
export interface SpendingEntry {
  date: string;
  /** Positive number of currency units spent. */
  amount: number;
  amountMilliunits: number;
  categoryId: string | null;
  categoryName: string;
  payeeName: string;
}

const UNCATEGORIZED = "Uncategorized";
const UNKNOWN_PAYEE = "Unknown payee";

/**
 * Flattens transactions into individual outflows within [sinceDate, untilDate],
 * dropping deleted rows, transfers, and anything that is money coming in.
 */
export function collectSpending(
  transactions: ynab.TransactionDetail[],
  untilDate?: string,
  decimalDigits?: number
): SpendingEntry[] {
  const entries: SpendingEntry[] = [];

  for (const transaction of transactions) {
    if (transaction.deleted) continue;
    if (untilDate && transaction.date > untilDate) continue;

    const payeeName = transaction.payee_name || UNKNOWN_PAYEE;
    const subtransactions = (transaction.subtransactions ?? []).filter((sub) => !sub.deleted);

    if (subtransactions.length > 0) {
      // A split's own amount duplicates its children, so only the children count.
      for (const sub of subtransactions) {
        if (sub.transfer_account_id) continue;
        if (sub.amount >= 0) continue;

        entries.push({
          date: transaction.date,
          amount: toDollars(-sub.amount, decimalDigits),
          amountMilliunits: -sub.amount,
          categoryId: sub.category_id ?? null,
          categoryName: sub.category_name || UNCATEGORIZED,
          payeeName: sub.payee_name || payeeName,
        });
      }
      continue;
    }

    if (transaction.transfer_account_id) continue;
    if (transaction.amount >= 0) continue;

    entries.push({
      date: transaction.date,
      amount: toDollars(-transaction.amount, decimalDigits),
      amountMilliunits: -transaction.amount,
      categoryId: transaction.category_id ?? null,
      categoryName: transaction.category_name || UNCATEGORIZED,
      payeeName,
    });
  }

  return entries;
}

export interface MonthTotal {
  /** First day of the month, the way YNAB names months. */
  month: string;
  total: number;
  transaction_count: number;
}

export interface SpendingGroup {
  name: string;
  total: number;
  transaction_count: number;
  average: number;
  share_of_total: number;
  // Only with a monthly breakdown:
  /** Mean over the full months in the range; null when there are none. */
  average_monthly?: number | null;
  /** Last full month against the mean of the earlier full months, in percent; null without a nonzero mean. */
  change_pct?: number | null;
  monthly?: MonthTotal[];
}

interface Running {
  totalMilliunits: number;
  count: number;
}

/**
 * Totals entries by some key, largest spend first. Given a monthly window,
 * each group also carries a month-by-month series over that window.
 */
export function groupSpending(
  entries: SpendingEntry[],
  keyOf: (entry: SpendingEntry) => string,
  decimalDigits?: number,
  window?: MonthlyWindow
): SpendingGroup[] {
  const totals = new Map<string, Running & { byMonth: Map<string, Running> }>();

  for (const entry of entries) {
    const key = keyOf(entry);
    const running = totals.get(key) ?? { totalMilliunits: 0, count: 0, byMonth: new Map() };
    running.totalMilliunits += entry.amountMilliunits;
    running.count += 1;
    if (window) {
      const month = monthOf(entry.date);
      const inMonth = running.byMonth.get(month) ?? { totalMilliunits: 0, count: 0 };
      inMonth.totalMilliunits += entry.amountMilliunits;
      inMonth.count += 1;
      running.byMonth.set(month, inMonth);
    }
    totals.set(key, running);
  }

  const grandTotalMilliunits = entries.reduce((sum, entry) => sum + entry.amountMilliunits, 0);

  return [...totals.entries()]
    .sort(([, a], [, b]) => b.totalMilliunits - a.totalMilliunits)
    .map(([name, { totalMilliunits, count, byMonth }]) => ({
      name,
      total: toDollars(totalMilliunits, decimalDigits),
      transaction_count: count,
      average: toDollars(totalMilliunits / count, decimalDigits),
      share_of_total: grandTotalMilliunits > 0 ? round2((totalMilliunits / grandTotalMilliunits) * 100) : 0,
      ...(window ? monthlyBreakdown(byMonth, window, decimalDigits) : {}),
    }));
}

/** At most this many calendar months in a monthly breakdown. */
export const MAX_MONTHS = 24;
const DEFAULT_MONTHS = 6;

/** The calendar months a monthly breakdown covers. */
export interface MonthlyWindow {
  sinceDate: string;
  untilDate: string;
  /** Every month the range touches, oldest first. */
  months: string[];
  /**
   * Months wholly inside the range. The first month is partial when the range
   * starts after its first day, and the last when the range ends before its
   * last day (usually the current month).
   */
  fullMonths: string[];
}

/**
 * Resolves the range of a monthly breakdown: sinceDate when given (as with
 * ynab_cash_flow, it overrides the months count), otherwise the `months`
 * calendar months ending with the month of untilDate. untilDate defaults to
 * today, so the series has a last month to end on.
 */
export function monthlyWindow(input: { sinceDate?: string; untilDate?: string; months?: number }): MonthlyWindow {
  const untilDate = input.untilDate || daysAgo(0);
  const sinceDate = input.sinceDate || addMonths(monthOf(untilDate), 1 - (input.months ?? DEFAULT_MONTHS));
  if (sinceDate > untilDate) {
    throw new Error(`sinceDate ${sinceDate} is after untilDate ${untilDate}.`);
  }

  const months: string[] = [];
  for (let month = monthOf(sinceDate); month <= untilDate; month = addMonths(month, 1)) {
    months.push(month);
  }
  if (months.length > MAX_MONTHS) {
    throw new Error(`A monthly breakdown covers at most ${MAX_MONTHS} months; ${sinceDate} to ${untilDate} spans ${months.length}.`);
  }

  const fullMonths = months.filter((month) => month >= sinceDate && lastDayOf(month) <= untilDate);
  return { sinceDate, untilDate, months, fullMonths };
}

/** Top-level fields describing a monthly window in a report. */
export function describeWindow(window: MonthlyWindow) {
  const { months, fullMonths } = window;
  const lastFullMonth = fullMonths.length > 0 ? fullMonths[fullMonths.length - 1] : null;
  return {
    months,
    full_month_count: fullMonths.length,
    last_full_month: lastFullMonth,
    change_compares: lastFullMonth
      ? `${lastFullMonth} against the mean of ${fullMonths.length - 1} earlier full month(s)`
      : "no full month in range",
  };
}

function monthlyBreakdown(byMonth: Map<string, Running>, window: MonthlyWindow, decimalDigits?: number) {
  const totalIn = (month: string) => byMonth.get(month)?.totalMilliunits ?? 0;
  const mean = (months: string[]) => months.reduce((sum, month) => sum + totalIn(month), 0) / months.length;

  const { fullMonths } = window;
  const earlier = fullMonths.slice(0, -1);
  const earlierMean = earlier.length > 0 ? mean(earlier) : 0;
  const last = fullMonths[fullMonths.length - 1];

  return {
    average_monthly: fullMonths.length > 0 ? toDollars(mean(fullMonths), decimalDigits) : null,
    change_pct: earlierMean > 0 ? round2(((totalIn(last) - earlierMean) / earlierMean) * 100) : null,
    monthly: window.months.map((month) => ({
      month,
      total: toDollars(totalIn(month), decimalDigits),
      transaction_count: byMonth.get(month)?.count ?? 0,
    })),
  };
}

/** Returns an ISO date `days` before today, for defaulting report windows. */
export function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** First day of the month containing `date`. */
function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** First day of the month `count` months after the month containing `date`. */
function addMonths(date: string, count: number): string {
  const moved = new Date(`${monthOf(date)}T00:00:00Z`);
  moved.setUTCMonth(moved.getUTCMonth() + count);
  return moved.toISOString().slice(0, 10);
}

/** Last day of the month containing `date`. */
function lastDayOf(date: string): string {
  const day = new Date(`${addMonths(date, 1)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
