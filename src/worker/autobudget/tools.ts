import { z } from "zod";

import type { ToolEntry } from "../../registry.js";
import { getErrorMessage } from "../../tools/errorUtils.js";
import { toDollars } from "../../tools/money.js";
import type { WorkerEnv } from "../env.js";
import { dryRun, setPaused, status, type RunOptions } from "./run.js";

/**
 * MCP tools for the auto-budget service. They need the service's D1 state,
 * so only the Worker registers them, and only when AUTOBUDGET_DB is bound.
 */

function result(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

function failure(error: unknown) {
  return result({ success: false, error: getErrorMessage(error) });
}

const DEFAULT_LIST_LIMIT = 50;

export function autobudgetTools(env: WorkerEnv, options: RunOptions = {}): ToolEntry[] {
  const statusTool = {
    name: "ynab_autobudget_status",
    description: "Reports the auto-budget service: its mode (off, shadow or live) and why, whether it is paused, its last scheduled run, how many decisions it recorded in the last 24 hours, and the caps its write stages will enforce. Never writes to YNAB.",
    inputSchema: {},
    async execute() {
      try {
        return result({ success: true, ...await status(env, options.now) });
      } catch (error) {
        return failure(error);
      }
    },
  };

  const planTool = {
    name: "ynab_autobudget_plan",
    description: "Dry run of the auto-budget service: syncs from YNAB and shows what it would do right now - categorize by payee history, approve, assign Ready to Assign to targets (this month first, then next month) - plus the alerts it would raise. Records and sends nothing, and never writes to YNAB. Amounts are in plain currency.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional()
        .describe(`Most transaction decisions to list (default ${DEFAULT_LIST_LIMIT}); the summary counts every decision`),
    },
    async execute(input: { limit?: number }) {
      try {
        const run = await dryRun(env, options);
        const { evaluation: ev } = run;
        const money = (milliunits: number) => toDollars(milliunits, ev.currency.decimalDigits);
        const transactionDecisions = ev.decisions.filter((d) => d.stage !== "assign");
        const summary: Record<string, number> = {};
        for (const d of ev.decisions) summary[`${d.stage}.${d.action}`] = (summary[`${d.stage}.${d.action}`] ?? 0) + 1;
        const withoutMilliunits = ({ assignMilliunits, newBudgetedMilliunits, ...rest }: typeof ev.assign.current[number]) => rest;

        return result({
          success: true,
          mode: run.mode,
          requested_mode: run.requestedMode,
          mode_reason: run.modeReason,
          paused: run.paused,
          calls_used: run.calls,
          synced_transactions: ev.synced.transactions,
          summary,
          transactions: transactionDecisions.slice(0, input.limit ?? DEFAULT_LIST_LIMIT).map((d) => ({
            transaction_id: d.subjectId,
            stage: d.stage,
            action: d.action,
            reason: d.reason,
            source: d.source,
            ...d.detail,
          })),
          transactions_listed: Math.min(transactionDecisions.length, input.limit ?? DEFAULT_LIST_LIMIT),
          transactions_total: transactionDecisions.length,
          assign: {
            month: ev.assign.month,
            ready_to_assign: money(ev.assign.readyToAssign),
            cap: money(ev.assign.cap),
            this_month: ev.assign.current.map(withoutMilliunits),
            next_month: ev.assign.nextMonth,
            next: ev.assign.next.map(withoutMilliunits),
            remaining_after: money(ev.assign.remaining),
          },
          alerts: {
            immediate: ev.immediate.map(({ rule, title, message }) => ({ rule, title, message })),
            on_pace_to_overspend: ev.pace.map((item) => ({
              category_id: item.categoryId,
              category: item.name,
              spent: money(item.spent),
              available: money(item.available),
              projected: money(item.projected),
            })),
            backlog: ev.backlog,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  };

  const pauseTool = {
    name: "ynab_autobudget_pause",
    description: "Pauses the auto-budget service so its scheduled runs do nothing, or resumes it with paused=false. Takes effect from the next run. Changes only the service's own state, never YNAB data, so it works in read-only mode too.",
    inputSchema: {
      paused: z.boolean().optional().describe("true to pause (default), false to resume"),
      reason: z.string().max(200).optional().describe("Why, shown by ynab_autobudget_status while paused"),
    },
    async execute(input: { paused?: boolean; reason?: string }) {
      try {
        const paused = input.paused ?? true;
        await setPaused(env, paused, input.reason, options.now);
        return result({ success: true, paused, ...(paused && input.reason ? { reason: input.reason } : {}) });
      } catch (error) {
        return failure(error);
      }
    },
  };

  return [
    { title: "Auto-budget Status", module: statusTool, writes: false },
    { title: "Auto-budget Plan", module: planTool, writes: false },
    { title: "Auto-budget Pause", module: pauseTool, writes: false, changesServerState: true, idempotent: true },
  ];
}
