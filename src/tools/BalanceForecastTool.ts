import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_balance_forecast";
export const description = "Projects the combined balance of your accounts over the next N days from scheduled transactions only: the starting balance, each scheduled event, the end-of-day running balance and the lowest point. Income or spending that is not scheduled in YNAB is not in the forecast. Transfers between two included accounts (credit card payments too) net to zero; a transfer to an account outside the forecast counts as money leaving. Split schedules are counted leg by leg. Twice-a-month schedules are approximated as the next date and 15 days later. For past income versus spending, use ynab_cash_flow; to list the schedules themselves, use ynab_list_scheduled_transactions.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  days: z.number().int().min(1).max(365).optional().describe("How many days ahead to project (default: 30, max: 365)"),
  accountIds: z.array(z.string()).optional().describe("Accounts to include (IDs from ynab_list_accounts). Defaults to every open on-budget account."),
};

interface BalanceForecastInput {
  planId?: string;
  budgetId?: string;
  days?: number;
  accountIds?: string[];
}

type Repeat = { unit: "days" | "months"; step: number };

// How each YNAB frequency repeats. "never" happens once, on date_next.
const REPEAT: Record<Exclude<ynab.ScheduledTransactionFrequency, "never">, Repeat> = {
  daily: { unit: "days", step: 1 },
  weekly: { unit: "days", step: 7 },
  everyOtherWeek: { unit: "days", step: 14 },
  every4Weeks: { unit: "days", step: 28 },
  // The API does not say which two days of the month; see occurrences().
  twiceAMonth: { unit: "months", step: 1 },
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

/** Today's date in UTC, as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const dayOf = (date: string) => Number(date.slice(8, 10));

/**
 * `date` moved `months` calendar months, landing on `day` of the month where
 * the target month has it and on the month's last day where it does not
 * (Jan 31 + 1 month = Feb 28). `day` defaults to the day of `date`.
 */
export function addMonthsKeepingDay(date: string, months: number, day: number = dayOf(date)): string {
  const [year, month] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The day of the month a month-based schedule falls on. YNAB moves date_next
 * to a short month's last day (Feb 28 for a schedule on the 31st), so when
 * date_next is a month's last day and date_first has a later day, the
 * schedule's day is date_first's.
 */
export function scheduledDayOfMonth(dateFirst: string, dateNext: string): number {
  const isLastDayOfMonth = addDays(dateNext, 1).slice(8, 10) === "01";
  return isLastDayOfMonth && dayOf(dateFirst) > dayOf(dateNext) ? dayOf(dateFirst) : dayOf(dateNext);
}

/**
 * The dates on which a schedule whose next date is `first` falls, up to and
 * including `until`. Month-based schedules fall on `dayOfMonth` (default: the
 * day of `first`), or the month's last day when it is shorter, and each date
 * is computed from `first` rather than from the previous date, so a monthly
 * schedule on the 31st comes back to the 31st after a short month.
 *
 * YNAB does not say which two days a twiceAMonth schedule uses, so it is
 * approximated as `first` and 15 days later, each repeating monthly.
 */
export function occurrences(first: string, frequency: string, until: string, dayOfMonth: number = dayOf(first)): string[] {
  if (first > until) return [];
  if (frequency === "never") return [first];
  const repeat = repeatOf(frequency);
  if (!repeat) throw new Error(`Unknown scheduled transaction frequency: ${frequency}`);

  const dates: string[] = [];
  for (let k = 0; ; k++) {
    const date = repeat.unit === "days" ? addDays(first, k * repeat.step) : addMonthsKeepingDay(first, k * repeat.step, dayOfMonth);
    if (date > until) break;
    dates.push(date);
  }
  if (frequency === "twiceAMonth") {
    dates.push(...occurrences(addDays(first, 15), "monthly", until));
    dates.sort();
  }
  return dates;
}

interface ForecastEvent {
  date: string;
  amountMilliunits: number;
  payee_name: string | null;
  category_name: string | null;
  account_name: string;
  scheduled_transaction_id: string;
  approximate?: true;
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
    const fromDate = today();
    const untilDate = addDays(fromDate, input.days ?? 30);

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
    for (const scheduled of scheduledResponse.data.scheduled_transactions) {
      if (scheduled.deleted) continue;
      if (scheduled.frequency !== "never" && !repeatOf(scheduled.frequency)) {
        unsupported.push({ scheduled_transaction_id: scheduled.id, frequency: scheduled.frequency });
        continue;
      }
      // date_next is the next date YNAB has not entered yet, so an occurrence
      // already past (today here is UTC, which can run a day ahead of the
      // user's date) is still to come: it is counted on the forecast's first day.
      const dates = occurrences(
        scheduled.date_next,
        scheduled.frequency,
        untilDate,
        scheduledDayOfMonth(scheduled.date_first, scheduled.date_next),
      ).map((date) => (date < fromDate ? fromDate : date));
      const fromIncluded = includedNames.has(scheduled.account_id);

      for (const flow of flowsOf(scheduled)) {
        const toIncluded = Boolean(flow.transfer_account_id) && includedNames.has(flow.transfer_account_id!);
        // A transfer between two included accounts moves nothing in or out of the total.
        if (fromIncluded === toIncluded) continue;

        for (const date of dates) {
          events.push({
            date,
            amountMilliunits: fromIncluded ? flow.amount : -flow.amount,
            payee_name: flow.payee_name ?? null,
            category_name: flow.category_name ?? null,
            account_name: fromIncluded ? scheduled.account_name : includedNames.get(flow.transfer_account_id!)!,
            scheduled_transaction_id: scheduled.id,
            ...(scheduled.frequency === "twiceAMonth" ? { approximate: true as const } : {}),
          });
        }
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
          events: events.map(({ amountMilliunits, ...event }) => ({ ...event, amount: toDollars(amountMilliunits, decimalDigits) })),
          running_balance: running.map((day) => ({ date: day.date, balance: toDollars(day.balance, decimalDigits) })),
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
