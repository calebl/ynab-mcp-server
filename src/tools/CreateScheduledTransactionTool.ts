import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toMilliunits } from "./money.js";
import { mapScheduledTransaction } from "./ListScheduledTransactionsTool.js";

// String literals rather than the SDK's runtime enums; `satisfies` makes the
// typecheck fail if a value stops being an SDK enum member.
export const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", ""] as const satisfies readonly ynab.TransactionFlagColor[];
export const FREQUENCIES = [
  "never", "daily", "weekly", "everyOtherWeek", "twiceAMonth", "every4Weeks", "monthly",
  "everyOtherMonth", "every3Months", "every4Months", "twiceAYear", "yearly", "everyOtherYear",
] as const satisfies readonly ynab.ScheduledTransactionFrequency[];

export const name = "ynab_create_scheduled_transaction";
export const description = "Creates a scheduled (recurring or future one-off) transaction. The date must be in the future and no more than 5 years ahead. Split scheduled transactions are not supported by YNAB's API.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  accountId: z.string().describe("The ID of the account the scheduled transaction belongs to"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The first occurrence date in ISO format (e.g. 2026-11-01); YNAB requires a future date no more than 5 years ahead"),
  amount: z.number().describe("The amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  frequency: z.enum(FREQUENCIES).describe("How often it repeats; 'never' schedules a single future transaction"),
  payeeId: z.string().optional().describe("The ID of the payee (use an account's transfer_payee_id for a transfer)"),
  payeeName: z.string().max(200).optional().describe("The payee name, used when payeeId is not given (matches or creates a payee)"),
  categoryId: z.string().optional().describe("The category ID"),
  memo: z.string().max(500).optional().describe("A memo/note"),
  flagColor: z.enum(FLAG_COLORS).optional().describe("The flag color, or an empty string for no flag"),
};

interface CreateScheduledTransactionInput {
  planId?: string;
  budgetId?: string;
  accountId: string;
  date: string;
  amount: number;
  frequency: typeof FREQUENCIES[number];
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  flagColor?: typeof FLAG_COLORS[number];
}

export async function execute(input: CreateScheduledTransactionInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);

    const body: ynab.SaveScheduledTransaction = {
      account_id: input.accountId,
      date: input.date,
      amount: toMilliunits(input.amount),
      frequency: input.frequency,
    };
    if (input.payeeId !== undefined) body.payee_id = input.payeeId;
    if (input.payeeName !== undefined) body.payee_name = input.payeeName;
    if (input.categoryId !== undefined) body.category_id = input.categoryId;
    if (input.memo !== undefined) body.memo = input.memo;
    if (input.flagColor !== undefined) body.flag_color = input.flagColor;

    const response = await api.scheduledTransactions.createScheduledTransaction(planId, {
      scheduled_transaction: body,
    });

    if (!response.data.scheduled_transaction) {
      throw new Error("Failed to create scheduled transaction - no scheduled transaction data returned");
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          scheduled_transaction: mapScheduledTransaction(response.data.scheduled_transaction),
          message: "Scheduled transaction created successfully",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error creating scheduled transaction:", error);
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
