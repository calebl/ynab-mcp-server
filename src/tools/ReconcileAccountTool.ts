import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";

const ADJUSTMENT_PAYEE_NAME = "Reconciliation Balance Adjustment";
/** getTransactionsByAccount defaults since_date to one year ago; this reaches all history. */
const ALL_HISTORY_SINCE_DATE = "1970-01-01";

export const name = "ynab_reconcile_account";
export const description = "Reconciles an account against a bank statement balance. Defaults to a dry run that changes nothing: it reports the difference between the statement and YNAB's cleared balance and the cleared transactions that would be marked reconciled. With dryRun false and a matching balance it marks them reconciled. On a mismatch it changes nothing unless createAdjustment is true, in which case it first records one 'Reconciliation Balance Adjustment' transaction for the difference.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  accountId: z.string().describe("The ID of the account to reconcile (find it with ynab_list_accounts)"),
  statementBalance: z.number().describe("The ending balance on the bank statement in dollars, using YNAB's sign: money owed on a credit card or loan is negative (e.g. -523.10)"),
  dryRun: z.boolean().optional().describe("Preview without changing anything (default: true). Set to false to apply."),
  createAdjustment: z.boolean().optional().describe("If the statement and cleared balance differ, create one 'Reconciliation Balance Adjustment' transaction for the difference before reconciling (default: false). Without it a mismatch changes nothing."),
  adjustmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date for the adjustment transaction in ISO format (e.g. 2024-03-31). Defaults to today (UTC); must not be in the future."),
};

interface ReconcileAccountInput {
  planId?: string;
  budgetId?: string;
  accountId: string;
  statementBalance: number;
  dryRun?: boolean;
  createAdjustment?: boolean;
  adjustmentDate?: string;
}

function textResult(result: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

/** Formats milliunits as dollars with the sign kept, e.g. `$-0.01`. */
function fmt(milliunits: number): string {
  return `$${toDollars(milliunits).toFixed(2)}`;
}

function summarize(t: ynab.TransactionDetail) {
  return { id: t.id, date: t.date, amount: toDollars(t.amount), payee_name: t.payee_name ?? null, memo: t.memo ?? null };
}

function adjustmentSummary(adjustment: ynab.TransactionDetail) {
  return {
    id: adjustment.id,
    date: adjustment.date,
    amount: toDollars(adjustment.amount),
    payee_name: adjustment.payee_name ?? ADJUSTMENT_PAYEE_NAME,
  };
}

async function markReconciled(api: ynab.API, planId: string, ids: string[]) {
  const response = await api.transactions.updateTransactions(planId, {
    transactions: ids.map((id) => ({ id, cleared: ynab.TransactionClearedStatus.Reconciled })),
  });
  if (!response.data.transactions) throw new Error("Failed to reconcile transactions - no transaction data returned");
  return response.data.transactions;
}

export async function execute(input: ReconcileAccountInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const dryRun = input.dryRun ?? true;
    const today = new Date().toISOString().slice(0, 10);
    const adjustmentDate = input.adjustmentDate ?? today;

    const account = (await api.accounts.getAccountById(planId, input.accountId)).data.account;
    if (account.deleted) return toolError(`Account '${account.name}' is deleted.`);
    if (account.closed) return toolError(`Account '${account.name}' is closed. Reopen it in YNAB before reconciling.`);

    const transactions = (await api.transactions.getTransactionsByAccount(planId, input.accountId, ALL_HISTORY_SINCE_DATE)).data.transactions;
    const toReconcile = transactions.filter((t) => !t.deleted && t.cleared === ynab.TransactionClearedStatus.Cleared);

    const statementMilliunits = toMilliunits(input.statementBalance);
    const differenceMilliunits = statementMilliunits - account.cleared_balance;
    const adjustmentNeeded = differenceMilliunits !== 0;

    if (adjustmentNeeded && adjustmentDate > today) {
      return toolError(`adjustmentDate ${adjustmentDate} is after today (${today}); YNAB does not accept future-dated transactions.`);
    }

    const base = {
      account: { id: account.id, name: account.name, type: account.type },
      statement_balance: toDollars(statementMilliunits),
      cleared_balance: toDollars(account.cleared_balance),
      difference: toDollars(differenceMilliunits),
    };
    const n = toReconcile.length;

    if (dryRun) {
      return textResult({
        success: true,
        dry_run: true,
        ...base,
        adjustment_needed: adjustmentNeeded,
        adjustment: adjustmentNeeded
          ? { amount: toDollars(differenceMilliunits), date: adjustmentDate, payee_name: ADJUSTMENT_PAYEE_NAME }
          : null,
        transactions_to_reconcile: toReconcile.map(summarize),
        reconcile_count: n,
        message: adjustmentNeeded
          ? `Statement differs from the cleared balance by ${fmt(differenceMilliunits)}. Would create a ${fmt(differenceMilliunits)} adjustment dated ${adjustmentDate} and mark it and ${n} cleared transaction(s) reconciled. Fix any wrongly cleared transactions first, or call again with dryRun: false and createAdjustment: true to apply.`
          : `Statement matches the cleared balance. Would mark ${n} transaction(s) reconciled. Call again with dryRun: false to apply.`,
      });
    }

    if (!adjustmentNeeded) {
      if (n === 0) {
        return textResult({
          success: true,
          ...base,
          adjustment_transaction: null,
          reconciled_count: 0,
          reconciled_transaction_ids: [],
          message: "Cleared balance already matches the statement and there are no cleared transactions to reconcile.",
        });
      }
      const reconciled = await markReconciled(api, planId, toReconcile.map((t) => t.id));
      return textResult({
        success: true,
        ...base,
        adjustment_transaction: null,
        reconciled_count: reconciled.length,
        reconciled_transaction_ids: reconciled.map((t) => t.id),
        message: `Reconciled ${reconciled.length} transaction(s); the cleared balance matches the statement.`,
      });
    }

    if (input.createAdjustment !== true) {
      return textResult({
        success: false,
        ...base,
        error: `Statement balance differs from the cleared balance by ${fmt(differenceMilliunits)}. Nothing was changed. Review with dryRun, fix any wrongly cleared transactions, or call again with createAdjustment: true to record a balance adjustment.`,
      });
    }

    let adjustment: ynab.TransactionDetail;
    try {
      const created = await api.transactions.createTransaction(planId, {
        transaction: {
          account_id: input.accountId,
          date: adjustmentDate,
          amount: differenceMilliunits,
          payee_name: ADJUSTMENT_PAYEE_NAME,
          cleared: ynab.TransactionClearedStatus.Cleared,
          approved: true,
        },
      });
      if (!created.data.transaction) throw new Error("no transaction data returned");
      adjustment = created.data.transaction;
    } catch (error) {
      console.error("Error creating reconciliation adjustment:", error);
      return toolError(`Creating the adjustment transaction failed: ${getErrorMessage(error)}. Nothing was changed.`);
    }

    try {
      const reconciled = await markReconciled(api, planId, [...toReconcile.map((t) => t.id), adjustment.id]);
      return textResult({
        success: true,
        ...base,
        adjustment_transaction: adjustmentSummary(adjustment),
        reconciled_count: reconciled.length,
        reconciled_transaction_ids: reconciled.map((t) => t.id),
        message: `Created a ${fmt(differenceMilliunits)} adjustment and reconciled ${reconciled.length} transaction(s); the cleared balance matches the statement.`,
      });
    } catch (error) {
      console.error("Error reconciling transactions after adjustment:", error);
      return textResult({
        success: false,
        partial: true,
        ...base,
        error: getErrorMessage(error),
        adjustment_transaction: adjustmentSummary(adjustment),
        reconciled_count: 0,
        message: `Created adjustment ${adjustment.id} for ${fmt(differenceMilliunits)}, but marking transactions reconciled failed. Run again with the same statementBalance and dryRun: false; the difference is now 0, so it will only mark transactions reconciled.`,
      });
    }
  } catch (error) {
    console.error("Error reconciling account:", error);
    return toolError(getErrorMessage(error));
  }
}
