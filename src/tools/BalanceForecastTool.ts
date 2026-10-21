import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";
import { addDays, addMonthsKeepingDay, dayOfMonth, isLastDayOfMonth, todayUtc } from "./dates.js";

export const name = "ynab_balance_forecast";
export const description = "Projects the combined balance of your accounts over the next N days (from today in UTC) from scheduled transactions only: the starting balance, the scheduled events, the end-of-day running balance and the lowest point. Income or spending that is not scheduled in YNAB is not in the forecast. Transfers between two included accounts (credit card payments too) net to zero; a transfer to an account outside the forecast counts as money leaving, and one from an account outside it as money arriving. Split schedules are counted leg by leg. Occurrences whose date has passed but that YNAB has not entered yet count on the first day, marked overdue with their scheduled_date and summarised in overdue_schedules. Where YNAB does not give the second date of a twice-a-month schedule, it is approximated as 15 days after the first. Events are capped by limit; the running balance, low point and ending balance always cover every day. For past income versus spending, use ynab_cash_flow; to list the schedules themselves, use ynab_list_scheduled_transactions.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  days: z.number().int().min(1).max(365).optional().describe("How many days ahead to project (default: 30, max: 365)"),
  accountIds: z.array(z.string()).min(1).optional().describe("Accounts to include (IDs from ynab_list_accounts). Defaults to every open on-budget account."),
  limit: z.number().int().min(0).max(1000).optional().describe("Maximum number of events to return, earliest first (default: 100; 0 leaves them out). event_count, the running balance, low point and ending balance always cover every event."),
};

interface BalanceForecastInput {
  planId?: string;
  budgetId?: string;
  days?: number;
  accountIds?: string[];
  limit?: number;
}

type Repeat = { unit: "days" | "months"; step: number };

// How each YNAB frequency repeats. "never" happens once, on date_next;
// twiceAMonth is two monthly series, see scheduleDates().
const REPEAT: Record<Exclude<ynab.ScheduledTransactionFrequency, "never" | "twiceAMonth">, Repeat> = {
  daily: { unit: "days", step: 1 },
  weekly: { unit: "days", step: 7 },
  everyOtherWeek: { unit: "days", step: 14 },
  every4Weeks: { unit: "days", step: 28 },
  monthly: { unit: "months", step: 1 },
  everyOtherMonth: { unit: "months", step: 2 },
  every3Months: { unit: "months", step: 3 },
  every4Months: { unit: "months", step: 4 },
  twiceAYear: { unit: "months", step: 6 },
  yearly: { unit: "months", step: 12 },
  everyOtherYear: { unit: "months", step: 24 },
};

function repeatOf(frequency: string): Repeat | undefined {
  return Object.hasOwn(REPEAT, frequency) ? REPEAT[frequency as keyof typeof REPEAT] : undefined;
}

function isSupported(frequency: string): boolean {
  return frequency === "never" || frequency === "twiceAMonth" || repeatOf(frequency) !== undefined;
}

/**
 * The dates on which a schedule whose next date is `first` falls, up to and
 * including `until`, for "never" and the frequencies with a fixed step.
 * Month-based schedules fall on `day` of the month (default: the day of
 * `first`), or the month's last day when it is shorter, and each date is
 * computed from `first` rather than from the previous date, so a monthly
 * schedule on the 31st comes back to the 31st after a short month.
 */
export function occurrences(first: string, frequency: string, until: string, day: number = dayOfMonth(first)): string[] {
  if (first > until) return [];
  if (frequency === "never") return [first];
  const repeat = repeatOf(frequency);
  if (!repeat) throw new Error(`Unknown scheduled transaction frequency: ${frequency}`);

  const dates: string[] = [];
  for (let k = 0; ; k++) {
    const date = repeat.unit === "days" ? addDays(first, k * repeat.step) : addMonthsKeepingDay(first, k * repeat.step, day);
    if (date > until) break;
    dates.push(date);
  }
  return dates;
}

/**
 * The day of the month a month-based schedule falls on. YNAB moves date_next
 * to a short month's last day (Feb 28 for a schedule on the 31st), so when
 * date_next is a month's last day and date_first has a later day, the
 * schedule's day is date_first's.
 */
export function scheduledDayOfMonth(dateFirst: string, dateNext: string): number {
  return isLastDayOfMonth(dateNext) && dayOfMonth(dateFirst) > dayOfMonth(dateNext) ? dayOfMonth(dateFirst) : dayOfMonth(dateNext);
}

export interface ScheduledDate {
  date: string;
  /** The date is a guess: the second date of a twiceAMonth pair that YNAB does not give. */
  approximate?: true;
}

/**
 * Every date a schedule falls on from date_next up to and including `until`.
 *
 * For twiceAMonth, date_first is the first date of a pair. When date_next is
 * on another day, it is the second of a pair, so both days are known. When it
 * is on date_first's day, the API does not give the second day, and it is
 * approximated as 15 days after the first.
 */
export function scheduleDates(dateFirst: string, dateNext: string, frequency: string, until: string): ScheduledDate[] {
  if (frequency !== "twiceAMonth") {
    return occurrences(dateNext, frequency, until, scheduledDayOfMonth(dateFirst, dateNext)).map((date) => ({ date }));
  }

  const firstDay = dayOfMonth(dateFirst);
  let dates: ScheduledDate[];
  if (addMonthsKeepingDay(dateNext, 0, firstDay) === dateNext) {
    dates = [
      ...occurrences(dateNext, "monthly", until, firstDay).map((date) => ({ date })),
      ...occurrences(addDays(dateNext, 15), "monthly", until).map((date) => ({ date, approximate: true as const })),
    ];
  } else {
    let nextFirst = addMonthsKeepingDay(dateNext, 0, firstDay);
    if (nextFirst <= dateNext) nextFirst = addMonthsKeepingDay(dateNext, 1, firstDay);
    dates = [
      ...occurrences(dateNext, "monthly", until).map((date) => ({ date })),
      ...occurrences(nextFirst, "monthly", until, firstDay).map((date) => ({ date })),
    ];
  }
  return dates.sort((a, b) => a.date.localeCompare(b.date));
}

interface ForecastEvent extends ScheduledDate {
  /** Set when the date the event was scheduled for has passed; `date` is then the forecast's first day. */
  overdue?: true;
  scheduled_date?: string;
  amountMilliunits: number;
  payee_name: string | null;
  category_name: string | null;
  account_name: string;
  scheduled_transaction_id: string;
}

/** One movement of money a scheduled transaction makes: the whole row, or one leg of a split. */
interface Flow {
  amount: number;
  transfer_account_id?: string | null;
  payee_name?: string | null;
  category_name?: string | null;
}

/**
 * A split's own amount is the sum of its legs, and each leg carries its own
 * category and, for a transfer leg, its own transfer_account_id. So a split is
 * counted through its legs, the way the spending reports count splits.
 */
function flowsOf(scheduled: ynab.ScheduledTransactionDetail): Flow[] {
  const legs = (scheduled.subtransactions ?? []).filter((leg) => !leg.deleted);
  if (legs.length === 0) return [scheduled];
  return legs.map((leg) => ({ ...leg, payee_name: leg.payee_name || scheduled.payee_name }));
}

function failure(error: string) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: false, error }, null, 2),
    }],
  };
}

export async function execute(input: BalanceForecastInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const fromDate = todayUtc();
    const untilDate = addDays(fromDate, input.days ?? 30);
    const limit = input.limit ?? 100;

    const [accountsResponse, scheduledResponse, decimalDigits] = await Promise.all([
      api.accounts.getAccounts(planId),
      api.scheduledTransactions.getScheduledTransactions(planId),
      getDecimalDigits(api, planId),
    ]);

    const accounts = accountsResponse.data.accounts.filter((account) => !account.deleted);
    const unknown = (input.accountIds ?? []).filter((id) => !accounts.some((account) => account.id === id));
    if (unknown.length > 0) return failure(`Unknown account id(s): ${unknown.join(", ")}`);

    const included = input.accountIds
      ? accounts.filter((account) => input.accountIds!.includes(account.id))
      : accounts.filter((account) => account.on_budget && !account.closed);
    const includedNames = new Map(included.map((account) => [account.id, account.name]));

    const events: ForecastEvent[] = [];
    const unsupported: Array<{ scheduled_transaction_id: string; frequency: string }> = [];
    const overdueSchedules: Array<{ scheduled_transaction_id: string; count: number; oldest_date: string }> = [];
    for (const scheduled of scheduledResponse.data.scheduled_transactions) {
      if (scheduled.deleted) continue;
      if (!isSupported(scheduled.frequency)) {
        unsupported.push({ scheduled_transaction_id: scheduled.id, frequency: scheduled.frequency });
        continue;
      }
      // date_next is the next date YNAB has not entered yet, so an occurrence
      // already past (today here is UTC, which can run a day ahead of the
      // user's date) is still to come: it is counted on the forecast's first
      // day, marked overdue with the date it was scheduled for.
      const allDates = scheduleDates(scheduled.date_first, scheduled.date_next, scheduled.frequency, untilDate);
      const overdueDates = allDates.filter((scheduledDate) => scheduledDate.date < fromDate);
      const dates: Array<ScheduledDate & { overdue?: true; scheduled_date?: string }> = allDates.map((scheduledDate) =>
        scheduledDate.date < fromDate
          ? { ...scheduledDate, date: fromDate, overdue: true, scheduled_date: scheduledDate.date }
          : scheduledDate
      );
      const fromIncluded = includedNames.has(scheduled.account_id);
      let counted = false;

      for (const flow of flowsOf(scheduled)) {
        const toIncluded = Boolean(flow.transfer_account_id) && includedNames.has(flow.transfer_account_id!);
        // A transfer between two included accounts moves nothing in or out of the total.
        if (fromIncluded === toIncluded) continue;
        counted = true;

        for (const scheduledDate of dates) {
          events.push({
            ...scheduledDate,
            amountMilliunits: fromIncluded ? flow.amount : -flow.amount,
            // On the receiving side, name the payee the way YNAB shows the transfer there.
            payee_name: fromIncluded ? flow.payee_name ?? null : `Transfer : ${scheduled.account_name}`,
            category_name: flow.category_name ?? null,
            account_name: fromIncluded ? scheduled.account_name : includedNames.get(flow.transfer_account_id!)!,
            scheduled_transaction_id: scheduled.id,
          });
        }
      }
      if (counted && overdueDates.length > 0) {
        overdueSchedules.push({
          scheduled_transaction_id: scheduled.id,
          count: overdueDates.length,
          oldest_date: overdueDates[0].date,
        });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.amountMilliunits - b.amountMilliunits);

    const startingMilliunits = included.reduce((sum, account) => sum + account.balance, 0);
    let balance = startingMilliunits;
    const running: Array<{ date: string; balance: number }> = [];
    for (const event of events) {
      balance += event.amountMilliunits;
      const last = running.at(-1);
      if (last?.date === event.date) last.balance = balance;
      else running.push({ date: event.date, balance });
    }
    // End-of-day balances, so the order of one day's events cannot fake a low.
    const low = running.reduce(
      (lowest, day) => (day.balance < lowest.balance ? day : lowest),
      { date: fromDate, balance: startingMilliunits },
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          from_date: fromDate,
          until_date: untilDate,
          accounts: included.map((account) => account.name),
          starting_balance: toDollars(startingMilliunits, decimalDigits),
          ending_balance: toDollars(balance, decimalDigits),
          low_point: { date: low.date, balance: toDollars(low.balance, decimalDigits) },
          event_count: events.length,
          events_truncated: events.length > limit,
          events: events.slice(0, limit).map(({ amountMilliunits, ...event }) => ({ ...event, amount: toDollars(amountMilliunits, decimalDigits) })),
          running_balance: running.map((day) => ({ date: day.date, balance: toDollars(day.balance, decimalDigits) })),
          ...(overdueSchedules.length > 0 ? { overdue_schedules: overdueSchedules } : {}),
          ...(unsupported.length > 0 ? { unsupported_schedules: unsupported } : {}),
          note: "Only scheduled transactions are projected. Income or spending that is not scheduled in YNAB is missing.",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error forecasting balances:", error);
    return failure(getErrorMessage(error));
  }
}
