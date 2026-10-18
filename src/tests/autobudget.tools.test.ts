import { describe, expect, it } from "vitest";
import type * as ynab from "ynab";

import { registerTools, type ToolRegistrar } from "../registry.js";
import { autobudgetTools } from "../worker/autobudget/tools.js";
import type { WorkerEnv } from "../worker/env.js";
import { createTestD1 } from "./stubs/d1.js";
import { category, fakeApis, groups, month, PLAN_ID, scheduled, txn } from "./stubs/ynab-api.js";

const NOW = new Date("2026-10-18T03:00:00Z");

function setup(overrides: Partial<WorkerEnv> = {}) {
  const dining = category({ id: "c-dining", name: "Dining Out" });
  const rent = category({ id: "c-rent", name: "Rent", balance: 30_000, goal_under_funded: 150_000 });
  const apis = fakeApis({
    transactions: [
      ...[1, 2, 3].map((day) => txn({ date: `2026-09-0${day}`, category_id: "c-dining", approved: true })),
      txn({ id: "pending-coffee", date: "2026-10-12", amount: -8_250 }),
    ],
    categoryGroups: groups([dining, rent]),
    month: month({ to_be_budgeted: 100_000, categories: [dining, rent] }),
    scheduled: [scheduled({ id: "rent-bill", category_id: "c-rent", date_next: "2026-10-20", amount: -80_000 })],
  });
  const env: WorkerEnv = {
    YNAB_API_TOKEN: "test-token",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    ALLOWED_GITHUB_LOGIN: "someone",
    YNAB_PLAN_ID: PLAN_ID,
    AUTOBUDGET_DB: createTestD1(),
    AUTOBUDGET_MODE: "shadow",
    AUTOBUDGET_TIMEZONE: "UTC",
    ...overrides,
  };

  const registered = new Map<string, { config: Record<string, any>; callback: (input: any) => Promise<any> }>();
  const server: ToolRegistrar = {
    registerTool(name, config, callback) {
      registered.set(name, { config, callback });
    },
  };
  registerTools(server, {} as ynab.API, autobudgetTools(env, { fetch: apis.fetch, now: NOW }), { readOnly: true });
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await registered.get(name)!.callback(input);
    return { ...result, body: JSON.parse(result.content[0].text) };
  };
  return { apis, registered, call };
}

describe("auto-budget tools", () => {
  it("are all available in read-only mode with accurate state-change annotations", () => {
    const { registered } = setup();
    expect([...registered.keys()]).toEqual(["ynab_autobudget_status", "ynab_autobudget_plan", "ynab_autobudget_pause"]);
    expect(registered.get("ynab_autobudget_status")!.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(registered.get("ynab_autobudget_plan")!.config.annotations).toMatchObject({ readOnlyHint: false });
    expect(registered.get("ynab_autobudget_pause")!.config.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false });
  });

  it("describe every input field", () => {
    for (const entry of autobudgetTools({} as WorkerEnv)) {
      for (const [field, schema] of Object.entries(entry.module.inputSchema)) {
        expect((schema as { description?: string }).description, `${entry.module.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("status reports the mode, the pause state and the caps", async () => {
    const { call } = setup();
    const { body } = await call("ynab_autobudget_status");
    expect(body).toMatchObject({
      success: true,
      mode: "shadow",
      requestedMode: "shadow",
      paused: null,
      lastRun: null,
      notifierConfigured: false,
      caps: { perTransaction: 250, dailyAssignCeiling: 5000, rowsPerRun: 25, categoriesPerRun: 10 },
    });
  });

  it("reports an unrecognized mode as off with the reason", async () => {
    const { body } = await setup({ AUTOBUDGET_MODE: "live" }).call("ynab_autobudget_status");
    expect(body).toMatchObject({
      success: true,
      mode: "off",
      requestedMode: "off",
      modeReason: 'unrecognized AUTOBUDGET_MODE "live", treated as off',
    });
  });

  it("pause stops the service until it is resumed", async () => {
    const { call } = setup();
    expect((await call("ynab_autobudget_pause", { reason: "checking something" })).body).toEqual({ success: true, paused: true, reason: "checking something" });
    expect((await call("ynab_autobudget_status")).body.paused).toEqual({ since: NOW.toISOString(), reason: "checking something" });

    expect((await call("ynab_autobudget_pause", { paused: false })).body).toEqual({ success: true, paused: false });
    expect((await call("ynab_autobudget_status")).body.paused).toBeNull();
  });

  it("plan shows what would happen right now, in plain currency", async () => {
    const { call, apis } = setup();
    const { body, isError } = await call("ynab_autobudget_plan");
    expect(isError).toBeUndefined();
    expect(body).toMatchObject({
      success: true,
      mode: "shadow",
      summary: { "categorize.would_categorize": 1, "approve.would_approve": 1, "assign.would_assign": 1 },
      transactions_total: 2,
      assign: { month: "2026-10-01", ready_to_assign: 100, cap: 100, remaining_after: 0, next_month: null },
      alerts: {
        immediate: [],
        on_pace_to_overspend: [],
        bills_due: [{
          scheduled_id: "rent-bill",
          payee: "Power Company",
          category: "Rent",
          due: "2026-10-20",
          amount: 80,
          available: 30,
        }],
        backlog: { unapproved: 1, uncategorized: 1, oldest: "2026-10-12" },
      },
    });
    expect(body.transactions[0]).toMatchObject({
      transaction_id: "pending-coffee",
      stage: "categorize",
      action: "would_categorize",
      amount: -8.25,
      category: "Dining Out",
    });
    expect(body.assign.this_month).toEqual([{
      categoryId: "c-rent",
      name: "Rent",
      currentBudgeted: 100,
      assign: 100,
      newBudgeted: 200,
      shortfallRemaining: 50,
    }]);
    expect(apis.requests.every((r) => r.method === "GET" && r.body === null)).toBe(true);
    expect(apis.requests.some((r) => r.url.endsWith("/scheduled_transactions"))).toBe(true);
  });

  it("plan lists at most `limit` transaction decisions", async () => {
    const { body } = await setup().call("ynab_autobudget_plan", { limit: 1 });
    expect(body.transactions).toHaveLength(1);
    expect(body).toMatchObject({ transactions_listed: 1, transactions_total: 2 });
  });

  it("report failures as errors", async () => {
    const { call } = setup({ YNAB_PLAN_ID: "22222222-2222-4222-8222-222222222222" });
    const result = await call("ynab_autobudget_plan");
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("is not one of the plans this YNAB token can access");
  });
});
