import * as ynab from "ynab";

/**
 * YNAB stores every monetary value in "milliunits" - thousandths of the
 * plan's currency unit. Tools accept and return plain currency numbers, so
 * all conversion happens here rather than being open-coded per tool.
 */

/** Decimal places used when a plan's currency format is unknown. */
export const DEFAULT_DECIMAL_DIGITS = 2;

/** Milliunits carry three decimals, so no currency can be more precise. */
const MAX_DECIMAL_DIGITS = 3;

function clampDigits(decimalDigits: number): number {
  return Math.min(Math.max(Math.trunc(decimalDigits), 0), MAX_DECIMAL_DIGITS);
}

/** Rounds half away from zero, so an outflow rounds like the matching inflow. */
function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.round(Math.abs(value));
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

/**
 * Converts YNAB milliunits to a currency amount rounded to the plan's decimal
 * places (2 unless told otherwise; 3 for currencies such as the Kuwaiti dinar).
 */
export function toDollars(milliunits: number, decimalDigits: number = DEFAULT_DECIMAL_DIGITS): number {
  const digits = clampDigits(decimalDigits);
  // Scaling the integer milliunits down (rather than dollars up) keeps half-unit values exact.
  return roundHalfAwayFromZero(milliunits / 10 ** (MAX_DECIMAL_DIGITS - digits)) / 10 ** digits;
}

/** Converts a currency amount to the milliunits the YNAB API expects. */
export function toMilliunits(amount: number): number {
  return roundHalfAwayFromZero(amount * 1000);
}

/** Rounds an already-converted currency amount, such as a total or average, to the plan's decimal places. */
export function roundAmount(amount: number, decimalDigits: number = DEFAULT_DECIMAL_DIGITS): number {
  const factor = 10 ** clampDigits(decimalDigits);
  return roundHalfAwayFromZero(amount * factor) / factor;
}

/** Formats a currency amount with exactly the plan's decimal places, for messages. */
export function formatAmount(amount: number, decimalDigits: number = DEFAULT_DECIMAL_DIGITS): string {
  return roundAmount(amount, decimalDigits).toFixed(clampDigits(decimalDigits));
}

const decimalDigitsCache = new WeakMap<ynab.API, Map<string, number>>();

/**
 * The number of decimal places in a plan's currency, from its settings.
 *
 * Fetched once per plan per API client, so a tool pays for at most one extra
 * request per plan. Falls back to 2 when the settings cannot be read, so a
 * failed lookup never fails the tool itself.
 */
export async function getDecimalDigits(api: ynab.API, planId: string): Promise<number> {
  let cache = decimalDigitsCache.get(api);
  const cached = cache?.get(planId);
  if (cached !== undefined) return cached;

  try {
    const response = await api.plans.getPlanSettingsById(planId);
    const digits = response.data.settings.currency_format?.decimal_digits;
    if (typeof digits !== "number" || !Number.isFinite(digits)) return DEFAULT_DECIMAL_DIGITS;

    // "last-used" can point at a different plan next time, so it is not cached.
    if (planId !== "last-used") {
      if (!cache) {
        cache = new Map();
        decimalDigitsCache.set(api, cache);
      }
      cache.set(planId, digits);
    }
    return digits;
  } catch {
    return DEFAULT_DECIMAL_DIGITS;
  }
}
