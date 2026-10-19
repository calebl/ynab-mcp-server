import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars, toMilliunits } from "./money.js";
import { mapSubtransactions } from "./splits.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const name = "ynab_get_transactions";
export const description = "Gets transactions from a plan, optionally between a start and end date and by type (all, uncategorized or unapproved). Filter by at most one of account, category or payee: they cannot be combined, and if several are given only the first in that order is applied. To search, add payee or memo text, an amount range or a direction. Any search option (or untilDate) adds inflow, outflow and net totals over every match, and totalsOnly returns just the totals, e.g. a year of charitable giving. Split transactions are matched leg by leg, and the totals count only the matching legs.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  sinceDate: isoDate.optional().describe("Only return transactions on or after this date (ISO format: 2024-01-01)"),
  untilDate: isoDate.optional().describe("Only return transactions on or before this date (ISO format: 2024-12-31)"),
  type: z.enum(["all", "uncategorized", "unapproved"]).optional().describe("Filter by transaction type. Defaults to 'all'."),
  accountId: z.string().optional().describe("Filter to only transactions in this account"),
  categoryId: z.string().optional().describe("Filter to only transactions in this category"),
  payeeId: z.string().optional().describe("Filter to only transactions with this payee"),
  payeeContains: z.string().min(1).optional().describe("Only transactions whose payee name contains this text (case-insensitive)"),
  memoContains: z.string().min(1).optional().describe("Only transactions whose memo contains this text (case-insensitive)"),
  minAmount: z.number().nonnegative().optional().describe("Smallest amount to include, ignoring sign, in currency units (e.g. 25.50)"),
  maxAmount: z.number().nonnegative().optional().describe("Largest amount to include, ignoring sign, in currency units"),
  direction: z.enum(["outflow", "inflow", "any"]).optional().describe("Only money going out, coming in, or both. Defaults to 'any'."),
  totalsOnly: z.boolean().optional().describe("Return only the totals, without transaction rows (default: false)"),
  limit: z.number().int().positive().max(1000).optional().describe("Maximum number of transactions to return (default: 100). Totals always cover every match."),
};

interface GetTransactionsInput {
  planId?: string;
  budgetId?: string;
  sinceDate?: string;
  untilDate?: string;
  type?: "all" | "uncategorized" | "unapproved";
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  payeeContains?: string;
  memoContains?: string;
  minAmount?: number;
  maxAmount?: number;
  direction?: "outflow" | "inflow" | "any";
  totalsOnly?: boolean;
  limit?: number;
}


function mapTransactionType(type?: string): ynab.GetTransactionsTypeEnum | undefined {
  switch (type) {
    case "uncategorized":
      return ynab.GetTransactionsTypeEnum.Uncategorized;
    case "unapproved":
      return ynab.GetTransactionsTypeEnum.Unapproved;
    default:
      return undefined;
  }
}

interface TransactionData {
  id: string;
  date: string;
  amount: number;
  memo?: string | null;
  approved: boolean;
  cleared: string;
  account_name?: string | null;
  payee_name?: string | null;
  category_name?: string | null;
  flag_color?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  matched_transaction_id?: string | null;
  import_id?: string | null;
  subtransactions?: ynab.SubTransaction[];
  /** Set on the hybrid rows that the category and payee listings return. */
  type?: string;
  parent_transaction_id?: string | null;
  deleted: boolean;
}

/** The part of a transaction the search filters look at: a whole transaction, or one leg of a split. */
interface Leg {
  amount: number;
  payee_name?: string | null;
  memo?: string | null;
}

interface SearchFilters {
  untilDate?: string;
  payeeContains?: string;
  memoContains?: string;
  minMilliunits?: number;
  maxMilliunits?: number;
  direction: "outflow" | "inflow" | "any";
}

/** Search options; giving any of them adds the totals block. */
const SEARCH_OPTIONS = ["untilDate", "payeeContains", "memoContains", "minAmount", "maxAmount", "direction", "totalsOnly"] as const;

function contains(text: string | null | undefined, needle: string | undefined): boolean {
  return needle === undefined || (text ?? "").toLowerCase().includes(needle.toLowerCase());
}

function legMatches(leg: Leg, filters: SearchFilters): boolean {
  const size = Math.abs(leg.amount);
  if (filters.direction === "outflow" && leg.amount >= 0) return false;
  if (filters.direction === "inflow" && leg.amount <= 0) return false;
  if (filters.minMilliunits !== undefined && size < filters.minMilliunits) return false;
  if (filters.maxMilliunits !== undefined && size > filters.maxMilliunits) return false;
  return contains(leg.payee_name, filters.payeeContains) && contains(leg.memo, filters.memoContains);
}

/**
 * The amounts, in milliunits, of the legs of one transaction that match.
 *
 * A split's own amount duplicates its children, so a split is matched through
 * its children, each taking the parent's payee and memo when it has none of
 * its own. The category and payee listings instead return a split's legs as
 * rows of their own (type "subtransaction", without children), so each such
 * row is matched as the single leg it is.
 */
function matchingLegAmounts(txn: TransactionData, filters: SearchFilters): number[] {
  if (filters.untilDate && txn.date > filters.untilDate) return [];
  const subtransactions = (txn.subtransactions ?? []).filter((sub) => !sub.deleted);
  const legs: Leg[] = subtransactions.length === 0
    ? [txn]
    : subtransactions.map((sub) => ({
      amount: sub.amount,
      payee_name: sub.payee_name || txn.payee_name,
      memo: sub.memo || txn.memo,
    }));
  return legs.filter((leg) => legMatches(leg, filters)).map((leg) => leg.amount);
}

export async function execute(input: GetTransactionsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const limit = input.limit || 100;
    if (input.minAmount !== undefined && input.maxAmount !== undefined && input.minAmount > input.maxAmount) {
      throw new Error("minAmount is larger than maxAmount");
    }
    if (input.sinceDate && input.untilDate && input.sinceDate > input.untilDate) {
      throw new Error("sinceDate is after untilDate");
    }

    const decimalDigitsLookup = getDecimalDigits(api, budgetId);
    let rawTransactions: TransactionData[];

    // Use the appropriate API method based on filters
    if (input.accountId) {
      const response = await api.transactions.getTransactionsByAccount(
        budgetId,
        input.accountId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByAccountTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.categoryId) {
      const response = await api.transactions.getTransactionsByCategory(
        budgetId,
        input.categoryId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByCategoryTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else if (input.payeeId) {
      const response = await api.transactions.getTransactionsByPayee(
        budgetId,
        input.payeeId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type) as ynab.GetTransactionsByPayeeTypeEnum
      );
      rawTransactions = response.data.transactions;
    } else {
      const response = await api.transactions.getTransactions(
        budgetId,
        input.sinceDate,
        input.untilDate,
        mapTransactionType(input.type)
      );
      rawTransactions = response.data.transactions;
    }

    const decimalDigits = await decimalDigitsLookup;

    let matches = rawTransactions.filter((txn) => !txn.deleted);
    let totals: { count: number; inflow: number; outflow: number; net: number } | undefined;

    if (SEARCH_OPTIONS.some((option) => input[option] !== undefined)) {
      const filters: SearchFilters = {
        // The API applies untilDate too; checking it here keeps the range exact if it does not.
        untilDate: input.untilDate,
        payeeContains: input.payeeContains,
        memoContains: input.memoContains,
        minMilliunits: input.minAmount === undefined ? undefined : toMilliunits(input.minAmount),
        maxMilliunits: input.maxAmount === undefined ? undefined : toMilliunits(input.maxAmount),
        direction: input.direction ?? "any",
      };
      const matched = matches
        .map((txn) => ({ txn, amounts: matchingLegAmounts(txn, filters) }))
        .filter(({ amounts }) => amounts.length > 0);
      // The payee listing returns a split's parent row and also, as rows of their own, any of
      // its legs that carry a payee. The parent's amount already includes those legs.
      const matchedIds = new Set(matched.map(({ txn }) => txn.id));
      const counted = matched.filter(({ txn }) =>
        !(txn.type === "subtransaction" && txn.parent_transaction_id && matchedIds.has(txn.parent_transaction_id))
      );
      let inflow = 0;
      let outflow = 0;
      for (const { amounts } of counted) {
        for (const amount of amounts) {
          if (amount > 0) inflow += amount;
          else outflow -= amount;
        }
      }
      matches = counted.map(({ txn }) => txn);
      totals = {
        count: matches.length,
        inflow: toDollars(inflow, decimalDigits),
        outflow: toDollars(outflow, decimalDigits),
        net: toDollars(inflow - outflow, decimalDigits),
      };
    }

    if (input.totalsOnly) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ totals }, null, 2),
        }],
      };
    }

    // Apply limit
    const transactions = matches
      .slice(0, limit)
      .map((txn) => ({
        id: txn.id,
        date: txn.date,
        amount: toDollars(txn.amount, decimalDigits),
        memo: txn.memo,
        approved: txn.approved,
        cleared: txn.cleared,
        account_name: txn.account_name,
        payee_name: txn.payee_name,
        category_name: txn.category_name,
        flag_color: txn.flag_color,
        transfer_account_id: txn.transfer_account_id,
        transfer_transaction_id: txn.transfer_transaction_id,
        matched_transaction_id: txn.matched_transaction_id,
        import_id: txn.import_id,
        // A split leg listed as its own row; the id ties it back to the whole transaction.
        ...(txn.type === "subtransaction" ? { parent_transaction_id: txn.parent_transaction_id } : {}),
        // Present only on splits, whose parent row is categorised "Split".
        subtransactions: mapSubtransactions(txn.subtransactions, decimalDigits),
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          transactions,
          transaction_count: transactions.length,
          total_available: matches.length,
          ...(totals ? { totals } : {}),
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting transactions:", error);
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
