import type * as ynab from "ynab";

import { HISTORY_MONTHS, MAX_ROWS_PER_RUN } from "./config.js";
import { transactionMirrorStart, type StoredAccount, type StoredTransaction, type Store } from "./store.js";
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
  /** Rows durably applied to the mirror. */
  applied: number;
  /** True when there was no cursor yet and the whole retained mirror window was read. */
  full: boolean;
  /** Rows of this sync still to apply; a later run continues with them. */
  remaining: number;
}

/**
 * Where a sync too large for one run stands. Each run repeats the same
 * request and applies the next rows in id order. The cursor saved at the end
 * is the server knowledge of the sequence's first response, so anything that
 * changed while the sequence ran is sent again by the next delta.
 */
interface SyncProgress {
  /** The cursor the sequence started from; null for the first sync. */
  from: number | null;
  /** Server knowledge of the sequence's first response. */
  knowledge: number;
  /** Id of the last row applied; null when no row fit in the previous run. */
  after: string | null;
  /** Rows the next runs still need to apply. */
  remaining: number;
}

const PROGRESS_KEY = "transaction_sync_progress";

type TransactionsResponse = { transactions: ynab.TransactionDetail[]; server_knowledge: number };

/**
 * One sync's transactions. The first sync reads the payee-history window plus
 * retained duplicate evidence, and also every unapproved or uncategorized
 * transaction however old, which later deltas would never send unless it
 * changed. Every later sync asks only for changes since the cursor, which is
 * a few bytes when nothing changed.
 */
async function readTransactions(reader: YnabReader, planId: string, cursor: number | null, today: string) {
  const base = `${planPath(planId)}/transactions`;
  if (cursor !== null) {
    const data = await reader.get<TransactionsResponse>(`${base}?last_knowledge_of_server=${cursor}`);
    return { rows: data.transactions, knowledge: data.server_knowledge };
  }
  const responses = [
    await reader.get<TransactionsResponse>(`${base}?since_date=${transactionMirrorStart(historyStart(today))}`),
    await reader.get<TransactionsResponse>(`${base}?type=unapproved`),
    await reader.get<TransactionsResponse>(`${base}?type=uncategorized`),
  ];
  const rows = new Map<string, ynab.TransactionDetail>();
  for (const response of responses) for (const txn of response.transactions) rows.set(txn.id, txn);
  // The oldest knowledge of the three, so the first delta re-sends anything newer than any of them.
  return { rows: [...rows.values()], knowledge: Math.min(...responses.map((response) => response.server_knowledge)) };
}

function readProgress(raw: string | null, cursor: number | null): SyncProgress | null {
  if (!raw) return null;
  const progress = JSON.parse(raw) as SyncProgress;
  return progress.from === cursor ? progress : null;
}

export async function transactionSyncRemaining(store: Store): Promise<number> {
  const progress = readProgress(
    await store.getState(PROGRESS_KEY),
    await store.getCursor("transactions"),
  );
  return progress?.remaining ?? 0;
}

async function applyTransactions(
  store: Store,
  cursor: number | null,
  progress: SyncProgress | null,
  rows: ynab.TransactionDetail[],
  knowledge: number,
  now: Date,
  limit: number,
): Promise<{ applied: number; remaining: number; knowledge: number }> {
  const unapplied = rows
    .map(toStoredTransaction)
    .filter((row) => !progress || progress.after === null || row.id > progress.after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batch = unapplied.slice(0, limit);
  await store.upsertTransactions(batch);

  const startKnowledge = progress?.knowledge ?? knowledge;
  const remaining = unapplied.length - batch.length;
  if (remaining > 0) {
    const next: SyncProgress = {
      from: cursor,
      knowledge: startKnowledge,
      after: batch[batch.length - 1]?.id ?? null,
      remaining,
    };
    await store.setState(PROGRESS_KEY, JSON.stringify(next), now);
  } else {
    await store.setCursor("transactions", startKnowledge, now);
    await store.deleteState(PROGRESS_KEY);
  }
  return { applied: batch.length, remaining, knowledge: startKnowledge };
}

/**
 * Brings the transaction mirror up to date, applying at most `limit` rows per
 * run. The cursor never moves past rows that were not applied: a larger sync
 * records its progress and continues on the next run.
 */
export async function syncTransactions(
  reader: YnabReader,
  store: Store,
  planId: string,
  today: string,
  now: Date,
  afterRead?: () => Promise<void>,
  limit = MAX_ROWS_PER_RUN,
): Promise<SyncResult> {
  const cursor = await store.getCursor("transactions");
  const progress = readProgress(await store.getState(PROGRESS_KEY), cursor);
  const firstRead = await readTransactions(reader, planId, cursor, today);
  await afterRead?.();

  const first = await applyTransactions(
    store,
    cursor,
    progress,
    firstRead.rows,
    firstRead.knowledge,
    now,
    limit,
  );
  if (first.remaining > 0 || (cursor !== null && progress === null)) {
    return { applied: first.applied, full: cursor === null, remaining: first.remaining };
  }

  const catchup = await readTransactions(reader, planId, first.knowledge, today);
  const second = await applyTransactions(
    store,
    first.knowledge,
    null,
    catchup.rows,
    catchup.knowledge,
    now,
    limit - first.applied,
  );
  return {
    applied: first.applied + second.applied,
    full: cursor === null,
    remaining: second.remaining,
  };
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
  return { applied: accounts.length, full: cursor === null, remaining: 0 };
}
