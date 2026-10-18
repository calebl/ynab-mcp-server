import type * as ynab from "ynab";

import { planAssignments, type PlannedAssignment } from "../../tools/AutoAssignTool.js";
import { toDollars, toMilliunits } from "../../tools/money.js";
import { BALANCE_ADJUSTMENT_PAYEE_NAMES, type EligibleCategory } from "../../tools/SuggestCategoriesTool.js";
import { CAPS, MARKER_FLAG_COLOR } from "./config.js";
import type { PayeeHistory, StoredTransaction } from "./store.js";

/**
 * Pure decision logic. Every stage produces decisions; in shadow mode they
 * are only recorded, and a later write stage will act on exactly these.
 */

export type Stage = "categorize" | "approve" | "assign";

export type Action =
  | "would_categorize"
  | "would_approve"
  | "would_assign"
  | "would_fund_next_month"
  /** Left for the owner, with the reason in `reason`. */
  | "review";

export interface Decision {
  stage: Stage;
  /** Transaction id, or `<month>:<category id>` for assignments. */
  subjectId: string;
  action: Action;
  reason: string | null;
  source: string | null;
  detail: Record<string, unknown>;
}

/** The deterministic history rule needs at least this many same-payee rows, all in one category (as in ynab_suggest_categories). */
export const MIN_PAYEE_HISTORY = 3;
/** Approval needs the payee to have been approved at least this many times before. */
export const MIN_APPROVED_PAYEE_ROWS = 3;

export interface TransactionContext {
  pending: StoredTransaction[];
  history: Map<string, PayeeHistory>;
  possibleDuplicates: Set<string>;
  /** Categories a transaction may be put in. */
  eligibleCategories: Map<string, EligibleCategory>;
  /** Every category's name, for display. */
  categoryNames: Map<string, string>;
  offBudgetAccounts: Set<string>;
  decimalDigits: number;
}

function transactionDetail(txn: StoredTransaction, ctx: TransactionContext, categoryId: string | null) {
  return {
    date: txn.date,
    amount: toDollars(txn.amount, ctx.decimalDigits),
    payee: txn.payee_name,
    category_id: categoryId,
    category: categoryId ? ctx.categoryNames.get(categoryId) ?? null : null,
  };
}

/** Rows the categorize stage considers at all; everything else is left alone without comment. */
function isCategorizeCandidate(txn: StoredTransaction, ctx: TransactionContext): boolean {
  return !txn.approved &&
    !txn.category_id &&
    txn.amount < 0 &&
    !txn.transfer_account_id &&
    !txn.split &&
    txn.cleared !== "reconciled" &&
    !(txn.payee_name && BALANCE_ADJUSTMENT_PAYEE_NAMES.has(txn.payee_name)) &&
    !ctx.offBudgetAccounts.has(txn.account_id);
}

function categorizeDecision(txn: StoredTransaction, ctx: TransactionContext): Decision {
  const review = (reason: string, categoryId: string | null = null): Decision => ({
    stage: "categorize",
    subjectId: txn.id,
    action: "review",
    reason,
    source: categoryId ? "rule:payee_history" : null,
    detail: transactionDetail(txn, ctx, categoryId),
  });

  if (!txn.payee_id) return review("no_payee");
  const history = ctx.history.get(txn.payee_id);
  const counts = [...(history?.categories ?? new Map<string, number>()).entries()];
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  if (total < MIN_PAYEE_HISTORY) return review("insufficient_payee_history");
  if (counts.length > 1) return review("mixed_payee_history");

  const categoryId = counts[0][0];
  if (!ctx.eligibleCategories.has(categoryId)) return review("history_category_ineligible");
  if (Math.abs(txn.amount) > toMilliunits(CAPS.perTransaction)) return review("over_transaction_cap", categoryId);

  return {
    stage: "categorize",
    subjectId: txn.id,
    action: "would_categorize",
    reason: null,
    source: "rule:payee_history",
    detail: { ...transactionDetail(txn, ctx, categoryId), flag_color: MARKER_FLAG_COLOR },
  };
}

/** `categoryId` is the row's category after the categorize stage (its own, or the one it would get). */
function approveDecision(txn: StoredTransaction, categoryId: string | null, ctx: TransactionContext): Decision {
  const review = (reason: string): Decision => ({
    stage: "approve",
    subjectId: txn.id,
    action: "review",
    reason,
    source: null,
    detail: transactionDetail(txn, ctx, categoryId),
  });

  if (txn.transfer_account_id) return review("transfer");
  if (txn.split) return review("split");
  if (txn.cleared === "reconciled") return review("reconciled");
  if (txn.matched_transaction_id) return review("matched_pair");
  if (ctx.possibleDuplicates.has(txn.id)) return review("possible_duplicate");
  if (!categoryId) return review("uncategorized");
  if (Math.abs(txn.amount) > toMilliunits(CAPS.perTransaction)) return review("over_transaction_cap");
  const approvedBefore = txn.payee_id ? ctx.history.get(txn.payee_id)?.approved ?? 0 : 0;
  if (approvedBefore < MIN_APPROVED_PAYEE_ROWS) return review("new_payee");

  return {
    stage: "approve",
    subjectId: txn.id,
    action: "would_approve",
    reason: null,
    source: "rule:known_payee",
    detail: transactionDetail(txn, ctx, categoryId),
  };
}

/**
 * Categorize and approve decisions for every unapproved row, oldest first.
 * At most CAPS.rowsPerRun rows may change in one run; a row both categorized
 * and approved counts once, and rows past the cap go to review.
 */
export function transactionDecisions(ctx: TransactionContext): Decision[] {
  const decisions: Decision[] = [];
  const changed = new Set<string>();
  const withinRowCap = (id: string) => changed.has(id) || changed.size < CAPS.rowsPerRun;

  for (const txn of ctx.pending) {
    if (txn.approved) continue;

    let categoryId = txn.category_id;
    if (isCategorizeCandidate(txn, ctx)) {
      let decision = categorizeDecision(txn, ctx);
      if (decision.action === "would_categorize") {
        if (withinRowCap(txn.id)) {
          changed.add(txn.id);
          categoryId = decision.detail.category_id as string;
        } else {
          decision = { ...decision, action: "review", reason: "run_row_cap" };
        }
      }
      decisions.push(decision);
    }

    let approval = approveDecision(txn, categoryId, ctx);
    if (approval.action === "would_approve") {
      if (withinRowCap(txn.id)) changed.add(txn.id);
      else approval = { ...approval, action: "review", reason: "run_row_cap" };
    }
    decisions.push(approval);
  }
  return decisions;
}

/** Categories assignment may fund. Snoozed targets wait; internal categories never take money. */
export function assignableCategories(categories: ynab.Category[]): ynab.Category[] {
  return categories.filter((category) =>
    !category.deleted && !category.hidden && !category.internal && !category.goal_snoozed_at
  );
}

const totalUnderfunded = (categories: ynab.Category[]) =>
  categories.reduce((sum, category) => sum + Math.max(0, category.goal_under_funded ?? 0), 0);

/** The most one day may assign, in milliunits: min(Ready to Assign, total underfunded, the daily ceiling). */
export function assignCap(readyToAssign: number, underfunded: number): number {
  return Math.max(0, Math.min(readyToAssign, underfunded, toMilliunits(CAPS.dailyAssignCeiling)));
}

export interface AssignPlan {
  month: string;
  readyToAssign: number;
  cap: number;
  current: PlannedAssignment[];
  nextMonth: string | null;
  next: PlannedAssignment[];
  /** Ready to Assign left after everything planned. */
  remaining: number;
}

/**
 * Funds this month's targets, largest shortfall first, then spends what is
 * left on next month's targets. Pass `next` only once this month's plan
 * leaves money over.
 */
export function planAssign(current: ynab.MonthDetail, next: ynab.MonthDetail | null, decimalDigits: number): AssignPlan {
  const readyToAssign = current.to_be_budgeted;
  const thisMonth = assignableCategories(current.categories);
  const nextMonth = next ? assignableCategories(next.categories) : [];
  const cap = assignCap(readyToAssign, totalUnderfunded(thisMonth) + totalUnderfunded(nextMonth));

  const currentPlan = planAssignments(thisMonth, cap, decimalDigits).slice(0, CAPS.categoriesPerRun);
  const used = currentPlan.reduce((sum, item) => sum + item.assignMilliunits, 0);
  const nextPlan = next
    ? planAssignments(nextMonth, cap - used, decimalDigits).slice(0, CAPS.categoriesPerRun - currentPlan.length)
    : [];
  const planned = used + nextPlan.reduce((sum, item) => sum + item.assignMilliunits, 0);

  return {
    month: current.month,
    readyToAssign,
    cap,
    current: currentPlan,
    nextMonth: next?.month ?? null,
    next: nextPlan,
    remaining: readyToAssign - planned,
  };
}

/** True when this month's plan leaves Ready to Assign and category room for next month. */
export function hasSurplus(plan: AssignPlan): boolean {
  return plan.remaining > 0 && plan.current.length < CAPS.categoriesPerRun;
}

export function assignDecisions(plan: AssignPlan): Decision[] {
  const toDecision = (month: string, action: Action) => (item: PlannedAssignment): Decision => ({
    stage: "assign",
    subjectId: `${month}:${item.categoryId}`,
    action,
    reason: null,
    source: "targets",
    detail: {
      month,
      category_id: item.categoryId,
      category: item.name,
      assign: item.assign,
      current_budgeted: item.currentBudgeted,
      new_budgeted: item.newBudgeted,
      shortfall_remaining: item.shortfallRemaining,
    },
  });
  return [
    ...plan.current.map(toDecision(plan.month, "would_assign")),
    ...(plan.nextMonth ? plan.next.map(toDecision(plan.nextMonth, "would_fund_next_month")) : []),
  ];
}
