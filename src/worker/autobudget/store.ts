import type { Decision } from "./decisions.js";

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
// therefore travel as one JSON parameter, unpacked with json_each, in chunks
// that stay well inside the statement-size limit.
const JSON_CHUNK = 400;

function chunks<T>(items: T[], size = JSON_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const bool = (value: unknown) => value === 1 || value === true;

function toTransaction(row: Record<string, unknown>): StoredTransaction {
  return {
    ...(row as unknown as StoredTransaction),
    approved: bool(row.approved),
    split: bool(row.split),
    deleted: bool(row.deleted),
  };
}

/** All of the service's D1 access. Scoped to one plan for plan data. */
export class Store {
  constructor(private readonly db: D1Database, private readonly planId: string) {}

  async getState(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM state WHERE key = ?1").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setState(key: string, value: string, now: Date): Promise<void> {
    await this.db.prepare(
      "INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(key, value, now.toISOString()).run();
  }

  async deleteState(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM state WHERE key = ?1").bind(key).run();
  }

  /**
   * Takes the run lease unless an unexpired one exists, so an overlapping cron
   * run or dry run cannot interleave with this one.
   */
  async acquireLease(now: Date, ttlMs: number): Promise<boolean> {
    const result = await this.db.prepare(
      "INSERT INTO state (key, value, updated_at) VALUES ('lease', ?1, ?2) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
      "WHERE state.value < ?2",
    ).bind(new Date(now.getTime() + ttlMs).toISOString(), now.toISOString()).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async releaseLease(): Promise<void> {
    await this.deleteState("lease");
  }

  async getCursor(resource: string): Promise<number | null> {
    const row = await this.db.prepare("SELECT server_knowledge FROM sync_state WHERE resource = ?1")
      .bind(`${this.planId}:${resource}`).first<{ server_knowledge: number }>();
    return row?.server_knowledge ?? null;
  }

  async setCursor(resource: string, serverKnowledge: number, now: Date): Promise<void> {
    await this.db.prepare(
      "INSERT INTO sync_state (resource, server_knowledge, synced_at) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT (resource) DO UPDATE SET server_knowledge = excluded.server_knowledge, synced_at = excluded.synced_at",
    ).bind(`${this.planId}:${resource}`, serverKnowledge, now.toISOString()).run();
  }

  async upsertTransactions(rows: StoredTransaction[]): Promise<void> {
    const statements = chunks(rows).map((chunk) => this.db.prepare(
      "INSERT INTO txn (id, plan_id, date, amount, account_id, payee_id, payee_name, category_id, approved, cleared, " +
      "flag_color, import_id, matched_transaction_id, transfer_account_id, split, deleted) " +
      "SELECT j.value ->> 'id', ?1, j.value ->> 'date', j.value ->> 'amount', j.value ->> 'account_id', " +
      "j.value ->> 'payee_id', j.value ->> 'payee_name', j.value ->> 'category_id', j.value ->> 'approved', " +
      "j.value ->> 'cleared', j.value ->> 'flag_color', j.value ->> 'import_id', j.value ->> 'matched_transaction_id', " +
      "j.value ->> 'transfer_account_id', j.value ->> 'split', j.value ->> 'deleted' FROM json_each(?2) AS j WHERE true " +
      "ON CONFLICT (id) DO UPDATE SET date = excluded.date, amount = excluded.amount, account_id = excluded.account_id, " +
      "payee_id = excluded.payee_id, payee_name = excluded.payee_name, category_id = excluded.category_id, " +
      "approved = excluded.approved, cleared = excluded.cleared, flag_color = excluded.flag_color, " +
      "import_id = excluded.import_id, matched_transaction_id = excluded.matched_transaction_id, " +
      "transfer_account_id = excluded.transfer_account_id, split = excluded.split, deleted = excluded.deleted",
    ).bind(this.planId, JSON.stringify(chunk.map((row) => ({
      ...row,
      approved: row.approved ? 1 : 0,
      split: row.split ? 1 : 0,
      deleted: row.deleted ? 1 : 0,
    })))));
    if (statements.length) await this.db.batch(statements);
  }

  async upsertAccounts(rows: StoredAccount[]): Promise<void> {
    const statements = chunks(rows).map((chunk) => this.db.prepare(
      "INSERT INTO account (id, plan_id, name, on_budget, closed, deleted, direct_import_in_error) " +
      "SELECT j.value ->> 'id', ?1, j.value ->> 'name', j.value ->> 'on_budget', j.value ->> 'closed', " +
      "j.value ->> 'deleted', j.value ->> 'direct_import_in_error' FROM json_each(?2) AS j WHERE true " +
      "ON CONFLICT (id) DO UPDATE SET name = excluded.name, on_budget = excluded.on_budget, closed = excluded.closed, " +
      "deleted = excluded.deleted, direct_import_in_error = excluded.direct_import_in_error",
    ).bind(this.planId, JSON.stringify(chunk.map((row) => ({
      ...row,
      on_budget: row.on_budget ? 1 : 0,
      closed: row.closed ? 1 : 0,
      deleted: row.deleted ? 1 : 0,
      direct_import_in_error: row.direct_import_in_error ? 1 : 0,
    })))));
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

  /** Category use and approvals per payee since `sinceDate`, over ordinary (non-transfer, unsplit) rows. */
  async payeeHistory(payeeIds: string[], sinceDate: string): Promise<Map<string, PayeeHistory>> {
    const history = new Map<string, PayeeHistory>();
    for (const chunk of chunks([...new Set(payeeIds)])) {
      const { results } = await this.db.prepare(
        "SELECT payee_id, category_id, COUNT(*) AS n, SUM(approved) AS approved FROM txn " +
        "WHERE plan_id = ?1 AND deleted = 0 AND date >= ?2 AND transfer_account_id IS NULL AND split = 0 " +
        "AND payee_id IN (SELECT value FROM json_each(?3)) GROUP BY payee_id, category_id",
      ).bind(this.planId, sinceDate, JSON.stringify(chunk)).all<{ payee_id: string; category_id: string | null; n: number; approved: number }>();
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
      "AND abs(julianday(o.date) - julianday(p.date)) <= 3 " +
      "WHERE p.plan_id = ?1 AND p.deleted = 0 AND p.approved = 0",
    ).bind(this.planId).all<{ id: string }>();
    return new Set(results.map((row) => row.id));
  }

  /** Number of outflows per category dated within [from, to). */
  async outflowCounts(from: string, to: string): Promise<Map<string, number>> {
    const { results } = await this.db.prepare(
      "SELECT category_id, COUNT(*) AS n FROM txn WHERE plan_id = ?1 AND deleted = 0 AND amount < 0 " +
      "AND category_id IS NOT NULL AND date >= ?2 AND date < ?3 GROUP BY category_id",
    ).bind(this.planId, from, to).all<{ category_id: string; n: number }>();
    return new Map(results.map((row) => [row.category_id, row.n]));
  }

  async startRun(id: string, mode: string, now: Date): Promise<void> {
    await this.db.prepare("INSERT INTO run (id, started_at, mode) VALUES (?1, ?2, ?3)")
      .bind(id, now.toISOString(), mode).run();
  }

  async finishRun(id: string, now: Date, outcome: string, error: string | null, callsUsed: number, summary: unknown): Promise<void> {
    await this.db.prepare(
      "UPDATE run SET finished_at = ?2, outcome = ?3, error = ?4, calls_used = ?5, summary = ?6 WHERE id = ?1",
    ).bind(id, now.toISOString(), outcome, error, callsUsed, JSON.stringify(summary)).run();
  }

  async lastRun(): Promise<RunRecord | null> {
    return await this.db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 1").first<RunRecord>();
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
      "SELECT stage, subject_id, decision_key FROM decision WHERE id IN " +
      "(SELECT MAX(id) FROM decision GROUP BY stage, subject_id)",
    ).all<{ stage: string; subject_id: string; decision_key: string }>();
    const latest = new Map(results.map((row) => [`${row.stage}|${row.subject_id}`, row.decision_key]));

    const fresh = decisions
      .map((decision) => ({ decision, key: decisionKey(decision) }))
      .filter(({ decision, key }) => latest.get(`${decision.stage}|${decision.subjectId}`) !== key);

    const statements = chunks(fresh).map((chunk) => this.db.prepare(
      "INSERT INTO decision (run_id, stage, subject_id, action, reason, source, detail, decision_key, mode, created_at) " +
      "SELECT ?1, j.value ->> 'stage', j.value ->> 'subjectId', j.value ->> 'action', j.value ->> 'reason', " +
      "j.value ->> 'source', j.value ->> 'detail', j.value ->> 'key', ?2, ?3 FROM json_each(?4) AS j",
    ).bind(runId, mode, now.toISOString(), JSON.stringify(chunk.map(({ decision, key }) => ({
      stage: decision.stage,
      subjectId: decision.subjectId,
      action: decision.action,
      reason: decision.reason,
      source: decision.source,
      detail: JSON.stringify(decision.detail),
      key,
    })))));
    if (statements.length) await this.db.batch(statements);
    return fresh.length;
  }

  async decisionCounts(since: Date): Promise<Array<{ stage: string; action: string; n: number }>> {
    const { results } = await this.db.prepare(
      "SELECT stage, action, COUNT(*) AS n FROM decision WHERE created_at >= ?1 GROUP BY stage, action ORDER BY stage, action",
    ).bind(since.toISOString()).all<{ stage: string; action: string; n: number }>();
    return results;
  }

  async sentAlerts(): Promise<Set<string>> {
    const { results } = await this.db.prepare("SELECT rule, subject_id, period FROM alert").all<{ rule: string; subject_id: string; period: string }>();
    return new Set(results.map((row) => alertKey({ rule: row.rule, subjectId: row.subject_id, period: row.period })));
  }

  async markAlertsSent(alerts: AlertKey[], now: Date): Promise<void> {
    if (!alerts.length) return;
    await this.db.prepare(
      "INSERT OR IGNORE INTO alert (rule, subject_id, period, sent_at) " +
      "SELECT j.value ->> 'rule', j.value ->> 'subjectId', j.value ->> 'period', ?1 FROM json_each(?2) AS j",
    ).bind(now.toISOString(), JSON.stringify(alerts.map(({ rule, subjectId, period }) => ({ rule, subjectId, period })))).run();
  }

  /**
   * Forgets "open" alerts for `rule` whose condition has cleared, so the
   * condition alerts again if it comes back.
   */
  async clearOpenAlerts(rule: string, stillActive: string[]): Promise<void> {
    await this.db.prepare(
      "DELETE FROM alert WHERE rule = ?1 AND period = 'open' AND subject_id NOT IN (SELECT value FROM json_each(?2))",
    ).bind(rule, JSON.stringify(stillActive)).run();
  }

  /** Drops audit rows, runs and alerts older than `before`. */
  async prune(before: Date): Promise<void> {
    const cutoff = before.toISOString();
    await this.db.batch([
      this.db.prepare("DELETE FROM decision WHERE created_at < ?1").bind(cutoff),
      this.db.prepare("DELETE FROM run WHERE started_at < ?1").bind(cutoff),
      this.db.prepare("DELETE FROM alert WHERE sent_at < ?1").bind(cutoff),
    ]);
  }
}

export { alertKey };

/** What makes two decisions the same for the audit log: everything but the run. */
export function decisionKey(decision: Decision): string {
  return JSON.stringify([decision.action, decision.reason, decision.source, decision.detail]);
}
