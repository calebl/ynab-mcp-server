import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toMilliunits } from "./money.js";
import { FLAG_COLORS, FREQUENCIES } from "./CreateScheduledTransactionTool.js";
import { mapScheduledTransaction } from "./ListScheduledTransactionsTool.js";

export const name = "ynab_update_scheduled_transaction";
export const description = "Updates an existing scheduled transaction. All fields except scheduledTransactionId are optional - only provide fields you want to change; the rest keep their current values. Split scheduled transactions cannot be updated.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  scheduledTransactionId: z.string().describe("The ID of the scheduled transaction to update"),
  accountId: z.string().optional().describe("Move it to a different account"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("The next occurrence date in ISO format; must be in the future, at most 5 years ahead. Defaults to the current next date."),
  amount: z.number().optional().describe("The amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  frequency: z.enum(FREQUENCIES).optional().describe("How often it repeats; 'never' for a single future transaction"),
  payeeId: z.string().optional().describe("The ID of the payee"),
  payeeName: z.string().max(200).optional().describe("The payee name (matches or creates a payee); ignored when payeeId is given"),
  categoryId: z.string().optional().describe("The category ID"),
  memo: z.string().max(500).optional().describe("A memo/note; an empty string clears it"),
  flagColor: z.enum(FLAG_COLORS).optional().describe("The flag color, or an empty string to clear the flag"),
};

interface UpdateScheduledTransactionInput {
  planId?: string;
  budgetId?: string;
  scheduledTransactionId: string;
  accountId?: string;
  date?: string;
  amount?: number;
  frequency?: typeof FREQUENCIES[number];
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  flagColor?: typeof FLAG_COLORS[number];
}

export async function execute(input: UpdateScheduledTransactionInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const id = input.scheduledTransactionId;

    const changes = [
      input.accountId, input.date, input.amount, input.frequency, input.payeeId,
      input.payeeName, input.categoryId, input.memo, input.flagColor,
    ];
    if (changes.every((value) => value === undefined)) {
      throw new Error("No fields to update");
    }

    // YNAB's update is a PUT that replaces the row, so unchanged fields are
    // carried over from the current one.
    const existing = (await api.scheduledTransactions.getScheduledTransactionById(planId, id)).data.scheduled_transaction;
    if (!existing) {
      throw new Error(`Scheduled transaction not found: ${id}`);
    }
    if (existing.deleted) {
      throw new Error(`Scheduled transaction ${id} has been deleted`);
    }
    if ((existing.subtransactions ?? []).some((sub) => !sub.deleted)) {
      throw new Error("This scheduled transaction is split, and YNAB's API cannot update a split scheduled transaction without dropping its splits. Edit it in the YNAB app instead.");
    }

    const merged: ynab.SaveScheduledTransaction = {
      account_id: input.accountId ?? existing.account_id,
      date: input.date ?? existing.date_next,
      amount: input.amount !== undefined ? toMilliunits(input.amount) : existing.amount,
      frequency: input.frequency ?? (existing.frequency as ynab.ScheduledTransactionFrequency),
      category_id: input.categoryId ?? existing.category_id ?? null,
      memo: input.memo ?? existing.memo ?? null,
      flag_color: input.flagColor ?? existing.flag_color ?? null,
    };
    if (input.payeeId !== undefined) {
      merged.payee_id = input.payeeId;
    } else if (input.payeeName !== undefined) {
      merged.payee_id = null;
      merged.payee_name = input.payeeName;
    } else {
      merged.payee_id = existing.payee_id ?? null;
    }

    const response = await api.scheduledTransactions.updateScheduledTransaction(planId, id, {
      scheduled_transaction: merged,
    });

    if (!response.data.scheduled_transaction) {
      throw new Error("Failed to update scheduled transaction - no scheduled transaction data returned");
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          scheduled_transaction: mapScheduledTransaction(response.data.scheduled_transaction),
          message: "Scheduled transaction updated successfully",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error updating scheduled transaction:", error);
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
