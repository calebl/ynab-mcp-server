import * as ynab from "ynab";

import { upsertEvent, parseServiceAccountKey, type CalendarEvent } from "./google-calendar.js";
import { buildSnark } from "./snark.js";
import type { WorkerEnv } from "./env.js";

export interface NagConfig {
  calendarId: string;
  timeZone: string;
  /** Earliest local hour the reminder may land on. */
  hourMin: number;
  /** Latest local hour the reminder may land on, inclusive. */
  hourMax: number;
}

export interface PendingWork {
  unapproved: number;
  uncategorized: number;
  total: number;
  /** Sum of the pending amounts, in plain currency. */
  amount: number;
  /** Pending items from earlier months, mentioned but not the headline. */
  backlog: number;
}

/** The date in a given IANA zone, as YYYY-MM-DD and the local hour. */
export function localDateParts(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // en-CA renders midnight as "24" in some runtimes; normalise it.
  const hour = Number(get("hour")) % 24;

  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour };
}

/**
 * Picks the hour for a given day, somewhere in the configured window.
 *
 * Derived from the date rather than Math.random so that all 24 hourly runs
 * agree on today's slot. A per-run random pick would fire on several hours
 * some days and none on others.
 */
export function pickHour(date: string, hourMin: number, hourMax: number): number {
  const span = Math.max(1, hourMax - hourMin + 1);

  let hash = 0x811c9dc5;
  for (let i = 0; i < date.length; i++) {
    hash ^= date.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  // FNV alone leaves neighbouring dates correlated: consecutive days landed on
  // consecutive hours, which is a pattern you would spot within a week. The
  // murmur3 finalizer avalanches those single-character differences.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;

  return hourMin + (hash % span);
}

/**
 * Builds the calendar event for a day's pending work, or null when there is
 * nothing to nag about.
 *
 * The id is derived from the date so that a re-run updates the same event
 * rather than stacking duplicates. Google only accepts base32hex characters in
 * an event id, so the prefix avoids letters past 'v'.
 */
export function buildNagEvent(
  pending: PendingWork,
  date: string,
  config: NagConfig,
  atHour: number,
): CalendarEvent | null {
  if (pending.total === 0) {
    return null;
  }

  const hour = String(atHour).padStart(2, "0");
  const money = Math.abs(pending.amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

  const detail: string[] = [];
  if (pending.unapproved > 0) detail.push(`${pending.unapproved} unapproved`);
  if (pending.uncategorized > 0) detail.push(`${pending.uncategorized} uncategorized`);

  const snark = buildSnark(date, pending.total, money, detail.join(", "), pending.backlog);

  return {
    id: `ncat${date.replace(/-/g, "")}`,
    summary: snark.summary,
    description: snark.description,
    start: `${date}T${hour}:00:00`,
    end: `${date}T${hour}:15:00`,
    timeZone: config.timeZone,
    reminderMinutes: 0,
  };
}

/**
 * The first of the month containing `date` (a local YYYY-MM-DD).
 *
 * The nag covers the current month rather than a rolling window, so the count
 * resets on the 1st and the month you are actually budgeting is the month you
 * are reminded about.
 */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Counts what is waiting for attention, split into this month (the headline)
 * and everything older (a footnote).
 */
export async function getPendingWork(
  api: ynab.API,
  budgetId: string,
  since: string,
): Promise<PendingWork> {
  const [unapprovedResponse, uncategorizedResponse] = await Promise.all([
    api.transactions.getTransactions(budgetId, undefined, ynab.GetTransactionsTypeEnum.Unapproved),
    api.transactions.getTransactions(budgetId, undefined, ynab.GetTransactionsTypeEnum.Uncategorized),
  ]);

  /**
   * Live, real transactions. Transfers between your own accounts show up as
   * uncategorized in YNAB but never need a category, and they dominate the
   * raw counts — 77 of 80 in the budget this was built against. Nagging about
   * them would be pure noise.
   */
  const live = (list: ynab.TransactionDetail[]) =>
    list.filter((t) => !t.deleted && !t.transfer_account_id);

  // A transaction can be both unapproved and uncategorized; count it once.
  const seen = new Map<string, ynab.TransactionDetail>();
  for (const txn of [...live(unapprovedResponse.data.transactions), ...live(uncategorizedResponse.data.transactions)]) {
    seen.set(txn.id, txn);
  }

  const recent = [...seen.values()].filter((t) => t.date >= since);
  const backlog = seen.size - recent.length;

  let milliunits = 0;
  for (const txn of recent) {
    milliunits += txn.amount;
  }

  const recentIds = new Set(recent.map((t) => t.id));
  return {
    unapproved: live(unapprovedResponse.data.transactions).filter((t) => recentIds.has(t.id)).length,
    uncategorized: live(uncategorizedResponse.data.transactions).filter((t) => recentIds.has(t.id)).length,
    total: recent.length,
    amount: milliunits / 1000,
    backlog,
  };
}

export type NagOutcome =
  | { ran: false; reason: string }
  | { ran: true; pending: PendingWork; result: "created" | "updated" | "nothing-to-do" };

/**
 * The scheduled job. Fires hourly and acts only in the configured local hour,
 * which keeps the reminder at the same wall-clock time across daylight saving
 * changes — Cloudflare cron expressions are always UTC.
 */
export async function runNag(env: WorkerEnv, now = new Date()): Promise<NagOutcome> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.NAG_CALENDAR_ID) {
    return { ran: false, reason: "calendar reminder not configured" };
  }

  const config: NagConfig = {
    calendarId: env.NAG_CALENDAR_ID,
    timeZone: env.NAG_TIMEZONE || "America/Los_Angeles",
    hourMin: Number(env.NAG_HOUR_MIN ?? "8"),
    hourMax: Number(env.NAG_HOUR_MAX ?? "20"),
  };

  const { date, hour } = localDateParts(now, config.timeZone);
  const target = pickHour(date, config.hourMin, config.hourMax);
  if (hour !== target) {
    return { ran: false, reason: `local hour ${hour}, today's slot is ${target}` };
  }

  const budgetId = env.YNAB_BUDGET_ID;
  if (!budgetId) {
    return { ran: false, reason: "YNAB_BUDGET_ID is not set" };
  }

  const api = new ynab.API(env.YNAB_API_TOKEN);
  const pending = await getPendingWork(api, budgetId, monthStart(date));

  const event = buildNagEvent(pending, date, config, target);
  if (!event) {
    return { ran: true, pending, result: "nothing-to-do" };
  }

  const result = await upsertEvent(
    parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    config.calendarId,
    event,
  );

  return { ran: true, pending, result };
}
