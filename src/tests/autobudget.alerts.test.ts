import { describe, expect, it } from "vitest";

import {
  backlog,
  billsDue,
  buildDigest,
  combineAlerts,
  formatMoney,
  immediateAlerts,
  MAX_MESSAGE_LENGTH,
  paceAlerts,
  VARIABLE_CATEGORY_MIN_OUTFLOWS,
} from "../worker/autobudget/alerts.js";
import { planAssign, type Decision } from "../worker/autobudget/decisions.js";
import { toStoredAccount, toStoredTransaction } from "../worker/autobudget/sync.js";
import { account, category, month, scheduled, txn } from "./stubs/ynab-api.js";

const USD = { isoCode: "USD", decimalDigits: 2 };

describe("formatMoney", () => {
  it("formats milliunits in the plan currency", () => {
    expect(formatMoney(-12_340, USD)).toBe("-$12.34");
    expect(formatMoney(1_500, { isoCode: "KWD", decimalDigits: 3 })).toMatch(/1\.500/);
  });

  it("falls back to a plain number when the currency is unknown", () => {
    expect(formatMoney(2_500, { isoCode: null, decimalDigits: 2 })).toBe("2.50");
    expect(formatMoney(2_500, { isoCode: "NOT-A-CODE", decimalDigits: 2 })).toBe("2.50");
  });
});

describe("immediate alerts", () => {
  it("alerts once per month for overspent visible and hidden categories", () => {
    const over = category({ id: "c-dining", name: "Dining Out", balance: -15_000 });
    const hidden = category({ id: "c-hidden", name: "Old category", balance: -1_000, hidden: true });
    const quiet = [
      category({ balance: -1_000, internal: true }),
      category({ balance: -1_000, deleted: true }),
      category({ balance: 0 }),
    ];
    const alerts = immediateAlerts(month({ categories: [over, hidden, ...quiet] }), [], USD);
    expect(alerts).toEqual([
      expect.objectContaining({
        rule: "overspent",
        subjectId: "c-dining",
        period: "2026-10-01",
        title: "Dining Out is overspent",
        message: "Dining Out is $15.00 over for 2026-10.",
      }),
      expect.objectContaining({ rule: "overspent", subjectId: "c-hidden", title: "Old category is overspent" }),
    ]);
  });

  it("alerts when Ready to Assign goes negative", () => {
    const alerts = immediateAlerts(month({ to_be_budgeted: -40_000 }), [], USD);
    expect(alerts).toEqual([expect.objectContaining({ rule: "ready_to_assign_negative", period: "2026-10-01" })]);
    expect(alerts[0].message).toContain("-$40.00");
  });

  it("alerts on a broken bank import until it is fixed, but not for closed accounts", () => {
    const broken = toStoredAccount(account({ id: "a1", name: "Card", direct_import_in_error: true }));
    const closed = toStoredAccount(account({ id: "a2", direct_import_in_error: true, closed: true }));
    const alerts = immediateAlerts(month(), [broken, closed], USD);
    expect(alerts).toEqual([expect.objectContaining({ rule: "import_error", subjectId: "a1", period: "open" })]);
  });
});

describe("pace alerts", () => {
  const groceries = (activity: number, balance: number) =>
    category({ id: "c-groceries", name: "Groceries", activity, balance });
  const variable = new Map([["c-groceries", VARIABLE_CATEGORY_MIN_OUTFLOWS]]);

  it("flags day-to-day spending projected past what was available", () => {
    // $400 available at the start of the month, $300 spent by the 15th of 31 days.
    const items = paceAlerts(month({ categories: [groceries(-300_000, 100_000)] }), variable, "2026-10-15");
    expect(items).toEqual([{ categoryId: "c-groceries", name: "Groceries", spent: 300_000, available: 400_000, projected: 620_000 }]);
  });

  it("stays quiet in the first week, on pace, for bills, and once already overspent", () => {
    const fast = month({ categories: [groceries(-300_000, 100_000)] });
    expect(paceAlerts(fast, variable, "2026-10-06")).toEqual([]);
    expect(paceAlerts(fast, new Map([["c-groceries", VARIABLE_CATEGORY_MIN_OUTFLOWS - 1]]), "2026-10-15")).toEqual([]);
    expect(paceAlerts(month({ categories: [groceries(-150_000, 250_000)] }), variable, "2026-10-15")).toEqual([]);
    expect(paceAlerts(month({ categories: [groceries(-450_000, -50_000)] }), variable, "2026-10-15")).toEqual([]);
    expect(paceAlerts(month({ categories: [category({ ...groceries(-300_000, 100_000), hidden: true })] }), variable, "2026-10-15")).toEqual([]);
  });

  it("only judges the month it is in", () => {
    expect(paceAlerts(month({ categories: [groceries(-300_000, 100_000)] }), variable, "2026-11-15")).toEqual([]);
  });
});

describe("bills due", () => {
  const power = category({ id: "c-power", name: "Utilities", balance: 30_000 });

  it("lists bills due within three days whose category cannot cover them", () => {
    const bill = scheduled({ category_id: "c-power", date_next: "2026-10-20", amount: -80_000 });
    expect(billsDue([bill], month({ categories: [power] }), "2026-10-18")).toEqual([{
      scheduledId: bill.id,
      payee: "Power Company",
      category: "Utilities",
      due: "2026-10-20",
      amount: 80_000,
      available: 30_000,
    }]);
  });

  it("uses each category's balance cumulatively in due-date order", () => {
    const funded = category({ id: "c-power", name: "Utilities", balance: 100_000 });
    const first = scheduled({ id: "first", category_id: "c-power", date_next: "2026-10-19", amount: -80_000 });
    const second = scheduled({ id: "second", category_id: "c-power", date_next: "2026-10-20", amount: -80_000 });

    expect(billsDue([second, first], month({ categories: [funded] }), "2026-10-18")).toEqual([{
      scheduledId: "second",
      payee: "Power Company",
      category: "Utilities",
      due: "2026-10-20",
      amount: 80_000,
      available: 20_000,
    }]);
  });

  it("checks each scheduled split against its own visible category", () => {
    const split = scheduled({
      id: "split-parent",
      category_id: null,
      amount: -100_000,
      subtransactions: [
        { id: "power-part", transaction_id: "split-parent", amount: -80_000, category_id: "c-power", deleted: false },
        { id: "hidden-part", transaction_id: "split-parent", amount: -20_000, category_id: "c-hidden", deleted: false },
      ],
    });
    const hidden = category({ id: "c-hidden", balance: 0, hidden: true });

    expect(billsDue([split], month({ categories: [power, hidden] }), "2026-10-18")).toEqual([{
      scheduledId: "power-part",
      payee: "Power Company",
      category: "Utilities",
      due: "2026-10-20",
      amount: 80_000,
      available: 30_000,
    }]);
  });

  it("falls back to the parent after all former split rows are deleted", () => {
    const bill = scheduled({
      id: "former-split",
      category_id: "c-power",
      amount: -80_000,
      subtransactions: [{
        id: "deleted-part",
        transaction_id: "former-split",
        amount: -80_000,
        category_id: "c-power",
        deleted: true,
      }],
    });

    expect(billsDue([bill], month({ categories: [power] }), "2026-10-18")).toEqual([expect.objectContaining({
      scheduledId: "former-split",
      category: "Utilities",
      amount: 80_000,
    })]);
  });

  it("ignores covered, distant, past, next-month, transfer and inflow items", () => {
    const m = month({ categories: [power] });
    const ignored = [
      scheduled({ category_id: "c-power", amount: -20_000 }),
      scheduled({ category_id: "c-power", date_next: "2026-10-25" }),
      scheduled({ category_id: "c-power", date_next: "2026-10-10" }),
      scheduled({ category_id: "c-power", date_next: "2026-11-01" }),
      scheduled({ category_id: "c-power", transfer_account_id: "acc-savings" }),
      scheduled({ category_id: "c-power", amount: 80_000 }),
    ];
    expect(billsDue(ignored, m, "2026-10-30").concat(billsDue(ignored.slice(0, 3), m, "2026-10-18"))).toEqual([]);
  });
});

describe("backlog", () => {
  it("counts unapproved and uncategorized rows and the oldest date", () => {
    const pending = [
      txn({ date: "2026-10-09" }),
      txn({ date: "2026-09-28", approved: true }),
      txn({ date: "2026-10-01", category_id: "c-x" }),
      txn({ date: "2026-09-01", approved: true, category_id: null, transfer_account_id: "acc-savings" }),
    ].map(toStoredTransaction);
    expect(backlog(pending)).toEqual({ unapproved: 2, uncategorized: 2, oldest: "2026-09-28" });
  });
});

describe("digest", () => {
  const decisions: Decision[] = [
    { stage: "categorize", subjectId: "t1", action: "would_categorize", reason: null, source: "rule:payee_history", detail: {} },
    { stage: "approve", subjectId: "t1", action: "would_approve", reason: null, source: "rule:known_payee", detail: {} },
    { stage: "approve", subjectId: "t2", action: "review", reason: "new_payee", source: null, detail: {} },
  ];
  const assign = planAssign(month({ to_be_budgeted: 100_000, categories: [category({ goal_under_funded: 60_000 })] }),
    month({ month: "2026-11-01", categories: [category({ goal_under_funded: 25_000 })] }), 2);

  it("summarizes what the service would do, what is at risk, and what waits on the owner", () => {
    const digest = buildDigest({
      date: "2026-10-18",
      shadow: true,
      decisions,
      assign,
      pace: [{ categoryId: "c", name: "Groceries", spent: 300_000, available: 400_000, projected: 620_000 }],
      bills: [{ scheduledId: "s", payee: "Power Company", category: "Utilities", due: "2026-10-20", amount: 80_000, available: 30_000 }],
      backlog: { unapproved: 7, uncategorized: 3, oldest: "2026-10-02" },
      currency: USD,
    });
    expect(digest.title).toBe("Budget digest for 2026-10-18");
    expect(digest.message.split("\n")).toEqual([
      "Shadow mode: nothing was changed in YNAB.",
      "Would categorize 1, approve 1, assign $60.00 to 1 category, $25.00 to next month's targets.",
      "On pace to overspend: Groceries ($300.00 of $400.00, heading for $620.00).",
      "Bills due without enough set aside: Power Company on 2026-10-20 ($80.00 due, $30.00 in Utilities).",
      "Waiting on you: 7 unapproved, 3 uncategorized (oldest 2026-10-02).",
      "Ready to Assign: $100.00; $15.00 left after targets.",
    ]);
  });

  it("fits Pushover's message limit", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ categoryId: `c${i}`, name: `Category ${i}`, spent: 1, available: 1, projected: 2 }));
    const digest = buildDigest({ date: "2026-10-18", shadow: true, decisions: [], assign, pace: many, bills: [], backlog: { unapproved: 0, uncategorized: 0, oldest: null }, currency: USD });
    expect(digest.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(digest.message.endsWith("…")).toBe(true);
  });

  it("combines several immediate alerts into one notification", () => {
    const alerts = immediateAlerts(month({ to_be_budgeted: -1_000, categories: [category({ name: "A", balance: -1_000 })] }), [], USD);
    expect(combineAlerts(alerts)).toEqual({ title: "2 budget alerts", message: `${alerts[0].message}\n${alerts[1].message}` });
    expect(combineAlerts(alerts.slice(0, 1)).title).toBe("A is overspent");
  });
});
