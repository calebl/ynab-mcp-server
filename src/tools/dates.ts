/**
 * Calendar arithmetic on the ISO dates (YYYY-MM-DD) YNAB uses, done in UTC so
 * the server's time zone never shifts a date.
 */

/** Today's date in UTC. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

export function isLastDayOfMonth(date: string): boolean {
  return dayOfMonth(addDays(date, 1)) === 1;
}

/**
 * `date` moved `months` calendar months, landing on `day` of the month where
 * the target month has it and on the month's last day where it does not
 * (Jan 31 + 1 month = Feb 28). `day` defaults to the day of `date`.
 */
export function addMonthsKeepingDay(date: string, months: number, day: number = dayOfMonth(date)): string {
  const [year, month] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
