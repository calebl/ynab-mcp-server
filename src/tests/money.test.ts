import { describe, it, expect, vi } from "vitest";
import * as ynab from "ynab";

import { formatAmount, getDecimalDigits, roundAmount, toDollars, toMilliunits } from "../tools/money.js";

function apiWithSettings(getPlanSettingsById: ReturnType<typeof vi.fn>): ynab.API {
  return { plans: { getPlanSettingsById } } as unknown as ynab.API;
}

function settings(decimalDigits: number) {
  return { data: { settings: { currency_format: { iso_code: "KWD", decimal_digits: decimalDigits } } } };
}

describe("toDollars", () => {
  it("rounds to 2 decimal places by default", () => {
    expect(toDollars(476080)).toBe(476.08);
    expect(toDollars(1234)).toBe(1.23);
    expect(toDollars(12345)).toBe(12.35);
    expect(toDollars(-350000)).toBe(-350);
  });

  it("keeps the third decimal for a 3-decimal currency", () => {
    expect(toDollars(1234, 3)).toBe(1.234);
    expect(toDollars(12345, 3)).toBe(12.345);
    expect(toDollars(-12345, 3)).toBe(-12.345);
  });

  it("rounds to whole units for a 0-decimal currency", () => {
    expect(toDollars(1500, 0)).toBe(2);
    expect(toDollars(-1500, 0)).toBe(-2);
    expect(toDollars(1499, 0)).toBe(1);
  });

  it("rounds half-unit amounts away from zero for inflows and outflows alike", () => {
    expect(toDollars(1005)).toBe(1.01);
    expect(toDollars(-1005)).toBe(-1.01);
    expect(toDollars(15)).toBe(0.02);
    expect(toDollars(-15)).toBe(-0.02);
  });

  it("does not report a negative zero for a tiny outflow", () => {
    expect(Object.is(toDollars(-4), 0)).toBe(true);
  });
});

describe("toMilliunits", () => {
  it("keeps all three decimals of an amount", () => {
    expect(toMilliunits(1.234)).toBe(1234);
    expect(toMilliunits(-12.345)).toBe(-12345);
    expect(toMilliunits(476.08)).toBe(476080);
  });

  it("round-trips a 3-decimal amount", () => {
    expect(toMilliunits(toDollars(1234, 3))).toBe(1234);
    expect(toMilliunits(toDollars(-12345, 3))).toBe(-12345);
  });

  it("rounds sub-milliunit input symmetrically", () => {
    expect(toMilliunits(1.0005)).toBe(1001);
    expect(toMilliunits(-1.0005)).toBe(-1001);
    expect(toMilliunits(0.5005)).toBe(501);
    expect(toMilliunits(-0.5005)).toBe(-501);
  });
});

describe("roundAmount", () => {
  it("rounds a total to the plan's decimal places, symmetrically", () => {
    expect(roundAmount(0.1 + 0.2)).toBe(0.3);
    expect(roundAmount(1.005, 2)).toBe(1.01);
    expect(roundAmount(-1.005, 2)).toBe(-1.01);
    expect(roundAmount(1.2344, 3)).toBe(1.234);
    expect(roundAmount(-2.5, 0)).toBe(-3);
    expect(roundAmount(2.5, 0)).toBe(3);
  });
});

describe("formatAmount", () => {
  it("shows exactly the plan's decimal places", () => {
    expect(formatAmount(12.3)).toBe("12.30");
    expect(formatAmount(1.234, 3)).toBe("1.234");
    expect(formatAmount(-12.345, 3)).toBe("-12.345");
  });
});

describe("getDecimalDigits", () => {
  it("reads decimal_digits from the plan's currency format", async () => {
    const lookup = vi.fn().mockResolvedValue(settings(3));
    expect(await getDecimalDigits(apiWithSettings(lookup), "plan-kwd")).toBe(3);
    expect(lookup).toHaveBeenCalledWith("plan-kwd");
  });

  it("falls back to 2 decimals when the settings cannot be read, and tries again next time", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce(settings(3));
    const api = apiWithSettings(lookup);

    expect(await getDecimalDigits(api, "plan-kwd")).toBe(2);
    expect(await getDecimalDigits(api, "plan-kwd")).toBe(3);
  });

  it("falls back to 2 decimals when the plan has no currency format", async () => {
    const lookup = vi.fn().mockResolvedValue({ data: { settings: {} } });
    expect(await getDecimalDigits(apiWithSettings(lookup), "plan-unknown")).toBe(2);
  });
});
