import { z } from "zod";
import * as ynab from "ynab";
import { toDollars, toMilliunits } from "./money.js";
import { resolveName } from "./match.js";

/** One leg of a split transaction, in plain currency amounts. */
export interface SubtransactionData {
  amount: number;
  category_name?: string | null;
  payee_name?: string | null;
  memo?: string | null;
}

/**
 * Maps the legs of a split transaction for output.
 *
 * YNAB reports a split's parent row as the category "Split" and puts the real
 * categories on the subtransactions. Without them a split reads as though it
 * were uncategorized, so any tool that lists transactions has to carry them.
 *
 * Returns undefined for an ordinary transaction, so the field is simply absent
 * rather than an empty array.
 */
export function mapSubtransactions(
  subtransactions: ynab.SubTransaction[] | undefined,
): SubtransactionData[] | undefined {
  const active = (subtransactions ?? []).filter((sub) => !sub.deleted);
  if (active.length === 0) {
    return undefined;
  }

  return active.map((sub) => ({
    amount: toDollars(sub.amount),
    category_name: sub.category_name,
    payee_name: sub.payee_name,
    memo: sub.memo,
  }));
}

/** Input schema for writing a split, in the same shape mapSubtransactions reads. */
export const subtransactionsSchema = z.array(z.object({
  amount: z.number().describe("The split amount in dollars, signed like the transaction amount"),
  category_name: z.string().nullish().describe("The split's category name, matched loosely against your categories (optional)"),
  payee_name: z.string().nullish().describe("A payee for this split, if different from the transaction's (optional)"),
  memo: z.string().nullish().describe("A memo for this split (optional)"),
})).min(2);

/** Visible, non-deleted categories: the set that category names may match. */
export async function loadCategories(planId: string, api: ynab.API): Promise<ynab.Category[]> {
  const response = await api.categories.getCategories(planId);
  return response.data.category_groups
    .filter((group) => !group.deleted && !group.hidden)
    .flatMap((group) => group.categories)
    .filter((category) => !category.deleted && !category.hidden);
}

/**
 * Converts split input into what the API expects, resolving category names.
 * Throws before any write if the legs do not sum to the transaction amount.
 */
export async function buildSubtransactions(
  splits: SubtransactionData[],
  totalMilliunits: number,
  planId: string,
  api: ynab.API,
): Promise<{ subtransactions: ynab.SaveSubTransaction[]; matchedCategories: (string | undefined)[] }> {
  const amounts = splits.map((split) => toMilliunits(split.amount));
  const sum = amounts.reduce((total, amount) => total + amount, 0);
  if (sum !== totalMilliunits) {
    throw new Error(
      `Split amounts add up to ${toDollars(sum)} but the transaction amount is ${toDollars(totalMilliunits)}`
    );
  }

  const categories = splits.some((split) => split.category_name)
    ? await loadCategories(planId, api)
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
