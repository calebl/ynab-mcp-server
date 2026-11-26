import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars, toMilliunits } from "./money.js";
import { mapSubtransactions } from "./splits.js";

const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", ""] as const;

export const name = "ynab_bulk_update_transactions";
export const description = "Updates up to 500 existing transactions in a single API call. Each update names a transactionId plus the fields to change (amount, memo, categoryId, payeeId, cleared, approved, flagColor); omitted or null fields are left unchanged. Changing the category of a split transaction is rejected (YNAB cannot do it); such items are reported as rejected and the rest are still updated. Reports which transactions YNAB saved.";

// Nested fields use .nullish() because the registry's null-stripping only
// reaches top-level inputs; null is treated as omitted.
const updateSchema = z.object({
  transactionId: z.string().min(1).describe("The ID of the transaction to update"),
  amount: z.number().nullish().describe("New amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  memo: z.string().nullish().describe("New memo; an empty string clears it"),
  categoryId: z.string().nullish().describe("New category ID. Not allowed on a split transaction."),
  payeeId: z.string().nullish().describe("New payee ID"),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).nullish().describe("New cleared status"),
  approved: z.boolean().nullish().describe("New approval state"),
  flagColor: z.enum(FLAG_COLORS).nullish().describe("New flag color, or an empty string to clear the flag"),
});

export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  updates: z.array(updateSchema).min(1).max(500).describe("The updates to apply, at most 500. Each must change at least one field; a transactionId may appear only once."),
};

interface TransactionUpdate {
  transactionId: string;
  amount?: number | null;
  memo?: string | null;
  categoryId?: string | null;
  payeeId?: string | null;
  cleared?: "cleared" | "uncleared" | "reconciled" | null;
  approved?: boolean | null;
  flagColor?: typeof FLAG_COLORS[number] | null;
}

interface BulkUpdateTransactionsInput {
  planId?: string;
  budgetId?: string;
  updates: TransactionUpdate[];
}

const isSet = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;

function buildItem(update: TransactionUpdate): ynab.SaveTransactionWithIdOrImportId {
  const item: ynab.SaveTransactionWithIdOrImportId = { id: update.transactionId };
  if (isSet(update.amount)) item.amount = toMilliunits(update.amount);
  if (isSet(update.memo)) item.memo = update.memo;
  if (isSet(update.categoryId)) item.category_id = update.categoryId;
  if (isSet(update.payeeId)) item.payee_id = update.payeeId;
  if (isSet(update.cleared)) item.cleared = update.cleared;
  if (isSet(update.approved)) item.approved = update.approved;
  // YNAB clears a flag with null and rejects an empty string.
  if (isSet(update.flagColor)) item.flag_color = update.flagColor === "" ? null : update.flagColor;

  if (Object.keys(item).length === 1) {
    throw new Error(`Update for transaction ${update.transactionId} has no fields to change`);
  }
  return item;
}

export async function execute(input: BulkUpdateTransactionsInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);

    if (!input.updates?.length) {
      throw new Error("No updates provided");
    }

    const seen = new Set<string>();
    for (const update of input.updates) {
      if (seen.has(update.transactionId)) {
        throw new Error(`Duplicate transactionId in updates: ${update.transactionId}`);
      }
      seen.add(update.transactionId);
    }

    const items = input.updates.map(buildItem);

    // One list read, only when some item sets a category, to refuse splits up front.
    const reasons = new Map<string, string>();
    if (input.updates.some((u) => isSet(u.categoryId))) {
      const listed = await api.transactions.getTransactions(planId);
      const rows = new Map((listed.data.transactions ?? []).map((t) => [t.id, t]));
      for (const u of input.updates) {
        if (!isSet(u.categoryId)) continue;
        const row = rows.get(u.transactionId);
        if (!row) {
          reasons.set(u.transactionId, `Transaction not found: ${u.transactionId}`);
        } else if (mapSubtransactions(row.subtransactions)) {
          reasons.set(u.transactionId, `Transaction ${u.transactionId} is split, and YNAB cannot change the category of a split transaction. Edit the split in the YNAB app, or delete and recreate it with the new categories.`);
        }
      }
    }

    const sendable = items.filter((item) => !reasons.has(item.id as string));
    const [response, decimalDigits] = sendable.length > 0
      ? await Promise.all([
          api.transactions.updateTransactions(planId, { transactions: sendable }),
          getDecimalDigits(api, planId),
        ])
      : [undefined, 0];

    const saved = new Set(response?.data.transaction_ids ?? []);
    const byId = new Map((response?.data.transactions ?? []).map((t) => [t.id, t]));

    const results = input.updates.map(({ transactionId }) => {
      const reason = reasons.get(transactionId);
      if (reason !== undefined) {
        return { transactionId, status: "rejected" as const, reason };
      }
      if (!saved.has(transactionId)) {
        return { transactionId, status: "not_updated" as const };
      }
      const t = byId.get(transactionId);
      return {
        transactionId,
        status: "updated" as const,
        ...(t && {
          transaction: {
            id: t.id,
            date: t.date,
            amount: toDollars(t.amount, decimalDigits),
            payee_name: t.payee_name,
            category_name: t.category_name,
            memo: t.memo,
            cleared: t.cleared,
            approved: t.approved,
            flag_color: t.flag_color,
          },
        }),
      };
    });

    const notUpdated = results.filter((r) => r.status === "not_updated").map((r) => r.transactionId);
    const rejected = results.flatMap((r) => (r.status === "rejected" ? [`${r.transactionId} (${r.reason})`] : []));
    const requested_count = results.length;
    const not_updated_count = notUpdated.length;
    const rejected_count = rejected.length;
    const updated_count = requested_count - not_updated_count - rejected_count;
    const errors = [
      not_updated_count > 0 && `${not_updated_count} transaction(s) were not updated: ${notUpdated.join(", ")}`,
      rejected_count > 0 && `${rejected_count} transaction(s) were rejected: ${rejected.join(", ")}`,
    ].filter(Boolean);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: errors.length === 0,
          requested_count,
          updated_count,
          not_updated_count,
          rejected_count,
          results,
          message: `Updated ${updated_count} of ${requested_count} transaction(s)`,
          ...(errors.length > 0 && { error: errors.join("; ") }),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error bulk updating transactions:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }
}
