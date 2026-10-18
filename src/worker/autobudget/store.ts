import type { Decision } from "./decisions.js";

export interface StoredSubtransaction {
  id: string;
  amount: number;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

/** A transaction as the mirror keeps it. Amounts are milliunits. */
export interface StoredTransaction {
  id: string;
  date: string;
  amount: number;
  account_id: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  approved: boolean;
  cleared: string;
  flag_color: string | null;
  import_id: string | null;
  matched_transaction_id: string | null;
  transfer_account_id: string | null;
  split: boolean;
  subtransactions: StoredSubtransaction[];
  deleted: boolean;
}

export interface StoredAccount {
  id: string;
  name: string;
  on_budget: boolean;
  closed: boolean;
  deleted: boolean;
  direct_import_in_error: boolean;
}

/** Category counts and approval count for one payee over the history window. */
export interface PayeeHistory {
  categories: Map<string, number>;
  approved: number;
}

export interface RunRecord {
  id: string;
  started_at: string;
  finished_at: string | null;
  mode: string;
  outcome: string | null;
  error: string | null;
  calls_used: number | null;
  summary: string | null;
}

export interface AlertKey {
  rule: string;
  subjectId: string;
  period: string;
}

const alertKey = (alert: AlertKey) => `${alert.rule}|${alert.subjectId}|${alert.period}`;

// D1 caps a query at 100 bound parameters, and each statement in a batch
// counts toward the per-invocation query limit (50 on the Free plan). Rows
// therefore travel as one JSON parameter, unpacked with json_each. A bound
// string may be up to 2 MB, so batches are sized by length rather than row
// count: a first sync of tens of thousands of transactions stays at a handful
// of statements. The character budget leaves room for multi-byte UTF-8.
const JSON_PARAM_CHARS = 600_000;

/** Serializes rows into JSON arrays that each fit in one bound parameter. */
export function jsonBatches(rows: unknown[], maxChars = JSON_PARAM_CHARS): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let length = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (current.length && length + json.length + 1 > maxChars) {
      batches.push(`[${current.join(",")}]`);
      current = [];
      length = 2;
    }
    current.push(json);
    length += json.length + 1;
  }
  if (current.length) batches.push(`[${current.join(",")}]`);
  return batches;
}

const bool = (value: unknown) => value === 1 || value === true;

function toTransaction(row: Record<string, unknown>): StoredTransaction {
  return {
    ...(row as unknown as StoredTransaction),
    approved: bool(row.approved),
    split: bool(row.split),
    subtransactions: JSON.parse(row.subtransactions as string) as StoredSubtransaction[],
    deleted: bool(row.deleted),
  };
}

/** All of the service's D1 access, scoped to one plan. */
export class Store {
  constructor(private readonly db: D1Database, private readonly planId: string) {}

  async getState(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM state WHERE plan_id = ?1 AND key = ?2")
      .bind(this.planId, key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setState(key: string, value: string, now: Date): Promise<void> {
    await this.db.prepare(
      "INSERT INTO state (plan_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (plan_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(this.planId, key, value, now.toISOString()).run();
  }

  async deleteState(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM state WHERE plan_id = ?1 AND key = ?2").bind(this.planId, key).run();
  }

  /**
   * Takes the run lease unless an unexpired one exists, so an overlapping cron
   * run or dry run cannot interleave with this one.
   */
  async acquireLease(owner: string, now: Date, ttlMs: number): Promise<boolean> {
    const value = JSON.stringify({ owner, expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
    const result = await this.db.prepare(
      "INSERT INTO state (plan_id, key, value, updated_at) VALUES (?1, 'lease', ?2, ?3) " +
      "ON CONFLICT (plan_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
      "WHERE json_extract(state.value, '$.expiresAt') <= ?3",
    ).bind(this.planId, value, now.toISOString()).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async releaseLease(owner: string): Promise<void> {
    await this.db.prepare(
      "DELETE FROM state WHERE plan_id = ?1 AND key = 'lease' AND json_extract(value, '$.owner') = ?2",
    ).bind(this.planId, owner).run();
  }

  async getCursor(resource: string): Promise<number | null> {
    const row = await this.db.prepare("SELECT server_knowledge FROM sync_state WHERE plan_id = ?1 AND resource = ?2")
      .bind(this.planId, resource).first<{ server_knowledge: number }>();
    return row?.server_knowledge ?? null;
  }

  async setCursor(resource: string, serverKnowledge: number, now: Date): Promise<void> {
    await this.db.prepare(
      "INSERT INTO sync_state (plan_id, resource, server_knowledge, synced_at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (plan_id, resource) DO UPDATE SET server_knowledge = excluded.server_knowledge, synced_at = excluded.synced_at",
    ).bind(this.planId, resource, serverKnowledge, now.toISOString()).run();
  }

  async upsertTransactions(rows: StoredTransaction[]): Promise<void> {
    const statements = jsonBatches(rows.map((row) => ({
      ...row,
      approved: row.approved ? 1 : 0,
      split: row.split ? 1 : 0,
      subtransactions: JSON.stringify(row.subtransactions),
      deleted: row.deleted ? 1 : 0,
    }))).map((batch) => this.db.prepare(
      "INSERT INTO txn (id, plan_id, date, amount, account_id, payee_id, payee_name, category_id, approved, cleared, " +
      "flag_color, import_id, matched_transaction_id, transfer_account_id, split, subtransactions, deleted) " +
      "SELECT j.value ->> 'id', ?1, j.value ->> 'date', j.value ->> 'amount', j.value ->> 'account_id', " +
      "j.value ->> 'payee_id', j.value ->> 'payee_name', j.value ->> 'category_id', j.value ->> 'approved', " +
      "j.value ->> 'cleared', j.value ->> 'flag_color', j.value ->> 'import_id', j.value ->> 'matched_transaction_id', " +
      "j.value ->> 'transfer_account_id', j.value ->> 'split', j.value ->> 'subtransactions', j.value ->> 'deleted' " +
      "FROM json_each(?2) AS j WHERE true " +
      "ON CONFLICT (plan_id, id) DO UPDATE SET date = excluded.date, amount = excluded.amount, account_id = excluded.account_id, " +
      "payee_id = excluded.payee_id, payee_name = excluded.payee_name, category_id = excluded.category_id, " +
      "approved = excluded.approved, cleared = excluded.cleared, flag_color = excluded.flag_color, " +
      "import_id = excluded.import_id, matched_transaction_id = excluded.matched_transaction_id, " +
      "transfer_account_id = excluded.transfer_account_id, split = excluded.split, " +
      "subtransactions = excluded.subtransactions, deleted = excluded.deleted",
    ).bind(this.planId, batch));
    if (statements.length) await this.db.batch(statements);
  }

  async upsertAccounts(rows: StoredAccount[]): Promise<void> {
    const statements = jsonBatches(rows.map((row) => ({
      ...row,
      on_budget: row.on_budget ? 1 : 0,
      closed: row.closed ? 1 : 0,
      deleted: row.deleted ? 1 : 0,
      direct_import_in_error: row.direct_import_in_error ? 1 : 0,
    }))).map((batch) => this.db.prepare(
      "INSERT INTO account (id, plan_id, name, on_budget, closed, deleted, direct_import_in_error) " +
      "SELECT j.value ->> 'id', ?1, j.value ->> 'name', j.value ->> 'on_budget', j.value ->> 'closed', " +
      "j.value ->> 'deleted', j.value ->> 'direct_import_in_error' FROM json_each(?2) AS j WHERE true " +
      "ON CONFLICT (plan_id, id) DO UPDATE SET name = excluded.name, on_budget = excluded.on_budget, closed = excluded.closed, " +
      "deleted = excluded.deleted, direct_import_in_error = excluded.direct_import_in_error",
    ).bind(this.planId, batch));
    if (statements.length) await this.db.batch(statements);
  }

  async accounts(): Promise<StoredAccount[]> {
    const { results } = await this.db.prepare("SELECT * FROM account WHERE plan_id = ?1").bind(this.planId).all<Record<string, unknown>>();
    return results.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      on_budget: bool(row.on_budget),
      closed: bool(row.closed),
      deleted: bool(row.deleted),
      direct_import_in_error: bool(row.direct_import_in_error),
    }));
  }

  /** Live transactions waiting on the owner: unapproved, or approved but never categorized. */
  async pendingTransactions(): Promise<StoredTransaction[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM txn WHERE plan_id = ?1 AND deleted = 0 AND " +
      "(approved = 0 OR (category_id IS NULL AND transfer_account_id IS NULL AND split = 0)) ORDER BY date, id",
    ).bind(this.planId).all<Record<string, unknown>>();
    return results.map(toTransaction);
  }

  /** Category use and approvals per payee within an inclusive date window, over ordinary rows. */
  async payeeHistory(payeeIds: string[], sinceDate: string, throughDate: string): Promise<Map<string, PayeeHistory>> {
    const history = new Map<string, PayeeHistory>();
    for (const batch of jsonBatches([...new Set(payeeIds)])) {
      const { results } = await this.db.prepare(
        "SELECT payee_id, category_id, COUNT(*) AS n, SUM(approved) AS approved FROM txn " +
        "WHERE plan_id = ?1 AND deleted = 0 AND date >= ?2 AND date <= ?3 " +
        "AND transfer_account_id IS NULL AND split = 0 " +
        "AND payee_id IN (SELECT value FROM json_each(?4)) GROUP BY payee_id, category_id",
      ).bind(this.planId, sinceDate, throughDate, batch).all<{ payee_id: string; category_id: string | null; n: number; approved: number }>();
      for (const row of results) {
        const entry = history.get(row.payee_id) ?? { categories: new Map(), approved: 0 };
        if (row.category_id) entry.categories.set(row.category_id, row.n);
        entry.approved += row.approved;
        history.set(row.payee_id, entry);
      }
    }
    return history;
  }

  /** Unapproved rows with a live twin: same account and amount, within three days. */
  async possibleDuplicateIds(): Promise<Set<string>> {
    const { results } = await this.db.prepare(
      "SELECT DISTINCT p.id FROM txn p JOIN txn o ON o.plan_id = p.plan_id AND o.account_id = p.account_id " +
      "AND o.amount = p.amount AND o.id <> p.id AND o.deleted = 0 " +
      // A range on date (not a computed difference) lets the txn_account index bound the scan.
      "AND o.date BETWEEN date(p.date, '-3 days') AND date(p.date, '+3 days') " +
      "WHERE p.plan_id = ?1 AND p.deleted = 0 AND p.approved = 0",
    ).bind(this.planId).all<{ id: string }>();
    return new Set(results.map((row) => row.id));
  }

  /** Number of outflows per category within an inclusive date window. */
  async outflowCounts(from: string, through: string): Promise<Map<string, number>> {
    const { results } = await this.db.prepare(
      "WITH category_outflow AS (" +
      "SELECT category_id FROM txn WHERE plan_id = ?1 AND deleted = 0 AND split = 0 AND amount < 0 " +
      "AND category_id IS NOT NULL AND date >= ?2 AND date <= ?3 " +
      "UNION ALL SELECT s.value ->> 'category_id' FROM txn AS t, json_each(t.subtransactions) AS s " +
      "WHERE t.plan_id = ?1 AND t.deleted = 0 AND t.date >= ?2 AND t.date <= ?3 " +
      "AND (s.value ->> 'deleted') = 0 AND (s.value ->> 'amount') < 0 " +
      "AND (s.value ->> 'category_id') IS NOT NULL AND (s.value ->> 'transfer_account_id') IS NULL) " +
      "SELECT category_id, COUNT(*) AS n FROM category_outflow GROUP BY category_id",
    ).bind(this.planId, from, through).all<{ category_id: string; n: number }>();
    return new Map(results.map((row) => [row.category_id, row.n]));
  }

  async startRun(id: string, mode: string, now: Date): Promise<void> {
    await this.db.prepare("INSERT INTO run (plan_id, id, started_at, mode) VALUES (?1, ?2, ?3, ?4)")
      .bind(this.planId, id, now.toISOString(), mode).run();
  }

  async finishRun(id: string, now: Date, outcome: string, error: string | null, callsUsed: number, summary: unknown): Promise<void> {
    await this.db.prepare(
      "UPDATE run SET finished_at = ?3, outcome = ?4, error = ?5, calls_used = ?6, summary = ?7 WHERE plan_id = ?1 AND id = ?2",
    ).bind(this.planId, id, now.toISOString(), outcome, error, callsUsed, JSON.stringify(summary)).run();
  }

  async lastRun(): Promise<RunRecord | null> {
    return await this.db.prepare("SELECT * FROM run WHERE plan_id = ?1 ORDER BY started_at DESC LIMIT 1")
      .bind(this.planId).first<RunRecord>();
  }

  /**
   * Appends decisions to the audit log, skipping any whose key matches the
   * subject's latest recorded decision. Hourly runs re-derive the same
   * decisions, and the log should show changes rather than repeat them.
   * Returns how many were recorded.
   */
  async recordDecisions(runId: string, mode: string, decisions: Decision[], now: Date): Promise<number> {
    if (!decisions.length) return 0;
    const { results } = await this.db.prepare(
      "SELECT stage, subject_id, decision_key FROM decision WHERE plan_id = ?1 AND id IN " +
      "(SELECT MAX(id) FROM decision WHERE plan_id = ?1 GROUP BY stage, subject_id)",
    ).bind(this.planId).all<{ stage: string; subject_id: string; decision_key: string }>();
    const latest = new Map(results.map((row) => [`${row.stage}|${row.subject_id}`, row.decision_key]));

    const fresh = decisions
      .map((decision) => ({ decision, key: decisionKey(decision) }))
      .filter(({ decision, key }) => latest.get(`${decision.stage}|${decision.subjectId}`) !== key);

    const statements = jsonBatches(fresh.map(({ decision, key }) => ({
      stage: decision.stage,
      subjectId: decision.subjectId,
      action: decision.action,
      reason: decision.reason,
      source: decision.source,
      detail: JSON.stringify(decision.detail),
      key,
    }))).map((batch) => this.db.prepare(
      "INSERT INTO decision (plan_id, run_id, stage, subject_id, action, reason, source, detail, decision_key, mode, created_at) " +
      "SELECT ?1, ?2, j.value ->> 'stage', j.value ->> 'subjectId', j.value ->> 'action', j.value ->> 'reason', " +
      "j.value ->> 'source', j.value ->> 'detail', j.value ->> 'key', ?3, ?4 FROM json_each(?5) AS j",
    ).bind(this.planId, runId, mode, now.toISOString(), batch));
    if (statements.length) await this.db.batch(statements);
    return fresh.length;
  }

  async decisionCounts(since: Date): Promise<Array<{ stage: string; action: string; n: number }>> {
    const { results } = await this.db.prepare(
      "SELECT stage, action, COUNT(*) AS n FROM decision WHERE plan_id = ?1 AND created_at >= ?2 " +
      "GROUP BY stage, action ORDER BY stage, action",
    ).bind(this.planId, since.toISOString()).all<{ stage: string; action: string; n: number }>();
    return results;
  }

  async sentAlerts(): Promise<Set<string>> {
    const { results } = await this.db.prepare("SELECT rule, subject_id, period FROM alert WHERE plan_id = ?1")
      .bind(this.planId).all<{ rule: string; subject_id: string; period: string }>();
    return new Set(results.map((row) => alertKey({ rule: row.rule, subjectId: row.subject_id, period: row.period })));
  }

  async markAlertsSent(alerts: AlertKey[], now: Date): Promise<void> {
    const statements = jsonBatches(alerts.map(({ rule, subjectId, period }) => ({ rule, subjectId, period })))
      .map((batch) => this.db.prepare(
        "INSERT OR IGNORE INTO alert (plan_id, rule, subject_id, period, sent_at) " +
        "SELECT ?1, j.value ->> 'rule', j.value ->> 'subjectId', j.value ->> 'period', ?2 FROM json_each(?3) AS j",
      ).bind(this.planId, now.toISOString(), batch));
    if (statements.length) await this.db.batch(statements);
  }

  /**
   * Forgets "open" alerts for `rule` whose condition has cleared, so the
   * condition alerts again if it comes back.
   */
  async clearOpenAlerts(rule: string, stillActive: string[]): Promise<void> {
    await this.db.prepare(
      "DELETE FROM alert WHERE plan_id = ?1 AND rule = ?2 AND period = 'open' " +
      "AND subject_id NOT IN (SELECT value FROM json_each(?3))",
    ).bind(this.planId, rule, JSON.stringify(stillActive)).run();
  }

  /**
   * Drops audit rows, runs and periodic alerts older than `before`, and keeps
   * the transaction mirror to the history window: deleted rows, and old rows
   * that are no longer pending, go. Every row still waiting on the owner stays,
   * however old.
   */
  async prune(before: Date, mirrorFrom: string): Promise<void> {
    const cutoff = before.toISOString();
    await this.db.batch([
      this.db.prepare(
        "DELETE FROM txn WHERE plan_id = ?1 AND (deleted = 1 OR (date < ?2 AND approved = 1 AND " +
        "(category_id IS NOT NULL OR transfer_account_id IS NOT NULL OR split != 0)))",
      ).bind(this.planId, mirrorFrom),
      this.db.prepare("DELETE FROM decision WHERE plan_id = ?1 AND created_at < ?2").bind(this.planId, cutoff),
      this.db.prepare("DELETE FROM run WHERE plan_id = ?1 AND started_at < ?2").bind(this.planId, cutoff),
      this.db.prepare("DELETE FROM alert WHERE plan_id = ?1 AND period != 'open' AND sent_at < ?2").bind(this.planId, cutoff),
    ]);
  }
}

export { alertKey };

/** What makes two decisions the same for the audit log: everything but the run. */
export function decisionKey(decision: Decision): string {
  return JSON.stringify([decision.action, decision.reason, decision.source, decision.detail]);
}
