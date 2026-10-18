import { describe, expect, it } from "vitest";

import { CAPS, MARKER_FLAG_COLOR } from "../worker/autobudget/config.js";
import {
  assignCap,
  assignDecisions,
  hasSurplus,
  planAssign,
  transactionDecisions,
  type TransactionContext,
} from "../worker/autobudget/decisions.js";
import type { PayeeHistory, StoredTransaction } from "../worker/autobudget/store.js";
import { toStoredTransaction } from "../worker/autobudget/sync.js";
import { category, month, txn } from "./stubs/ynab-api.js";

const GROCERIES = "cat-groceries";
const DINING = "cat-dining";

function stored(overrides: Parameters<typeof txn>[0] = {}): StoredTransaction {
  return toStoredTransaction(txn(overrides));
}

function history(entries: Record<string, { categories?: Record<string, number>; approved?: number }>): Map<string, PayeeHistory> {
  return new Map(Object.entries(entries).map(([payee, entry]) => [payee, {
    categories: new Map(Object.entries(entry.categories ?? {})),
    approved: entry.approved ?? 0,
  }]));
}

function context(overrides: Partial<TransactionContext> = {}): TransactionContext {
  return {
    pending: [],
    history: history({ "p-coffee": { categories: { [DINING]: 5 }, approved: 5 } }),
    possibleDuplicates: new Set(),
    eligibleCategories: new Map([
      [GROCERIES, { id: GROCERIES, key: "c000", groupName: "Everyday", name: "Groceries" }],
      [DINING, { id: DINING, key: "c001", groupName: "Everyday", name: "Dining Out" }],
    ]),
    categoryNames: new Map([[GROCERIES, "Groceries"], [DINING, "Dining Out"]]),
    offBudgetAccounts: new Set(),
    decimalDigits: 2,
    ...overrides,
  };
}

const only = (ctx: TransactionContext, stage: string) => transactionDecisions(ctx).filter((d) => d.stage === stage);

describe("categorize decisions", () => {
  it("proposes the payee's unanimous category, with the marker flag a later write stage would set", () => {
    const row = stored({ amount: -12_340 });
    const [decision] = only(context({ pending: [row] }), "categorize");
    expect(decision).toMatchObject({
      subjectId: row.id,
      action: "would_categorize",
      source: "rule:payee_history",
      detail: { category_id: DINING, category: "Dining Out", amount: -12.34, flag_color: MARKER_FLAG_COLOR },
    });
  });

  it.each([
    ["no_payee", { payee_id: null }, {}],
    ["insufficient_payee_history", {}, { "p-coffee": { categories: { [DINING]: 2 } } }],
    ["mixed_payee_history", {}, { "p-coffee": { categories: { [DINING]: 4, [GROCERIES]: 1 } } }],
    ["history_category_ineligible", {}, { "p-coffee": { categories: { "cat-hidden": 6 } } }],
  ])("leaves the row for review: %s", (reason, row, entries) => {
    const ctx = context({ pending: [stored(row as Parameters<typeof txn>[0])], history: history(entries) });
    expect(only(ctx, "categorize")[0]).toMatchObject({ action: "review", reason });
  });

  it("sends a transaction over the per-transaction cap to review, keeping the proposed category", () => {
    const over = stored({ amount: -(CAPS.perTransaction * 1000 + 10) });
    const [decision] = only(context({ pending: [over] }), "categorize");
    expect(decision).toMatchObject({ action: "review", reason: "over_transaction_cap", detail: { category_id: DINING } });

    const atCap = stored({ amount: -CAPS.perTransaction * 1000 });
    expect(only(context({ pending: [atCap] }), "categorize")[0].action).toBe("would_categorize");
  });

  it.each([
    ["approved", { approved: true }],
    ["already categorized", { category_id: GROCERIES }],
    ["an inflow", { amount: 50_000 }],
    ["a transfer", { transfer_account_id: "acc-savings" }],
    ["reconciled", { cleared: "reconciled" }],
    ["a balance adjustment", { payee_name: "Reconciliation Balance Adjustment" }],
    ["a split", { subtransactions: [{ id: "sub", transaction_id: "x", amount: -1, deleted: false }] }],
  ])("does not categorize a row that is %s", (_label, row) => {
    const ctx = context({ pending: [stored(row as Parameters<typeof txn>[0])] });
    expect(only(ctx, "categorize")).toEqual([]);
  });

  it("does not categorize a row in an off-budget account", () => {
    const row = stored({ account_id: "acc-tracking" });
    expect(only(context({ pending: [row], offBudgetAccounts: new Set(["acc-tracking"]) }), "categorize")).toEqual([]);
  });
});

describe("approve decisions", () => {
  it("approves a known payee's categorized row, including one the categorize stage would fill in", () => {
    const owned = stored({ category_id: GROCERIES, payee_id: "p-coffee" });
    const filled = stored();
    const approvals = only(context({ pending: [owned, filled] }), "approve");
    expect(approvals.map((d) => [d.subjectId, d.action, d.detail.category_id])).toEqual([
      [owned.id, "would_approve", GROCERIES],
      [filled.id, "would_approve", DINING],
    ]);
  });

  it.each([
    ["transfer", { transfer_account_id: "acc-savings", category_id: null }],
    ["split", { subtransactions: [{ id: "sub", transaction_id: "x", amount: -1, deleted: false }] }],
    ["reconciled", { cleared: "reconciled", category_id: GROCERIES }],
    ["matched_pair", { matched_transaction_id: "t-other", category_id: GROCERIES }],
    ["uncategorized", { payee_id: "p-new" }],
    ["over_transaction_cap", { category_id: GROCERIES, amount: -400_000 }],
    ["new_payee", { category_id: GROCERIES, payee_id: "p-new" }],
  ])("leaves the row for review: %s", (reason, row) => {
    const ctx = context({ pending: [stored(row as Parameters<typeof txn>[0])] });
    expect(only(ctx, "approve")[0]).toMatchObject({ action: "review", reason });
  });

  it("holds back a possible duplicate", () => {
    const row = stored({ category_id: GROCERIES });
    const ctx = context({ pending: [row], possibleDuplicates: new Set([row.id]) });
    expect(only(ctx, "approve")[0]).toMatchObject({ action: "review", reason: "possible_duplicate" });
  });

  it("skips rows that are already approved", () => {
    expect(transactionDecisions(context({ pending: [stored({ approved: true, category_id: null })] }))).toEqual([]);
  });
});

describe("the per-run row cap", () => {
  it("changes at most CAPS.rowsPerRun rows, counting a categorized-and-approved row once", () => {
    const pending = Array.from({ length: CAPS.rowsPerRun + 5 }, () => stored());
    const decisions = transactionDecisions(context({ pending }));

    const changed = new Set(decisions.filter((d) => d.action.startsWith("would_")).map((d) => d.subjectId));
    expect(changed.size).toBe(CAPS.rowsPerRun);
    // Every row within the cap is both categorized and approved.
    expect(decisions.filter((d) => d.action === "would_categorize")).toHaveLength(CAPS.rowsPerRun);
    expect(decisions.filter((d) => d.action === "would_approve")).toHaveLength(CAPS.rowsPerRun);

    const overflow = pending.slice(CAPS.rowsPerRun).map((row) => row.id);
    for (const id of overflow) {
      expect(decisions.find((d) => d.subjectId === id && d.stage === "categorize")).toMatchObject({ action: "review", reason: "run_row_cap" });
      // Without the category it would have received, the approval waits too.
      expect(decisions.find((d) => d.subjectId === id && d.stage === "approve")).toMatchObject({ action: "review", reason: "uncategorized" });
    }
  });
});

describe("assign plan", () => {
  it("caps a day's assignment at min(Ready to Assign, total underfunded, the daily ceiling)", () => {
    expect(assignCap(300_000, 1_000_000)).toBe(300_000);
    expect(assignCap(1_000_000, 200_000)).toBe(200_000);
    expect(assignCap(9_000_000, 8_000_000)).toBe(CAPS.dailyAssignCeiling * 1000);
    expect(assignCap(-50_000, 100_000)).toBe(0);
  });

  it("funds the largest shortfall first and skips snoozed, internal, hidden and deleted categories", () => {
    const small = category({ name: "Small", goal_under_funded: 20_000 });
    const large = category({ name: "Large", goal_under_funded: 90_000 });
    const skipped = [
      category({ goal_under_funded: 500_000, goal_snoozed_at: "2026-10-01T00:00:00Z" }),
      category({ goal_under_funded: 500_000, internal: true }),
      category({ goal_under_funded: 500_000, hidden: true }),
      category({ goal_under_funded: 500_000, deleted: true }),
    ];
    const plan = planAssign(month({ to_be_budgeted: 100_000, categories: [small, ...skipped, large] }), null, 2);

    expect(plan.cap).toBe(100_000);
    expect(plan.current.map((item) => [item.name, item.assignMilliunits])).toEqual([["Large", 90_000], ["Small", 10_000]]);
    expect(plan.remaining).toBe(0);
    expect(hasSurplus(plan)).toBe(false);
  });

  it("never plans more than the daily ceiling", () => {
    const categories = [category({ goal_under_funded: 4_000_000 }), category({ goal_under_funded: 3_000_000 })];
    const plan = planAssign(month({ to_be_budgeted: 20_000_000, categories }), null, 2);
    const total = plan.current.reduce((sum, item) => sum + item.assignMilliunits, 0);
    expect(total).toBe(CAPS.dailyAssignCeiling * 1000);
  });

  it("assigns to at most CAPS.categoriesPerRun categories", () => {
    const categories = Array.from({ length: CAPS.categoriesPerRun + 4 }, () => category({ goal_under_funded: 10_000 }));
    const plan = planAssign(month({ to_be_budgeted: 1_000_000, categories }), null, 2);
    expect(plan.current).toHaveLength(CAPS.categoriesPerRun);
    expect(hasSurplus(plan)).toBe(false);
  });

  it("spends what is left after this month's targets on next month's", () => {
    const now = category({ id: "c-rent", name: "Rent", goal_under_funded: 50_000 });
    const current = month({ to_be_budgeted: 200_000, categories: [now] });
    expect(hasSurplus(planAssign(current, null, 2))).toBe(true);

    const next = month({ month: "2026-11-01", categories: [category({ id: "c-rent", name: "Rent", goal_under_funded: 120_000 })] });
    const plan = planAssign(current, next, 2);
    expect(plan.current.map((item) => item.assignMilliunits)).toEqual([50_000]);
    expect(plan.nextMonth).toBe("2026-11-01");
    expect(plan.next.map((item) => item.assignMilliunits)).toEqual([120_000]);
    expect(plan.remaining).toBe(30_000);

    expect(assignDecisions(plan).map((d) => [d.subjectId, d.action, d.detail.assign])).toEqual([
      ["2026-10-01:c-rent", "would_assign", 50],
      ["2026-11-01:c-rent", "would_fund_next_month", 120],
    ]);
  });

  it("plans nothing when Ready to Assign is not positive", () => {
    const plan = planAssign(month({ to_be_budgeted: 0, categories: [category({ goal_under_funded: 10_000 })] }), null, 2);
    expect(plan.current).toEqual([]);
    expect(assignDecisions(plan)).toEqual([]);
  });
});
