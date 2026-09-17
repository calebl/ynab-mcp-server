import * as ynab from "ynab";
import { toDollars } from "./money.js";

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
