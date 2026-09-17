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
  untilDate?: string
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
          amount: toDollars(-sub.amount),
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
      amount: toDollars(-transaction.amount),
      categoryId: transaction.category_id ?? null,
      categoryName: transaction.category_name || UNCATEGORIZED,
      payeeName,
    });
  }

  return entries;
}

export interface SpendingGroup {
  name: string;
  total: number;
  transaction_count: number;
  average: number;
  share_of_total: number;
}

/** Totals entries by some key, largest spend first. */
export function groupSpending(
  entries: SpendingEntry[],
  keyOf: (entry: SpendingEntry) => string
): SpendingGroup[] {
  const totals = new Map<string, { total: number; count: number }>();

  for (const entry of entries) {
    const key = keyOf(entry);
    const running = totals.get(key) ?? { total: 0, count: 0 };
    running.total += entry.amount;
    running.count += 1;
    totals.set(key, running);
  }

  const grandTotal = entries.reduce((sum, entry) => sum + entry.amount, 0);

  return [...totals.entries()]
    .map(([name, { total, count }]) => ({
      name,
      total: round2(total),
      transaction_count: count,
      average: round2(total / count),
      share_of_total: grandTotal > 0 ? round2((total / grandTotal) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);
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
