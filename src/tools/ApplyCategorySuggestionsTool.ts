import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage } from "./errorUtils.js";
import { contentFingerprint, getEligibleCategories, isTransfer } from "./SuggestCategoriesTool.js";

export const name = "ynab_apply_category_suggestions";
export const description = "Applies explicitly supplied category suggestions after refetching and verifying every transaction fingerprint. Never auto-applies, approves, or calls TypeSafe. Supports dry-run and returns a pre-write undo manifest.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId"),
  suggestions: z.array(z.object({
    transaction_id: z.string().min(1),
    category_id: z.string().min(1),
    expected_content_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })).min(1).max(25).describe("Explicit category changes; maximum 25 rows"),
  dry_run: z.boolean().optional().default(false).describe("Validate without writing to YNAB"),
};

interface Input { planId?: string; budgetId?: string; dry_run?: boolean; suggestions: Array<{ transaction_id: string; category_id: string; expected_content_fingerprint: string }> }

function result(body: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] }; }

export async function execute(input: Input, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const categoriesResponse = await api.categories.getCategories(planId);
    const eligible = new Map(getEligibleCategories(categoriesResponse.data.category_groups).map(c => [c.id, c]));
    const seen = new Set<string>();
    const rows: any[] = [];
    const survivors: Array<{ row: Input["suggestions"][number]; transaction: ynab.TransactionDetail }> = [];
    for (const row of input.suggestions) {
      if (seen.has(row.transaction_id)) { rows.push({ ...row, status: "rejected", reason: "duplicate_transaction_id" }); continue; }
      seen.add(row.transaction_id);
      let transaction: ynab.TransactionDetail;
      try { transaction = (await api.transactions.getTransactionById(planId, row.transaction_id)).data.transaction; }
      catch (error) { rows.push({ ...row, status: "rejected", reason: `refetch_failed: ${getErrorMessage(error)}` }); continue; }
      if (transaction.category_id === row.category_id) { rows.push({ ...row, status: "already_applied" }); continue; }
      const actual = await contentFingerprint(transaction);
      if (actual !== row.expected_content_fingerprint) { rows.push({ ...row, status: "rejected", reason: "fingerprint_mismatch", current_content_fingerprint: actual }); continue; }
      let reason: string | undefined;
      if (transaction.deleted) reason = "deleted";
      else if (transaction.approved) reason = "approved";
      else if (transaction.cleared === "reconciled") reason = "reconciled";
      else if (!eligible.has(row.category_id)) reason = "ineligible_category";
      else if (transaction.transfer_account_id || isTransfer(transaction, new Map())) reason = "transfer";
      else if ((transaction.subtransactions ?? []).some(s => !s.deleted)) reason = "split";
      else if (transaction.category_id) reason = "not_uncategorized";
      else if (transaction.amount >= 0) reason = "not_uncategorized";
      if (reason) { rows.push({ ...row, status: "rejected", reason }); continue; }
      const undo = { transaction_id: transaction.id, category_id: transaction.category_id ?? null, approved: transaction.approved };
      rows.push({ ...row, status: input.dry_run ? "would_apply" : "pending", undo });
      survivors.push({ row, transaction });
    }
    const manifest = survivors.map(({ row, transaction }) => ({ transaction_id: transaction.id, category_id: transaction.category_id ?? null, approved: transaction.approved, requested_category_id: row.category_id }));
    if (!input.dry_run && survivors.length) {
      try {
        const response = await api.transactions.updateTransactions(planId, { transactions: survivors.map(({ row }) => ({ id: row.transaction_id, category_id: row.category_id })) });
        const updated = new Set((response.data.transactions ?? []).map(t => t.id));
        for (const row of rows) if (row.status === "pending") row.status = updated.has(row.transaction_id) ? "applied" : "failed";
      } catch (error) {
        for (const row of rows) if (row.status === "pending") { row.status = "failed"; row.reason = getErrorMessage(error); }
      }
    }
    return result({ success: true, dry_run: Boolean(input.dry_run), undo_manifest: manifest, rows });
  } catch (error) { return result({ success: false, error: getErrorMessage(error) }); }
}
