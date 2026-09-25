import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";
import { resolveName } from "./match.js";
import type { SubtransactionData } from "./splits.js";

export const name = "ynab_create_transaction";
export const description = "Creates a new transaction in your YNAB plan. The account can be given as accountId or accountName, and the category as categoryId or categoryName - names are fuzzy-matched against the plan. Either payeeId or payeeName must also be provided. To split the transaction across categories, pass subtransactions instead of a category; their amounts must add up to the transaction amount.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  accountId: z.string().optional().describe("The id of the account to create the transaction in (optional if accountName is provided)"),
  accountName: z.string().optional().describe("The name of the account, matched loosely against your accounts (e.g. 'ally checking'). Optional if accountId is provided."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The date of the transaction in ISO format (e.g. 2024-03-24)"),
  amount: z.number().describe("The amount in dollars (e.g. -10.99 for money spent, 10.99 for money received)"),
  payeeId: z.string().optional().describe("The id of the payee (optional if payeeName is provided)"),
  payeeName: z.string().optional().describe("The name of the payee (optional if payeeId is provided). YNAB creates the payee if it does not exist."),
  categoryId: z.string().optional().describe("The category id for the transaction (optional)"),
  categoryName: z.string().optional().describe("The name of the category, matched loosely against your categories (e.g. 'groceries'). Optional; ignored if categoryId is provided."),
  memo: z.string().optional().describe("A memo/note for the transaction (optional)"),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional().describe("The cleared status of the transaction (optional, defaults to uncleared)"),
  approved: z.boolean().optional().describe("Whether the transaction is approved (optional, defaults to false)"),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple", ""]).optional().describe("The transaction flag color, or an empty string to clear the flag (optional)"),
  subtransactions: z.array(z.object({
    amount: z.number().describe("The split amount in dollars, signed like the transaction amount"),
    category_name: z.string().nullish().describe("The split's category name, matched loosely against your categories (optional)"),
    payee_name: z.string().nullish().describe("A payee for this split, if different from the transaction's (optional)"),
    memo: z.string().nullish().describe("A memo for this split (optional)"),
  })).min(2).optional().describe("Splits the transaction across categories, in the same shape ynab_get_transactions returns. Needs at least two entries whose amounts sum to amount; omit categoryId/categoryName when splitting."),
};

interface CreateTransactionInput {
  planId?: string;
  budgetId?: string;
  accountId?: string;
  accountName?: string;
  date: string;
  amount: number;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  memo?: string;
  cleared?: "cleared" | "uncleared" | "reconciled";
  approved?: boolean;
  flagColor?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "";
  subtransactions?: SubtransactionData[];
}

function mapClearedStatus(cleared?: string): ynab.TransactionClearedStatus {
  switch (cleared) {
    case "cleared":
      return ynab.TransactionClearedStatus.Cleared;
    case "reconciled":
      return ynab.TransactionClearedStatus.Reconciled;
    default:
      return ynab.TransactionClearedStatus.Uncleared;
  }
}


/** Resolves accountName to an id, skipping the API call when an id was given. */
async function resolveAccountId(
  input: CreateTransactionInput,
  budgetId: string,
  api: ynab.API
): Promise<{ id: string; matchedName?: string }> {
  if (input.accountId) return { id: input.accountId };
  if (!input.accountName) {
    throw new Error("Either accountId or accountName must be provided");
  }

  const response = await api.accounts.getAccounts(budgetId);
  const open = response.data.accounts.filter((account) => !account.deleted && !account.closed);
  const match = resolveName(input.accountName, open, "account");
  return { id: match.id, matchedName: match.name };
}

async function loadCategories(budgetId: string, api: ynab.API): Promise<ynab.Category[]> {
  const response = await api.categories.getCategories(budgetId);
  return response.data.category_groups
    .filter((group) => !group.deleted && !group.hidden)
    .flatMap((group) => group.categories)
    .filter((category) => !category.deleted && !category.hidden);
}

/** Resolves categoryName to an id. A category is optional, so absence is fine. */
async function resolveCategoryId(
  input: CreateTransactionInput,
  budgetId: string,
  api: ynab.API
): Promise<{ id?: string; matchedName?: string }> {
  if (input.categoryId) return { id: input.categoryId };
  if (!input.categoryName) return {};

  const match = resolveName(input.categoryName, await loadCategories(budgetId, api), "category");
  return { id: match.id, matchedName: match.name };
}

async function buildSubtransactions(
  splits: SubtransactionData[],
  totalMilliunits: number,
  budgetId: string,
  api: ynab.API
): Promise<{ subtransactions: ynab.SaveSubTransaction[]; matchedCategories: (string | undefined)[] }> {
  const amounts = splits.map((split) => toMilliunits(split.amount));
  const sum = amounts.reduce((total, amount) => total + amount, 0);
  if (sum !== totalMilliunits) {
    throw new Error(
      `Split amounts add up to ${toDollars(sum)} but the transaction amount is ${toDollars(totalMilliunits)}`
    );
  }

  const categories = splits.some((split) => split.category_name)
    ? await loadCategories(budgetId, api)
    : [];

  const matched = splits.map((split) =>
    split.category_name ? resolveName(split.category_name, categories, "category") : undefined
  );

  return {
    subtransactions: splits.map((split, i) => ({
      amount: amounts[i],
      category_id: matched[i]?.id,
      payee_name: split.payee_name ?? undefined,
      memo: split.memo ?? undefined,
    })),
    matchedCategories: matched.map((category) => category?.name),
  };
}

export async function execute(input: CreateTransactionInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    if (!input.payeeId && !input.payeeName) {
      throw new Error("Either payeeId or payeeName must be provided");
    }

    const isSplit = (input.subtransactions?.length ?? 0) > 0;
    if (isSplit && (input.categoryId || input.categoryName)) {
      throw new Error("Give categories on the subtransactions, not on a split transaction itself");
    }

    const account = await resolveAccountId(input, budgetId, api);
    const category = await resolveCategoryId(input, budgetId, api);

    const milliunitAmount = toMilliunits(input.amount);
    const split = isSplit
      ? await buildSubtransactions(input.subtransactions!, milliunitAmount, budgetId, api)
      : undefined;

    const transaction: ynab.PostTransactionsWrapper = {
      transaction: {
        account_id: account.id,
        date: input.date,
        amount: milliunitAmount,
        payee_id: input.payeeId,
        payee_name: input.payeeName,
        category_id: category.id,
        memo: input.memo,
        cleared: mapClearedStatus(input.cleared),
        approved: input.approved ?? false,
        flag_color: input.flagColor,
        ...(split && { subtransactions: split.subtransactions }),
      }
    };

    const response = await api.transactions.createTransaction(
      budgetId,
      transaction
    );

    if (!response.data.transaction) {
      throw new Error("Failed to create transaction - no transaction data returned");
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: true,
        transactionId: response.data.transaction.id,
        // Echo back what the names resolved to, so a wrong guess is visible.
        matchedAccount: account.matchedName,
        matchedCategory: category.matchedName,
        matchedSplitCategories: split?.matchedCategories,
        message: "Transaction created successfully",
      }, null, 2) }]
    };
  } catch (error) {
    console.error("Error creating transaction:", error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }, null, 2) }]
    };
  }
}
