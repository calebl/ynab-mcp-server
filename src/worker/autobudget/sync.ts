import type * as ynab from "ynab";

import { HISTORY_MONTHS, MAX_ROWS_PER_SYNC } from "./config.js";
import type { StoredAccount, StoredTransaction, Store } from "./store.js";
import { planPath, type YnabReader } from "./ynab.js";

export function toStoredTransaction(txn: ynab.TransactionDetail): StoredTransaction {
  return {
    id: txn.id,
    date: txn.date,
    amount: txn.amount,
    account_id: txn.account_id,
    payee_id: txn.payee_id ?? null,
    payee_name: txn.payee_name ?? null,
    category_id: txn.category_id ?? null,
    approved: txn.approved,
    cleared: txn.cleared,
    flag_color: txn.flag_color ?? null,
    import_id: txn.import_id ?? null,
    matched_transaction_id: txn.matched_transaction_id ?? null,
    transfer_account_id: txn.transfer_account_id ?? null,
    split: (txn.subtransactions ?? []).some((sub) => !sub.deleted),
    subtransactions: (txn.subtransactions ?? []).map((sub) => ({
      id: sub.id,
      amount: sub.amount,
      category_id: sub.category_id ?? null,
      transfer_account_id: sub.transfer_account_id ?? null,
      deleted: sub.deleted,
    })),
    deleted: txn.deleted,
  };
}

export function toStoredAccount(account: ynab.Account): StoredAccount {
  return {
    id: account.id,
    name: account.name,
    on_budget: account.on_budget,
    closed: account.closed,
    deleted: account.deleted,
    direct_import_in_error: Boolean(account.direct_import_in_error),
  };
}

/** The first day of the month HISTORY_MONTHS before `today` (YYYY-MM-DD). */
export function historyStart(today: string): string {
  const [year, month] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1 - HISTORY_MONTHS, 1));
  return start.toISOString().slice(0, 10);
}

export interface SyncResult {
  /** Rows the response carried. */
  changed: number;
  /** True when there was no cursor yet and the whole history window was read. */
  full: boolean;
  /** Rows not stored because the response exceeded MAX_ROWS_PER_SYNC. */
  dropped: number;
}

/**
 * Picks the rows one sync stores when YNAB returns more than `limit`: rows
 * still waiting on the owner first, then the most recent. What is left out is
 * the oldest settled history, which matters least to every decision.
 */
export function rowsToStore(rows: StoredTransaction[], limit = MAX_ROWS_PER_SYNC): StoredTransaction[] {
  if (rows.length <= limit) return rows;
  const waiting = (row: StoredTransaction) => !row.deleted && !row.approved;
  return [...rows]
    .sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || b.date.localeCompare(a.date))
    .slice(0, limit);
}

/**
 * Brings the transaction mirror up to date. The first sync reads the history
 * window; every later one asks only for what changed since the stored
 * `server_knowledge`, which is a few bytes when nothing did.
 */
export async function syncTransactions(
  reader: YnabReader,
  store: Store,
  planId: string,
  today: string,
  now: Date,
  afterRead?: () => Promise<void>,
): Promise<SyncResult> {
  const cursor = await store.getCursor("transactions");
  const query = cursor === null ? `since_date=${historyStart(today)}` : `last_knowledge_of_server=${cursor}`;
  const data = await reader.get<{ transactions: ynab.TransactionDetail[]; server_knowledge: number }>(
    `${planPath(planId)}/transactions?${query}`,
  );
  await afterRead?.();
  const stored = rowsToStore(data.transactions.map(toStoredTransaction));
  await store.upsertTransactions(stored);
  await store.setCursor("transactions", data.server_knowledge, now);
  return { changed: data.transactions.length, full: cursor === null, dropped: data.transactions.length - stored.length };
}

export async function syncAccounts(
  reader: YnabReader,
  store: Store,
  planId: string,
  now: Date,
  afterRead?: (accounts: StoredAccount[]) => Promise<void>,
): Promise<SyncResult> {
  const cursor = await store.getCursor("accounts");
  const query = cursor === null ? "" : `?last_knowledge_of_server=${cursor}`;
  const data = await reader.get<{ accounts: ynab.Account[]; server_knowledge: number }>(`${planPath(planId)}/accounts${query}`);
  const accounts = data.accounts.map(toStoredAccount);
  await afterRead?.(accounts);
  await store.upsertAccounts(accounts);
  await store.setCursor("accounts", data.server_knowledge, now);
  return { changed: data.accounts.length, full: cursor === null, dropped: 0 };
}
