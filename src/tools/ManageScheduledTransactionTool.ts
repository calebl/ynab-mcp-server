import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars, toMilliunits } from "./money.js";
import { resolveName } from "./match.js";
import { loadCategories } from "./splits.js";

const FREQUENCIES = [
  "never",
  "daily",
  "weekly",
  "everyOtherWeek",
  "twiceAMonth",
  "every4Weeks",
  "monthly",
  "everyOtherMonth",
  "every3Months",
  "every4Months",
  "twiceAYear",
  "yearly",
  "everyOtherYear",
] as const;

type Frequency = typeof FREQUENCIES[number];
type FlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "";

export const name = "ynab_manage_scheduled_transaction";
export const description = "Creates, updates or deletes a scheduled (recurring or future) transaction. action \"create\" needs date, amount and an account (accountId or accountName); a payee and category are optional. action \"update\" needs scheduledTransactionId and changes only the fields you give, e.g. accountName to move a subscription to the account it is really charged to. action \"delete\" needs scheduledTransactionId and cannot be undone. Account and category names are fuzzy-matched against the plan. YNAB only accepts a date in the future and no more than 5 years ahead, and does not support creating or editing split scheduled transactions. Use ynab_list_scheduled_transactions to find ids.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  action: z.enum(["create", "update", "delete"]).describe("What to do: create a new scheduled transaction, update one, or delete one"),
  scheduledTransactionId: z.string().optional().describe("The id of the scheduled transaction (required for update and delete)"),
  accountId: z.string().optional().describe("The id of the account (create needs this or accountName; update moves the scheduled transaction to this account)"),
  accountName: z.string().optional().describe("The name of the account, matched loosely against your open accounts (e.g. 'ally checking'). Ignored if accountId is provided."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("The next date of the scheduled transaction in ISO format (e.g. 2026-12-01). YNAB requires a future date no more than 5 years ahead. Required for create."),
  frequency: z.enum(FREQUENCIES).optional().describe("How often it repeats (create defaults to never, a one-off future transaction)"),
  amount: z.number().optional().describe("The amount in dollars (e.g. -14.95 for money spent, 14.95 for money received). Required for create."),
  payeeId: z.string().optional().describe("The id of the payee (use an account's transfer payee id for a transfer)"),
  payeeName: z.string().optional().describe("The name of the payee. YNAB uses an existing payee with this name or creates one. Ignored if payeeId is provided."),
  categoryId: z.string().optional().describe("The category id (credit card payment categories are not allowed)"),
  categoryName: z.string().optional().describe("The name of the category, matched loosely against your categories (e.g. 'subscriptions'). Ignored if categoryId is provided."),
  memo: z.string().optional().describe("A memo/note"),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple", ""]).optional().describe("The flag color, or an empty string to clear the flag"),
};

interface ManageScheduledTransactionInput {
  planId?: string;
  budgetId?: string;
  action: "create" | "update" | "delete";
  scheduledTransactionId?: string;
  accountId?: string;
  accountName?: string;
  date?: string;
  frequency?: Frequency;
  amount?: number;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  memo?: string;
  flagColor?: FlagColor;
}

const CHANGE_FIELDS = [
  "accountId", "accountName", "date", "frequency", "amount", "payeeId",
  "payeeName", "categoryId", "categoryName", "memo", "flagColor",
] as const;

/** Resolves accountName to an id, skipping the API call when an id (or neither) was given. */
async function resolveAccount(
  input: ManageScheduledTransactionInput,
  planId: string,
  api: ynab.API
): Promise<{ id?: string; matchedName?: string }> {
  if (input.accountId) return { id: input.accountId };
  if (!input.accountName) return {};

  const response = await api.accounts.getAccounts(planId);
  const open = response.data.accounts.filter((account) => !account.deleted && !account.closed);
  const match = resolveName(input.accountName, open, "account");
  return { id: match.id, matchedName: match.name };
}

/** Resolves categoryName to an id. A category is optional, so absence is fine. */
async function resolveCategory(
  input: ManageScheduledTransactionInput,
  planId: string,
  api: ynab.API
): Promise<{ id?: string; matchedName?: string }> {
  if (input.categoryId) return { id: input.categoryId };
  if (!input.categoryName) return {};

  const match = resolveName(input.categoryName, await loadCategories(planId, api), "category");
  return { id: match.id, matchedName: match.name };
}

function requireId(input: ManageScheduledTransactionInput): string {
  if (!input.scheduledTransactionId) {
    throw new Error(`scheduledTransactionId is required to ${input.action} a scheduled transaction`);
  }
  return input.scheduledTransactionId;
}

/** The fields given in the input, as YNAB save fields. Resolved ids override names. */
function givenFields(
  input: ManageScheduledTransactionInput,
  account: { id?: string },
  category: { id?: string }
): Partial<ynab.SaveScheduledTransaction> {
  const fields: Partial<ynab.SaveScheduledTransaction> = {};
  if (account.id !== undefined) fields.account_id = account.id;
  if (input.date !== undefined) fields.date = input.date;
  if (input.frequency !== undefined) fields.frequency = input.frequency;
  if (input.amount !== undefined) fields.amount = toMilliunits(input.amount);
  if (input.payeeId !== undefined) {
    fields.payee_id = input.payeeId;
    fields.payee_name = null;
  } else if (input.payeeName !== undefined) {
    // YNAB resolves payee_name only when payee_id is null.
    fields.payee_id = null;
    fields.payee_name = input.payeeName;
  }
  if (category.id !== undefined) fields.category_id = category.id;
  if (input.memo !== undefined) fields.memo = input.memo;
  if (input.flagColor !== undefined) {
    // YNAB clears a flag with null and rejects an empty string.
    fields.flag_color = input.flagColor === "" ? null : input.flagColor;
  }
  return fields;
}

/** YNAB's PUT replaces the whole scheduled transaction, so start from what it has now. */
function currentFields(existing: ynab.ScheduledTransactionDetail): ynab.SaveScheduledTransaction {
  return {
    account_id: existing.account_id,
    date: existing.date_next,
    amount: existing.amount,
    payee_id: existing.payee_id ?? null,
    ...(existing.payee_id ? {} : { payee_name: existing.payee_name ?? null }),
    category_id: existing.category_id ?? null,
    memo: existing.memo ?? null,
    flag_color: existing.flag_color ?? null,
    frequency: existing.frequency,
  };
}

function summarize(txn: ynab.ScheduledTransactionDetail, decimalDigits: number) {
  return {
    id: txn.id,
    date_first: txn.date_first,
    date_next: txn.date_next,
    frequency: txn.frequency,
    amount: toDollars(txn.amount, decimalDigits),
    account_name: txn.account_name,
    payee_name: txn.payee_name,
    category_name: txn.category_name,
    memo: txn.memo,
    flag_color: txn.flag_color,
  };
}

async function create(input: ManageScheduledTransactionInput, planId: string, api: ynab.API) {
  if (!input.accountId && !input.accountName) {
    throw new Error("Either accountId or accountName must be provided to create a scheduled transaction");
  }
  if (input.date === undefined) throw new Error("date is required to create a scheduled transaction");
  if (input.amount === undefined) throw new Error("amount is required to create a scheduled transaction");

  const account = await resolveAccount(input, planId, api);
  const category = await resolveCategory(input, planId, api);
  const fields = givenFields(input, account, category);

  const [response, decimalDigits] = await Promise.all([
    api.scheduledTransactions.createScheduledTransaction(planId, {
      scheduled_transaction: {
        ...fields,
        account_id: account.id!,
        date: input.date,
        frequency: input.frequency ?? "never",
      },
    }),
    getDecimalDigits(api, planId),
  ]);

  return {
    success: true,
    scheduledTransaction: summarize(response.data.scheduled_transaction, decimalDigits),
    matchedAccount: account.matchedName,
    matchedCategory: category.matchedName,
    message: "Scheduled transaction created successfully",
  };
}

async function update(input: ManageScheduledTransactionInput, planId: string, api: ynab.API) {
  const id = requireId(input);
  if (!CHANGE_FIELDS.some((field) => input[field] !== undefined)) {
    throw new Error("Provide at least one field to change");
  }

  const existing = (await api.scheduledTransactions.getScheduledTransactionById(planId, id)).data.scheduled_transaction;
  if (existing.subtransactions?.some((sub) => !sub.deleted)) {
    throw new Error("This scheduled transaction is split, and YNAB does not support editing split scheduled transactions through the API. Edit it in YNAB instead.");
  }

  const account = await resolveAccount(input, planId, api);
  const category = await resolveCategory(input, planId, api);

  const [response, decimalDigits] = await Promise.all([
    api.scheduledTransactions.updateScheduledTransaction(planId, id, {
      scheduled_transaction: { ...currentFields(existing), ...givenFields(input, account, category) },
    }),
    getDecimalDigits(api, planId),
  ]);

  return {
    success: true,
    scheduledTransaction: summarize(response.data.scheduled_transaction, decimalDigits),
    matchedAccount: account.matchedName,
    matchedCategory: category.matchedName,
    message: "Scheduled transaction updated successfully",
  };
}

async function remove(input: ManageScheduledTransactionInput, planId: string, api: ynab.API) {
  const id = requireId(input);
  const response = await api.scheduledTransactions.deleteScheduledTransaction(planId, id);
  return {
    success: true,
    scheduledTransactionId: response.data.scheduled_transaction.id,
    message: "Scheduled transaction deleted successfully",
  };
}

export async function execute(input: ManageScheduledTransactionInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    let result;
    switch (input.action) {
      case "create":
        result = await create(input, planId, api);
        break;
      case "update":
        result = await update(input, planId, api);
        break;
      case "delete":
        result = await remove(input, planId, api);
        break;
      default:
        throw new Error(`Unknown action "${String(input.action)}"; use create, update or delete`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    console.error("Error managing scheduled transaction:", error);
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
