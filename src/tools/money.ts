/**
 * YNAB stores every monetary value in "milliunits" - thousandths of the
 * budget's currency unit. Tools accept and return plain currency numbers, so
 * all conversion happens here rather than being open-coded per tool.
 */

/** Converts YNAB milliunits to a currency amount rounded to 2 decimal places. */
export function toDollars(milliunits: number): number {
  return Math.round(milliunits / 10) / 100;
}

/** Converts a currency amount to the milliunits the YNAB API expects. */
export function toMilliunits(amount: number): number {
  return Math.round(amount * 1000);
}
