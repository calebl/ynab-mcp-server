import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { addDays, addMonthsKeepingDay, daysBetween, todayUtc } from "./dates.js";
import { collectSpending, daysAgo, type SpendingEntry } from "./spending.js";

export const name = "ynab_detect_recurring";
export const description = "Finds recurring outflows (subscriptions, bills, memberships) in transaction history by payee, similar amount and regular spacing, whether or not they are scheduled in YNAB. For the scheduled transactions set up in YNAB, use ynab_list_scheduled_transactions. Gives each one's cadence, typical amount, yearly cost at the latest amount, next expected date, whether it seems to have stopped, and already_scheduled (a scheduled transaction has the same payee name; amounts are not compared). This is a heuristic: check the results before acting on them. Splits are counted through their subtransactions. Transfers are excluded, so loan and mortgage payments (transfers to a loan account) and credit card payments are not reported. Inflows are excluded too, and refunds are not netted against charges. Reads the whole window from YNAB in one request, which is slow for a long sinceDate on a busy plan. Yearly charges need a sinceDate far enough back to show minOccurrences of them.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start of the history to scan, inclusive (ISO format: 2025-01-01). Defaults to 365 days ago."),
  minOccurrences: z.number().int().min(2).optional().describe("On how many different dates one payee must charge a similar amount to make a pattern (default: 3)"),
  amountTolerancePct: z.number().min(0).max(100)
    .refine((pct) => Number.isInteger(thousandths(pct)), "At most 3 decimal places")
    .optional()
    .describe("How far above the smallest charge in a group another charge may be and still count, in percent with up to 3 decimal places (default: 10)"),
};

/** `value` × 1000, shifted in decimal so 33.3 gives exactly 33300. */
function thousandths(value: number): number {
  return Number(`${value}e3`);
}

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

/** Share of the gaps between billing dates that must fit one cadence, once there are more than three. */
const REGULARITY = 0.6;

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
function amountGroups(entries: SpendingEntry[], tolerancePct: number): SpendingEntry[][] {
  // Whole numbers throughout, so a charge exactly at the tolerance stays in its group
  // (in floating point 100000 * 1.13 is 112999.99999999999).
  const toleranceThousandths = thousandths(tolerancePct);
  const groups: SpendingEntry[][] = [];
  for (const entry of [...entries].sort((a, b) => a.amountMilliunits - b.amountMilliunits)) {
    const current = groups.at(-1);
    const smallest = current?.[0].amountMilliunits ?? 0;
    if (current && (entry.amountMilliunits - smallest) * 100_000 <= smallest * toleranceThousandths) current.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

/** Charges from one amount group on one date, added together (two phone lines billed the same day). */
interface Billing {
  date: string;
  amountMilliunits: number;
}

/** `charges` must be sorted by date. */
function billingsOf(charges: SpendingEntry[]): Billing[] {
  const byDate = new Map<string, number>();
  for (const charge of charges) byDate.set(charge.date, (byDate.get(charge.date) ?? 0) + charge.amountMilliunits);
  return [...byDate].map(([date, amountMilliunits]) => ({ date, amountMilliunits }));
}

function cadenceOf(dates: string[]): Cadence | undefined {
  const gaps = dates.slice(1).map((date, i) => daysBetween(dates[i], date));
  // With three gaps or fewer every one must fit: two of three fitting is common for
  // purchases at a busy payee that merely happen to be similar in amount.
  const needed = Math.max(1, gaps.length <= 3 ? gaps.length : gaps.length * REGULARITY);
  return CADENCES.find((c) => gaps.filter((gap) => gap >= c.minDays && gap <= c.maxDays).length >= needed);
}

export async function execute(input: DetectRecurringInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const sinceDate = input.sinceDate || daysAgo(365);
    const minOccurrences = input.minOccurrences ?? 3;
    const tolerancePct = input.amountTolerancePct ?? 10;

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
      if (!entry.hasPayee) continue;
      const key = payeeKey(entry.payeeName);
      const entries = byPayee.get(key) ?? [];
      entries.push(entry);
      byPayee.set(key, entries);
    }

    const today = todayUtc();
    const found = [];
    for (const [key, entries] of byPayee) {
      for (const group of amountGroups(entries, tolerancePct)) {
        const charges = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const billings = billingsOf(charges);
        if (billings.length < minOccurrences) continue;
        const cadence = cadenceOf(billings.map((billing) => billing.date));
        if (!cadence) continue;

        const last = billings[billings.length - 1];
        const nextExpected = cadence.next(last.date);
        // The latest amount, so a price change shows in the yearly cost straight away.
        const annualMilliunits = last.amountMilliunits * cadence.perYear;
        found.push({
          annualMilliunits,
          row: {
            payee_name: charges[charges.length - 1].payeeName.trim(),
            category_name: mostCommon(charges.map((charge) => charge.categoryName)),
            cadence: cadence.cadence,
            occurrences: billings.length,
            charges: charges.length,
            typical_amount: toDollars(median(billings.map((billing) => billing.amountMilliunits)), decimalDigits),
            latest_amount: toDollars(last.amountMilliunits, decimalDigits),
            annual_cost: toDollars(annualMilliunits, decimalDigits),
            first_date: billings[0].date,
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
