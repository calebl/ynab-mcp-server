import type * as ynab from "ynab";

import { DEFAULT_DECIMAL_DIGITS } from "../../tools/money.js";
import type { AssignPlan, Decision } from "./decisions.js";
import type { AlertKey, StoredAccount, StoredTransaction } from "./store.js";

/** Pace alerts start once a week of the month has passed. */
export const PACE_FROM_DAY = 7;
/** Alert when month-end spending is projected past this multiple of what was available. */
export const PACE_PROJECTION_RATIO = 1.1;
/** ...and at least this share of it is already spent. */
export const PACE_MIN_SPENT_RATIO = 0.5;
/** A category with at least this many purchases this month is day-to-day spending; fewer is a bill. */
export const VARIABLE_CATEGORY_MIN_OUTFLOWS = 4;
/** Bills due within this many days are checked against their category's balance. */
export const BILL_LOOKAHEAD_DAYS = 3;

export interface Currency {
  isoCode: string | null;
  decimalDigits: number;
}

/** Formats milliunits for a message in the plan's currency. */
export function formatMoney(milliunits: number, currency: Currency): string {
  const digits = Math.min(Math.max(currency.decimalDigits, 0), 3);
  const amount = milliunits / 1000;
  if (currency.isoCode) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.isoCode,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(amount);
    } catch {
      // Unknown ISO code; fall through to a plain number.
    }
  }
  return amount.toFixed(digits);
}

export const DEFAULT_CURRENCY: Currency = { isoCode: null, decimalDigits: DEFAULT_DECIMAL_DIGITS };

export interface ImmediateAlert extends AlertKey {
  title: string;
  message: string;
}

/** Categories a person budgets with: not deleted, hidden or internal. */
function visibleCategories(month: ynab.MonthDetail): ynab.Category[] {
  return month.categories.filter((category) => !category.deleted && !category.hidden && !category.internal);
}

/**
 * Alerts sent the moment they are noticed, once per period: overspending and
 * negative Ready to Assign once a month, a broken bank import once until it
 * is fixed.
 */
export function immediateAlerts(month: ynab.MonthDetail, accounts: StoredAccount[], currency: Currency): ImmediateAlert[] {
  const alerts: ImmediateAlert[] = [];

  for (const category of visibleCategories(month)) {
    if (category.balance < 0) {
      alerts.push({
        rule: "overspent",
        subjectId: category.id,
        period: month.month,
        title: `${category.name} is overspent`,
        message: `${category.name} is ${formatMoney(-category.balance, currency)} over for ${month.month.slice(0, 7)}.`,
      });
    }
  }

  if (month.to_be_budgeted < 0) {
    alerts.push({
      rule: "ready_to_assign_negative",
      subjectId: "ready_to_assign",
      period: month.month,
      title: "Ready to Assign is negative",
      message: `More is assigned than available: Ready to Assign is ${formatMoney(month.to_be_budgeted, currency)}.`,
    });
  }

  for (const account of accounts) {
    if (!account.closed && !account.deleted && account.direct_import_in_error) {
      alerts.push({
        rule: "import_error",
        subjectId: account.id,
        period: "open",
        title: `Bank import broken: ${account.name}`,
        message: `YNAB reports the direct import link for ${account.name} is in error. Reconnect it in YNAB.`,
      });
    }
  }

  return alerts;
}

export function planNotVisibleAlert(planId: string, message: string): ImmediateAlert {
  return { rule: "plan_not_visible", subjectId: planId, period: "open", title: "Auto-budget cannot see its plan", message };
}

export interface PaceItem {
  categoryId: string;
  name: string;
  spent: number;
  available: number;
  projected: number;
}

const daysInMonth = (month: string) => {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
};

/**
 * Day-to-day categories on track to overspend by month end. Bills are left
 * out: they spend their whole amount on one day, which would otherwise alert
 * on every bill. `today` is the local date, in the month being checked.
 */
export function paceAlerts(month: ynab.MonthDetail, outflowCounts: Map<string, number>, today: string): PaceItem[] {
  const day = Number(today.slice(8, 10));
  if (today.slice(0, 7) !== month.month.slice(0, 7) || day < PACE_FROM_DAY) return [];
  const days = daysInMonth(month.month);

  const items: PaceItem[] = [];
  for (const category of visibleCategories(month)) {
    if ((outflowCounts.get(category.id) ?? 0) < VARIABLE_CATEGORY_MIN_OUTFLOWS) continue;
    // Already overspent is an immediate alert, not a forecast.
    if (category.balance < 0) continue;
    const available = category.balance - category.activity;
    const spent = -category.activity;
    if (available <= 0 || spent <= 0) continue;
    const projected = Math.round((spent / day) * days);
    if (projected > PACE_PROJECTION_RATIO * available && spent > PACE_MIN_SPENT_RATIO * available) {
      items.push({ categoryId: category.id, name: category.name, spent, available, projected });
    }
  }
  return items.sort((a, b) => b.projected / b.available - a.projected / a.available);
}

export interface BillItem {
  scheduledId: string;
  payee: string | null;
  category: string;
  due: string;
  amount: number;
  available: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Scheduled outflows due within the lookahead, this month, whose category cannot cover them. */
export function billsDue(scheduled: ynab.ScheduledTransactionDetail[], month: ynab.MonthDetail, today: string): BillItem[] {
  const categories = new Map(visibleCategories(month).map((category) => [category.id, category]));
  const until = addDays(today, BILL_LOOKAHEAD_DAYS);

  const items: BillItem[] = [];
  for (const bill of scheduled) {
    if (bill.deleted || bill.amount >= 0 || bill.transfer_account_id || !bill.category_id) continue;
    if (bill.date_next < today || bill.date_next > until || bill.date_next.slice(0, 7) !== month.month.slice(0, 7)) continue;
    const category = categories.get(bill.category_id);
    if (!category || category.balance >= -bill.amount) continue;
    items.push({
      scheduledId: bill.id,
      payee: bill.payee_name ?? null,
      category: category.name,
      due: bill.date_next,
      amount: -bill.amount,
      available: category.balance,
    });
  }
  return items.sort((a, b) => a.due.localeCompare(b.due));
}

export interface Backlog {
  unapproved: number;
  uncategorized: number;
  oldest: string | null;
}

export function backlog(pending: StoredTransaction[]): Backlog {
  const uncategorized = (txn: StoredTransaction) => !txn.category_id && !txn.transfer_account_id && !txn.split;
  const waiting = pending.filter((txn) => !txn.approved || uncategorized(txn));
  return {
    unapproved: waiting.filter((txn) => !txn.approved).length,
    uncategorized: waiting.filter(uncategorized).length,
    oldest: waiting.map((txn) => txn.date).sort()[0] ?? null,
  };
}

export interface DigestInput {
  date: string;
  shadow: boolean;
  decisions: Decision[];
  assign: AssignPlan;
  pace: PaceItem[];
  bills: BillItem[];
  backlog: Backlog;
  currency: Currency;
}

/** Pushover caps a message at 1024 characters. */
export const MAX_MESSAGE_LENGTH = 1024;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildDigest(input: DigestInput): { title: string; message: string } {
  const money = (milliunits: number) => formatMoney(milliunits, input.currency);
  const count = (stage: string, action: string) =>
    input.decisions.filter((d) => d.stage === stage && d.action === action).length;
  const lines: string[] = [];

  if (input.shadow) lines.push("Shadow mode: nothing was changed in YNAB.");

  const assigned = input.assign.current.reduce((sum, item) => sum + item.assignMilliunits, 0);
  const forNext = input.assign.next.reduce((sum, item) => sum + item.assignMilliunits, 0);
  const plans = [
    `categorize ${count("categorize", "would_categorize")}`,
    `approve ${count("approve", "would_approve")}`,
    `assign ${money(assigned)} to ${input.assign.current.length} categor${input.assign.current.length === 1 ? "y" : "ies"}`,
  ];
  if (forNext > 0) plans.push(`${money(forNext)} to next month's targets`);
  lines.push(`Would ${plans.join(", ")}.`);

  if (input.pace.length) {
    lines.push(`On pace to overspend: ${input.pace.map((item) =>
      `${item.name} (${money(item.spent)} of ${money(item.available)}, heading for ${money(item.projected)})`
    ).join("; ")}.`);
  }

  if (input.bills.length) {
    lines.push(`Bills due without enough set aside: ${input.bills.map((bill) =>
      `${bill.payee ?? bill.category} on ${bill.due} (${money(bill.amount)} due, ${money(bill.available)} in ${bill.category})`
    ).join("; ")}.`);
  }

  const { unapproved, uncategorized, oldest } = input.backlog;
  if (unapproved || uncategorized) {
    lines.push(`Waiting on you: ${unapproved} unapproved, ${uncategorized} uncategorized${oldest ? ` (oldest ${oldest})` : ""}.`);
  }

  if (input.assign.readyToAssign !== 0) {
    lines.push(`Ready to Assign: ${money(input.assign.readyToAssign)}; ${money(input.assign.remaining)} left after targets.`);
  }

  return {
    title: `Budget digest for ${input.date}`,
    message: truncate(lines.join("\n"), MAX_MESSAGE_LENGTH),
  };
}

export function alertBatches(alerts: ImmediateAlert[]): ImmediateAlert[][] {
  const batches: ImmediateAlert[][] = [];
  let batch: ImmediateAlert[] = [];
  let messageLength = 0;

  for (const alert of alerts) {
    const addedLength = alert.message.length + (batch.length ? 1 : 0);
    if (batch.length && messageLength + addedLength > MAX_MESSAGE_LENGTH) {
      batches.push(batch);
      batch = [];
      messageLength = 0;
    }
    batch.push(alert);
    messageLength += alert.message.length + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Combines newly noticed immediate alerts into one notification. */
export function combineAlerts(alerts: ImmediateAlert[]): { title: string; message: string } {
  const title = alerts.length === 1 ? alerts[0].title : `${alerts.length} budget alerts`;
  return { title, message: truncate(alerts.map((alert) => alert.message).join("\n"), MAX_MESSAGE_LENGTH) };
}
