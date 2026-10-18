import type * as ynab from "ynab";

import { getErrorMessage } from "../../tools/errorUtils.js";
import { configuredPlanId } from "../../tools/planId.js";
import { getEligibleCategories } from "../../tools/SuggestCategoriesTool.js";
import type { WorkerEnv } from "../env.js";
import { localDateParts } from "../nag.js";
import {
  activeImportErrors,
  alertBatches,
  backlog,
  billsDue,
  buildDigest,
  combineAlerts,
  DEFAULT_CURRENCY,
  immediateAlerts,
  paceAlerts,
  planNotVisibleAlert,
  type Backlog,
  type BillItem,
  type Currency,
  type ImmediateAlert,
  type PaceItem,
} from "./alerts.js";
import { CAPS, readConfig, type AutobudgetConfig } from "./config.js";
import {
  assignDecisions,
  hasSurplus,
  planAssign,
  transactionDecisions,
  type AssignPlan,
  type Decision,
} from "./decisions.js";
import { sendPushover } from "./pushover.js";
import { alertKey, Store } from "./store.js";
import { historyStart, syncAccounts, syncTransactions } from "./sync.js";
import { explainMissingPlan, planPath, YnabReader, YnabRequestError } from "./ynab.js";

/** Longer than Cloudflare's 15-minute scheduled-handler limit. */
const LEASE_MS = 16 * 60 * 1000;
/** Audit rows, runs and periodic alerts are kept for 13 months. */
const RETENTION_MS = 396 * 24 * 60 * 60 * 1000;

export interface RunOptions {
  fetch?: typeof fetch;
  now?: Date;
}

interface Evaluation {
  today: string;
  decisions: Decision[];
  assign: AssignPlan;
  month: ynab.MonthDetail;
  immediate: ImmediateAlert[];
  pace: PaceItem[];
  backlog: Backlog;
  currency: Currency;
  synced: { transactions: number; full: boolean };
}

function nextMonthOf(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10);
}

async function planCurrency(reader: YnabReader, planId: string): Promise<Currency> {
  try {
    const data = await reader.get<{ settings: ynab.PlanSettings }>(`${planPath(planId)}/settings`);
    const format = data.settings.currency_format;
    return {
      isoCode: format?.iso_code ?? null,
      decimalDigits: typeof format?.decimal_digits === "number" ? format.decimal_digits : DEFAULT_CURRENCY.decimalDigits,
    };
  } catch (error) {
    if (error instanceof YnabRequestError && error.status === 404) throw error;
    return DEFAULT_CURRENCY;
  }
}

/** Syncs, then works out every decision and alert. Reads YNAB; never writes to it. */
async function evaluate(
  reader: YnabReader,
  store: Store,
  planId: string,
  config: AutobudgetConfig,
  now: Date,
  recordRecovery: boolean,
): Promise<Evaluation> {
  const { date: today } = localDateParts(now, config.timeZone);
  const base = planPath(planId);

  const synced = await syncTransactions(reader, store, planId, today, now);
  if (recordRecovery) await store.clearOpenAlerts("plan_not_visible", []);
  await syncAccounts(reader, store, planId, now);
  const accounts = await store.accounts();
  if (recordRecovery) {
    await store.clearOpenAlerts("import_error", activeImportErrors(accounts).map((account) => account.id));
  }
  const currency = await planCurrency(reader, planId);
  const { category_groups: groups } = await reader.get<{ category_groups: ynab.CategoryGroupWithCategories[] }>(`${base}/categories`);
  const { month } = await reader.get<{ month: ynab.MonthDetail }>(`${base}/months/${today.slice(0, 7)}-01`);

  const [pending, possibleDuplicates] = await Promise.all([
    store.pendingTransactions(),
    store.possibleDuplicateIds(),
  ]);
  const history = await store.payeeHistory(
    pending.flatMap((txn) => (txn.payee_id ? [txn.payee_id] : [])),
    historyStart(today),
    today,
  );

  const decisions = transactionDecisions({
    pending,
    history,
    possibleDuplicates,
    eligibleCategories: new Map(getEligibleCategories(groups).map((category) => [category.id, category])),
    categoryNames: new Map(groups.flatMap((group) => group.categories.map((category) => [category.id, category.name] as const))),
    offBudgetAccounts: new Set(accounts.filter((account) => !account.on_budget).map((account) => account.id)),
    decimalDigits: currency.decimalDigits,
  });

  let assign = planAssign(month, null, currency.decimalDigits);
  if (hasSurplus(assign)) {
    // Money left after this month's targets goes to next month's.
    const { month: next } = await reader.get<{ month: ynab.MonthDetail }>(`${base}/months/${nextMonthOf(month.month)}`);
    assign = planAssign(month, next, currency.decimalDigits);
  }
  decisions.push(...assignDecisions(assign));

  const outflowCounts = await store.outflowCounts(month.month, today);

  return {
    today,
    decisions,
    assign,
    month,
    immediate: immediateAlerts(month, accounts, currency),
    pace: paceAlerts(month, outflowCounts, today),
    backlog: backlog(pending),
    currency,
    synced: { transactions: synced.changed, full: synced.full },
  };
}

async function readBills(reader: YnabReader, planId: string, evaluation: Evaluation): Promise<BillItem[]> {
  const { scheduled_transactions: scheduled } = await reader.get<{ scheduled_transactions: ynab.ScheduledTransactionDetail[] }>(
    `${planPath(planId)}/scheduled_transactions`,
  );
  return billsDue(scheduled, evaluation.month, evaluation.today);
}

function countActions(decisions: Decision[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    const key = `${decision.stage}.${decision.action}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export type RunOutcome =
  | { ran: false; reason: string }
  | {
    ran: true;
    outcome: "ok" | "plan_not_visible" | "rate_limited" | "error";
    error?: string;
    mode: "shadow";
    calls: number;
    synced?: number;
    decisions?: Record<string, number>;
    recorded?: number;
    alertsSent?: number;
    digest?: string;
    notifier?: string;
  };

interface Prepared {
  config: AutobudgetConfig;
  planId: string;
  store: Store;
}

function prepare(env: WorkerEnv): Prepared | { reason: string } {
  const config = readConfig(env);
  if (!env.AUTOBUDGET_DB) return { reason: "AUTOBUDGET_DB is not bound" };
  const planId = configuredPlanId({ YNAB_PLAN_ID: env.YNAB_PLAN_ID, YNAB_BUDGET_ID: env.YNAB_BUDGET_ID });
  if (!planId) return { reason: "YNAB_PLAN_ID is not set" };
  return { config, planId, store: new Store(env.AUTOBUDGET_DB, planId) };
}

/**
 * The scheduled job, run hourly by the Worker's cron trigger. In this version
 * it only reads YNAB: it syncs, records what it would do, sends alerts and
 * the daily digest.
 */
export async function runAutobudget(env: WorkerEnv, options: RunOptions = {}): Promise<RunOutcome> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetch ?? fetch;
  const prepared = prepare(env);
  if ("reason" in prepared) return { ran: false, reason: prepared.reason };
  const { config, planId, store } = prepared;
  if (config.mode === "off") return { ran: false, reason: config.modeReason ?? "AUTOBUDGET_MODE is off" };
  if (await store.getState("paused")) return { ran: false, reason: "paused" };
  const runId = crypto.randomUUID();
  if (!await store.acquireLease(runId, now, LEASE_MS)) return { ran: false, reason: "another run holds the lease" };
  const reader = new YnabReader(env.YNAB_API_TOKEN, fetchImpl);
  const notify = (notification: { title: string; message: string }) => sendPushover(env, notification, fetchImpl);
  let notifier = config.notifierConfigured ? "configured" : "not_configured";

  try {
    await store.startRun(runId, config.mode, now);
    try {
      const { date: today } = localDateParts(now, config.timeZone);
      if (await store.getState("last_prune") !== today) {
        await store.prune(new Date(now.getTime() - RETENTION_MS));
        await store.setState("last_prune", today, now);
      }
      const evaluation = await evaluate(reader, store, planId, config, now, true);
      const recorded = await store.recordDecisions(runId, config.mode, evaluation.decisions, now);
      const sent = await store.sentAlerts();
      const fresh = evaluation.immediate.filter((alert) => !sent.has(alertKey(alert)));
      let alertsSent = 0;
      for (const batch of alertBatches(fresh)) {
        try {
          if (await notify(combineAlerts(batch)) !== "sent") break;
          await store.markAlertsSent(batch, now);
          alertsSent += batch.length;
          notifier = "sent";
        } catch (error) {
          notifier = `failed: ${getErrorMessage(error)}`;
          break;
        }
      }

      let digest = "not_due";
      const { hour } = localDateParts(now, config.timeZone);
      if (hour >= config.digestHour && await store.getState("last_digest") !== evaluation.today) {
        if (!config.notifierConfigured) {
          digest = "not_configured";
        } else {
          try {
            const bills = await readBills(reader, planId, evaluation);
            digest = await notify(buildDigest({
              date: evaluation.today,
              shadow: true,
              decisions: evaluation.decisions,
              assign: evaluation.assign,
              pace: evaluation.pace,
              bills,
              backlog: evaluation.backlog,
              currency: evaluation.currency,
            }));
            if (digest === "sent") await store.setState("last_digest", evaluation.today, now);
          } catch (error) {
            digest = `failed: ${getErrorMessage(error)}`;
          }
        }
      }

      const summary = {
        synced: evaluation.synced.transactions,
        full_sync: evaluation.synced.full,
        decisions: countActions(evaluation.decisions),
        recorded,
        alerts_sent: alertsSent,
        digest,
        notifier,
      };
      await store.finishRun(runId, now, "ok", null, reader.calls, summary);
      return {
        ran: true,
        outcome: "ok",
        mode: "shadow",
        calls: reader.calls,
        synced: evaluation.synced.transactions,
        decisions: summary.decisions,
        recorded,
        alertsSent,
        digest,
        notifier,
      };
    } catch (error) {
      let outcome: "plan_not_visible" | "rate_limited" | "error" = "error";
      let message = getErrorMessage(error);
      if (error instanceof YnabRequestError && error.status === 404) {
        const explanation = await explainMissingPlan(reader, planId);
        if (explanation) {
          outcome = "plan_not_visible";
          message = explanation;
          await alertOnce(store, planNotVisibleAlert(planId, explanation), notify, now);
        }
      } else if (error instanceof YnabRequestError && error.status === 429) {
        outcome = "rate_limited";
      }
      await store.finishRun(runId, now, outcome, message, reader.calls, { notifier });
      return { ran: true, outcome, error: message, mode: "shadow", calls: reader.calls };
    }
  } finally {
    await store.releaseLease(runId);
  }
}

async function alertOnce(
  store: Store,
  alert: ImmediateAlert,
  notify: (notification: { title: string; message: string }) => Promise<string>,
  now: Date,
): Promise<void> {
  try {
    if ((await store.sentAlerts()).has(alertKey(alert))) return;
    if (await notify(alert) === "sent") await store.markAlertsSent([alert], now);
  } catch {
    // The run record already carries the explanation.
  }
}

export interface DryRun {
  mode: AutobudgetConfig["mode"];
  requestedMode: AutobudgetConfig["requestedMode"];
  modeReason: string | null;
  paused: boolean;
  calls: number;
  evaluation: Evaluation;
  bills: BillItem[];
}

/**
 * What the service would do right now, without recording or sending
 * anything. It still syncs the mirror, which only caches YNAB data.
 */
export async function dryRun(env: WorkerEnv, options: RunOptions = {}): Promise<DryRun> {
  const now = options.now ?? new Date();
  const prepared = prepare(env);
  if ("reason" in prepared) throw new Error(prepared.reason);
  const { config, planId, store } = prepared;
  const leaseOwner = crypto.randomUUID();
  if (!await store.acquireLease(leaseOwner, now, LEASE_MS)) throw new Error("A scheduled run is in progress; try again in a minute.");

  const reader = new YnabReader(env.YNAB_API_TOKEN, options.fetch ?? fetch);
  try {
    const evaluation = await evaluate(reader, store, planId, config, now, false);
    const bills = await readBills(reader, planId, evaluation);
    return {
      mode: config.mode,
      requestedMode: config.requestedMode,
      modeReason: config.modeReason,
      paused: Boolean(await store.getState("paused")),
      calls: reader.calls,
      evaluation,
      bills,
    };
  } catch (error) {
    if (error instanceof YnabRequestError && error.status === 404) {
      const explanation = await explainMissingPlan(reader, planId);
      if (explanation) throw new Error(explanation);
    }
    throw error;
  } finally {
    await store.releaseLease(leaseOwner);
  }
}

export interface Status {
  mode: AutobudgetConfig["mode"];
  requestedMode: AutobudgetConfig["requestedMode"];
  modeReason: string | null;
  readOnly: boolean;
  paused: { since: string; reason: string } | null;
  notifierConfigured: boolean;
  digestHour: number;
  timeZone: string;
  lastRun: Awaited<ReturnType<Store["lastRun"]>>;
  decisionsLast24h: Array<{ stage: string; action: string; n: number }>;
  caps: typeof CAPS;
}

export async function status(env: WorkerEnv, now = new Date()): Promise<Status> {
  const prepared = prepare(env);
  if ("reason" in prepared) throw new Error(prepared.reason);
  const { config, store } = prepared;
  const paused = await store.getState("paused");
  return {
    mode: config.mode,
    requestedMode: config.requestedMode,
    modeReason: config.modeReason,
    readOnly: config.readOnly,
    paused: paused ? JSON.parse(paused) : null,
    notifierConfigured: config.notifierConfigured,
    digestHour: config.digestHour,
    timeZone: config.timeZone,
    lastRun: await store.lastRun(),
    decisionsLast24h: await store.decisionCounts(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    caps: CAPS,
  };
}

/** Pauses (or resumes) the service. A paused service skips its scheduled runs entirely. */
export async function setPaused(env: WorkerEnv, paused: boolean, reason: string | undefined, now = new Date()): Promise<void> {
  const prepared = prepare(env);
  if ("reason" in prepared) throw new Error(prepared.reason);
  if (paused) {
    await prepared.store.setState("paused", JSON.stringify({ since: now.toISOString(), reason: reason ?? "paused from an MCP client" }), now);
  } else {
    await prepared.store.deleteState("paused");
  }
}
