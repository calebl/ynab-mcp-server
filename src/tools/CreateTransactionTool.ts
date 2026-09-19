import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toMilliunits } from "./money.js";
import { resolveName } from "./match.js";

export const name = "ynab_create_transaction";
export const description = "Creates a new transaction in your YNAB plan. The account can be given as accountId or accountName, and the category as categoryId or categoryName - names are fuzzy-matched against the plan. Either payeeId or payeeName must also be provided.";
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

/** Resolves categoryName to an id. A category is optional, so absence is fine. */
async function resolveCategoryId(
  input: CreateTransactionInput,
  budgetId: string,
  api: ynab.API
): Promise<{ id?: string; matchedName?: string }> {
  if (input.categoryId) return { id: input.categoryId };
  if (!input.categoryName) return {};

  const response = await api.categories.getCategories(budgetId);
  const categories = response.data.category_groups
    .filter((group) => !group.deleted && !group.hidden)
    .flatMap((group) => group.categories)
    .filter((category) => !category.deleted && !category.hidden);

  const match = resolveName(input.categoryName, categories, "category");
  return { id: match.id, matchedName: match.name };
}

export async function execute(input: CreateTransactionInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    if (!input.payeeId && !input.payeeName) {
      throw new Error("Either payeeId or payeeName must be provided");
    }

    const account = await resolveAccountId(input, budgetId, api);
    const category = await resolveCategoryId(input, budgetId, api);

    const milliunitAmount = toMilliunits(input.amount);

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
