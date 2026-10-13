import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";
import { FLAG_COLORS } from "./CreateScheduledTransactionTool.js";

export const name = "ynab_bulk_update_transactions";
export const description = "Updates up to 500 existing transactions in a single API call. Each update names a transactionId plus the fields to change (amount, memo, categoryId, payeeId, cleared, approved, flagColor); omitted or null fields are left unchanged. Reports which transactions YNAB saved.";

// Nested fields use .nullish() because the registry's null-stripping only
// reaches top-level inputs; null is treated as omitted.
const updateSchema = z.object({
  transactionId: z.string().describe("The ID of the transaction to update"),
  amount: z.number().nullish().describe("New amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  memo: z.string().nullish().describe("New memo; an empty string clears it"),
  categoryId: z.string().nullish().describe("New category ID"),
  payeeId: z.string().nullish().describe("New payee ID"),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).nullish().describe("New cleared status"),
  approved: z.boolean().nullish().describe("New approval state"),
  flagColor: z.enum(FLAG_COLORS).nullish().describe("New flag color, or an empty string to clear the flag"),
});

export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  updates: z.array(updateSchema).min(1).max(500).describe("The updates to apply, at most 500 (the same cap as ynab_bulk_approve_transactions). Each must change at least one field; a transactionId may appear only once."),
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
  if (isSet(update.flagColor)) item.flag_color = update.flagColor;

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

    const transactions = input.updates.map(buildItem);

    const response = await api.transactions.updateTransactions(planId, { transactions });

    const saved = new Set(response.data.transaction_ids ?? []);
    const byId = new Map((response.data.transactions ?? []).map((t) => [t.id, t]));

    const results = input.updates.map(({ transactionId }) => {
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
            amount: toDollars(t.amount),
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
    const requested_count = results.length;
    const not_updated_count = notUpdated.length;
    const updated_count = requested_count - not_updated_count;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: not_updated_count === 0,
          requested_count,
          updated_count,
          not_updated_count,
          results,
          message: `Updated ${updated_count} of ${requested_count} transaction(s)`,
          ...(not_updated_count > 0 && {
            error: `${not_updated_count} transaction(s) were not updated: ${notUpdated.join(", ")}`,
          }),
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
