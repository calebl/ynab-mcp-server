import * as ynab from "ynab";

import { upsertEvent, parseServiceAccountKey, type CalendarEvent } from "./google-calendar.js";
import type { WorkerEnv } from "./env.js";

export interface NagConfig {
  calendarId: string;
  timeZone: string;
  /** Local hour (0-23) the reminder should land on. */
  hour: number;
  /**
   * Only nag about transactions this recent. An old backlog would otherwise
   * pin the count high forever, and a reminder that never changes is one you
   * stop seeing.
   */
  sinceDays: number;
}

export interface PendingWork {
  unapproved: number;
  uncategorized: number;
  total: number;
  /** Sum of the pending amounts, in plain currency. */
  amount: number;
  /** Pending items older than the nag window, reported but not nagged about. */
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
 * Builds the calendar event for a day's pending work, or null when there is
 * nothing to nag about.
 *
 * The id is derived from the date so that a re-run updates the same event
 * rather than stacking duplicates. Google only accepts base32hex characters in
 * an event id, so the prefix avoids letters past 'v'.
 */
export function buildNagEvent(pending: PendingWork, date: string, config: NagConfig): CalendarEvent | null {
  if (pending.total === 0) {
    return null;
  }

  const hour = String(config.hour).padStart(2, "0");
  const noun = pending.total === 1 ? "transaction" : "transactions";
  const money = Math.abs(pending.amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

  const detail: string[] = [];
  if (pending.unapproved > 0) detail.push(`${pending.unapproved} unapproved`);
  if (pending.uncategorized > 0) detail.push(`${pending.uncategorized} uncategorized`);

  const backlog = pending.backlog > 0
    ? `\n\nSeparately, ${pending.backlog} older ${pending.backlog === 1 ? "item" : "items"} predate this window.`
    : "";

  return {
    id: `ncat${date.replace(/-/g, "")}`,
    summary: `Categorize ${pending.total} YNAB ${noun} (${money})`,
    description: `${detail.join(", ")}.\n\nOpen YNAB and clear the inbox, or ask Claude to do it.${backlog}`,
    start: `${date}T${hour}:00:00`,
    end: `${date}T${hour}:15:00`,
    timeZone: config.timeZone,
    reminderMinutes: 0,
  };
}

/** The date `days` before `from`, as YYYY-MM-DD. */
export function sinceDate(from: Date, days: number): string {
  const cutoff = new Date(from.getTime() - days * 86_400_000);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Counts what is waiting for attention, split into the recent window the nag
 * is about and the older backlog it only mentions.
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

  const live = (list: ynab.TransactionDetail[]) => list.filter((t) => !t.deleted);

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
    hour: Number(env.NAG_HOUR ?? "18"),
    sinceDays: Number(env.NAG_SINCE_DAYS ?? "30"),
  };

  const { date, hour } = localDateParts(now, config.timeZone);
  if (hour !== config.hour) {
    return { ran: false, reason: `local hour ${hour}, waiting for ${config.hour}` };
  }

  const budgetId = env.YNAB_BUDGET_ID;
  if (!budgetId) {
    return { ran: false, reason: "YNAB_BUDGET_ID is not set" };
  }

  const api = new ynab.API(env.YNAB_API_TOKEN);
  const pending = await getPendingWork(api, budgetId, sinceDate(now, config.sinceDays));

  const event = buildNagEvent(pending, date, config);
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
