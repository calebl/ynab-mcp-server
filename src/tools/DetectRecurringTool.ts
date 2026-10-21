import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { collectSpending, daysAgo, type SpendingEntry, UNKNOWN_PAYEE } from "./spending.js";

export const name = "ynab_detect_recurring";
export const description = "Finds recurring outflows (subscriptions, bills, memberships) in transaction history by payee, similar amount and regular spacing, whether or not they are scheduled in YNAB. Gives each one's cadence, typical amount, yearly cost, next expected date, and whether it seems to have stopped. This is a heuristic: check the results before acting on them. Splits are counted through their subtransactions, and transfers between your own accounts (including credit card payments) and inflows are excluded. Reads the whole history window in one request, so a long sinceDate on a busy plan returns a large payload. Yearly charges need a sinceDate far enough back to show minOccurrences of them.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start of the history to scan, inclusive (ISO format: 2025-01-01). Defaults to 365 days ago."),
  minOccurrences: z.number().int().min(2).optional().describe("How many charges of a similar amount from one payee make a pattern (default: 3)"),
  amountTolerancePct: z.number().min(0).max(100).optional().describe("How far above the smallest charge in a group another charge may be and still count, in percent (default: 10)"),
};

interface DetectRecurringInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  minOccurrences?: number;
  amountTolerancePct?: number;
}

interface Cadence {
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  /** Shortest and longest gap between charges, in days, that fit this cadence. */
  minDays: number;
  maxDays: number;
  next: (date: string) => string;
  perYear: number;
}

const CADENCES: Cadence[] = [
  { cadence: "weekly", minDays: 6, maxDays: 8, next: (d) => addDays(d, 7), perYear: 52 },
  { cadence: "biweekly", minDays: 13, maxDays: 16, next: (d) => addDays(d, 14), perYear: 26 },
  { cadence: "monthly", minDays: 27, maxDays: 33, next: (d) => addMonthsKeepingDay(d, 1), perYear: 12 },
  { cadence: "quarterly", minDays: 85, maxDays: 97, next: (d) => addMonthsKeepingDay(d, 3), perYear: 4 },
  { cadence: "yearly", minDays: 350, maxDays: 380, next: (d) => addMonthsKeepingDay(d, 12), perYear: 1 },
];

/** Share of the gaps between charges that must fit one cadence. */
const REGULARITY = 0.6;

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Moves `date` by whole months, keeping its day of the month or clamping to the month's last day (Jan 31 + 1 = Feb 28). */
function addMonthsKeepingDay(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Payee names that differ only in case or spacing ("NETFLIX ", "Netflix") are one payee. */
function payeeKey(payeeName: string): string {
  return payeeName.trim().replace(/\s+/g, " ").toLowerCase();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Splits one payee's charges into groups of similar amounts, smallest first. */
function amountGroups(entries: SpendingEntry[], tolerance: number): SpendingEntry[][] {
  const groups: SpendingEntry[][] = [];
  for (const entry of [...entries].sort((a, b) => a.amountMilliunits - b.amountMilliunits)) {
    const current = groups.at(-1);
    if (current && entry.amountMilliunits <= current[0].amountMilliunits * (1 + tolerance)) current.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

function cadenceOf(dates: string[]): Cadence | undefined {
  const gaps = dates.slice(1).map((date, i) => daysBetween(dates[i], date));
  const needed = Math.max(1, gaps.length * REGULARITY);
  return CADENCES.find((c) => gaps.filter((gap) => gap >= c.minDays && gap <= c.maxDays).length >= needed);
}

export async function execute(input: DetectRecurringInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const sinceDate = input.sinceDate || daysAgo(365);
    const minOccurrences = input.minOccurrences ?? 3;
    const tolerance = (input.amountTolerancePct ?? 10) / 100;

    const [transactionsResponse, scheduledResponse, decimalDigits] = await Promise.all([
      api.transactions.getTransactions(budgetId, sinceDate),
      api.scheduledTransactions.getScheduledTransactions(budgetId),
      getDecimalDigits(api, budgetId),
    ]);

    const scheduledPayees = new Set(scheduledResponse.data.scheduled_transactions
      .filter((scheduled) => !scheduled.deleted && scheduled.payee_name)
      .map((scheduled) => payeeKey(scheduled.payee_name!)));

    const byPayee = new Map<string, SpendingEntry[]>();
    for (const entry of collectSpending(transactionsResponse.data.transactions, undefined, decimalDigits)) {
      if (entry.payeeName === UNKNOWN_PAYEE) continue;
      const key = payeeKey(entry.payeeName);
      const entries = byPayee.get(key) ?? [];
      entries.push(entry);
      byPayee.set(key, entries);
    }

    const today = new Date().toISOString().slice(0, 10);
    const found = [];
    for (const [key, entries] of byPayee) {
      for (const group of amountGroups(entries, tolerance)) {
        if (group.length < minOccurrences) continue;
        const charges = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const cadence = cadenceOf(charges.map((charge) => charge.date));
        if (!cadence) continue;

        const last = charges[charges.length - 1];
        const nextExpected = cadence.next(last.date);
        const typicalMilliunits = median(charges.map((charge) => charge.amountMilliunits));
        found.push({
          annualMilliunits: typicalMilliunits * cadence.perYear,
          row: {
            payee_name: last.payeeName.trim(),
            category_name: mostCommon(charges.map((charge) => charge.categoryName)),
            cadence: cadence.cadence,
            occurrences: charges.length,
            typical_amount: toDollars(typicalMilliunits, decimalDigits),
            latest_amount: last.amount,
            annual_cost: toDollars(typicalMilliunits * cadence.perYear, decimalDigits),
            first_date: charges[0].date,
            last_date: last.date,
            next_expected_date: nextExpected,
            // Overdue by more than half a cycle.
            possibly_lapsed: daysBetween(nextExpected, today) > (cadence.minDays + cadence.maxDays) / 4,
            already_scheduled: scheduledPayees.has(key),
          },
        });
      }
    }
    found.sort((a, b) => b.annualMilliunits - a.annualMilliunits);

    const activeAnnualMilliunits = found
      .filter((item) => !item.row.possibly_lapsed)
      .reduce((sum, item) => sum + item.annualMilliunits, 0);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          since_date: sinceDate,
          count: found.length,
          annual_cost_active: toDollars(activeAnnualMilliunits, decimalDigits),
          recurring: found.map((item) => item.row),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error detecting recurring transactions:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }
}
