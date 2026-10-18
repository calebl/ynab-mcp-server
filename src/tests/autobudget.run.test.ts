import { describe, expect, it } from "vitest";

import { paceAlerts } from "../worker/autobudget/alerts.js";
import { MAX_CALLS_PER_RUN, readConfig } from "../worker/autobudget/config.js";
import { dryRun, runAutobudget, setPaused, status } from "../worker/autobudget/run.js";
import { Store } from "../worker/autobudget/store.js";
import { toStoredAccount, toStoredTransaction } from "../worker/autobudget/sync.js";
import { YnabReader, YnabRequestError } from "../worker/autobudget/ynab.js";
import type { WorkerEnv } from "../worker/env.js";
import { createTestD1 } from "./stubs/d1.js";
import { account, category, fakeApis, groups, month, PLAN_ID, txn, type RecordedRequest } from "./stubs/ynab-api.js";

const NIGHT = new Date("2026-10-18T03:00:00Z");
const DIGEST_TIME = new Date("2026-10-18T08:05:00Z");

const dining = category({ id: "c-dining", name: "Dining Out", goal_under_funded: 0 });
const rent = category({ id: "c-rent", name: "Rent", goal_under_funded: 150_000 });
const overspent = category({ id: "c-fun", name: "Fun Money", balance: -20_000 });

/** Three approved coffee purchases establish a payee rule; one pending purchase waits. */
function scenario() {
  const history = [1, 2, 3].map((day) =>
    txn({ id: `hist-${day}`, date: `2026-09-0${day}`, category_id: "c-dining", approved: true }));
  const pending = txn({ id: "pending-coffee", date: "2026-10-12", amount: -8_000 });
  return fakeApis({
    transactions: [...history, pending],
    categoryGroups: groups([dining, rent, overspent]),
    month: month({ to_be_budgeted: 100_000, categories: [dining, rent, overspent] }),
  });
}

function makeEnv(db: D1Database, overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    YNAB_API_TOKEN: "test-token",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    ALLOWED_GITHUB_LOGIN: "someone",
    YNAB_PLAN_ID: PLAN_ID,
    AUTOBUDGET_DB: db,
    AUTOBUDGET_MODE: "shadow",
    AUTOBUDGET_TIMEZONE: "UTC",
    AUTOBUDGET_DIGEST_HOUR: "8",
    PUSHOVER_APP_TOKEN: "app-token",
    PUSHOVER_USER_KEY: "user-key",
    ...overrides,
  };
}

const ynabRequests = (requests: RecordedRequest[]) => requests.filter((r) => r.url.startsWith("https://api.ynab.com/"));
const pushes = (requests: RecordedRequest[]) => requests.filter((r) => r.url.startsWith("https://api.pushover.net/"));
const pushParams = (request: RecordedRequest) => new URLSearchParams(request.body ?? "");

function decisionRows(db: ReturnType<typeof createTestD1>) {
  return db.sqlite.prepare("SELECT stage, subject_id, action, reason FROM decision ORDER BY id").all() as Array<Record<string, string>>;
}

function controllableBatchFailure(db: D1Database): { binding: D1Database; failNextBatch: () => void } {
  let failNext = false;
  const binding = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (failNext) {
            failNext = false;
            throw new Error("injected D1 persistence failure");
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { binding, failNextBatch: () => { failNext = true; } };
}

describe("runAutobudget", () => {
  it("reads the history window first, then asks YNAB only for what changed", async () => {
    const db = createTestD1();
    const apis = scenario();

    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    const first = ynabRequests(apis.requests).find((r) => r.url.includes("/transactions"))!;
    expect(new URL(first.url).searchParams.get("since_date")).toBe("2025-10-01");

    apis.requests.length = 0;
    apis.state.delta = [txn({ id: "pending-coffee", date: "2026-10-12", amount: -8_000, category_id: "c-dining" })];
    const outcome = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    const second = ynabRequests(apis.requests).find((r) => r.url.includes("/transactions"))!;
    expect(new URL(second.url).searchParams.get("last_knowledge_of_server")).toBe("100");
    expect(outcome).toMatchObject({ ran: true, outcome: "ok", synced: 1 });

    const mirrored = db.sqlite.prepare("SELECT category_id FROM txn WHERE id = 'pending-coffee'").get() as { category_id: string };
    expect(mirrored.category_id).toBe("c-dining");
  });

  it("records shadow decisions in the audit log, and again only when they change", async () => {
    const db = createTestD1();
    const apis = scenario();

    const first = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(first).toMatchObject({
      ran: true,
      mode: "shadow",
      decisions: { "categorize.would_categorize": 1, "approve.would_approve": 1, "assign.would_assign": 1 },
      recorded: 3,
    });
    expect(decisionRows(db)).toEqual([
      { stage: "categorize", subject_id: "pending-coffee", action: "would_categorize", reason: null },
      { stage: "approve", subject_id: "pending-coffee", action: "would_approve", reason: null },
      { stage: "assign", subject_id: "2026-10-01:c-rent", action: "would_assign", reason: null },
    ]);

    const repeat = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(repeat).toMatchObject({ recorded: 0 });

    // The owner approves it in YNAB: the row is no longer pending, and the
    // assignment is unchanged, so nothing new is recorded.
    apis.state.delta = [txn({ id: "pending-coffee", date: "2026-10-12", amount: -8_000, category_id: "c-dining", approved: true })];
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).toMatchObject({ recorded: 0, decisions: { "assign.would_assign": 1 } });

    const run = db.sqlite.prepare("SELECT outcome, mode, calls_used FROM run ORDER BY started_at LIMIT 1").get();
    expect(run).toMatchObject({ outcome: "ok", mode: "shadow" });
  });

  it("uses the explicit month containing today in the configured timezone", async () => {
    const apis = scenario();
    const now = new Date("2026-11-01T00:30:00Z");

    const result = await dryRun(makeEnv(createTestD1(), {
      AUTOBUDGET_TIMEZONE: "America/Los_Angeles",
    }), { fetch: apis.fetch, now });

    expect(result.evaluation.today).toBe("2026-10-31");
    expect(result.evaluation.month.month).toBe("2026-10-01");
    expect(ynabRequests(apis.requests).some((request) => request.url.endsWith("/months/2026-10-01"))).toBe(true);
    expect(ynabRequests(apis.requests).some((request) => request.url.endsWith("/months/current"))).toBe(false);
  });

  it("funds next month's targets with what this month's leave over, fetching next month only then", async () => {
    const db = createTestD1();
    const apis = scenario();
    apis.state.month = month({ to_be_budgeted: 300_000, categories: [dining, rent, overspent] });
    apis.state.nextMonth = month({ month: "2026-11-01", categories: [category({ id: "c-rent", name: "Rent", goal_under_funded: 150_000 })] });

    const outcome = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(outcome).toMatchObject({ decisions: { "assign.would_assign": 1, "assign.would_fund_next_month": 1 } });
    expect(ynabRequests(apis.requests).some((r) => r.url.endsWith("/months/2026-11-01"))).toBe(true);

    const lean = scenario();
    await runAutobudget(makeEnv(createTestD1()), { fetch: lean.fetch, now: NIGHT });
    expect(ynabRequests(lean.requests).some((r) => r.url.endsWith("/months/2026-11-01"))).toBe(false);
  });

  it("never sends YNAB anything but GET requests", async () => {
    const db = createTestD1();
    const apis = scenario();
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: DIGEST_TIME });
    await dryRun(makeEnv(db), { fetch: apis.fetch, now: DIGEST_TIME });
    const ynab = ynabRequests(apis.requests);
    expect(ynab.length).toBeGreaterThan(0);
    expect(ynab.every((r) => r.method === "GET" && r.body === null)).toBe(true);
  });

  it("stays within its per-run YNAB request budget", async () => {
    const apis = scenario();
    const outcome = await runAutobudget(makeEnv(createTestD1()), { fetch: apis.fetch, now: DIGEST_TIME });
    expect(outcome).toMatchObject({ ran: true, outcome: "ok" });
    expect(ynabRequests(apis.requests).length).toBeLessThanOrEqual(MAX_CALLS_PER_RUN);
  });

  it("stays in shadow mode when YNAB_READ_ONLY is set", async () => {
    const db = createTestD1();
    const apis = scenario();
    const env = makeEnv(db, { YNAB_READ_ONLY: "true" });

    expect(readConfig(env)).toMatchObject({ requestedMode: "shadow", mode: "shadow", readOnly: true });
    expect(await runAutobudget(env, { fetch: apis.fetch, now: NIGHT })).toMatchObject({ ran: true, mode: "shadow" });
    expect(ynabRequests(apis.requests).every((r) => r.method === "GET")).toBe(true);
    expect(await status(env, NIGHT)).toMatchObject({ mode: "shadow", requestedMode: "shadow", readOnly: true });
  });

  it.each([
    ["the mode is off", { AUTOBUDGET_MODE: undefined }, "AUTOBUDGET_MODE is off"],
    ["the former live mode is rejected", { AUTOBUDGET_MODE: "live" }, 'unrecognized AUTOBUDGET_MODE "live", treated as off'],
    ["the mode is unrecognized", { AUTOBUDGET_MODE: "yes" }, 'unrecognized AUTOBUDGET_MODE "yes", treated as off'],
    ["no database is bound", { AUTOBUDGET_DB: undefined }, "AUTOBUDGET_DB is not bound"],
    ["no plan is configured", { YNAB_PLAN_ID: undefined }, "YNAB_PLAN_ID is not set"],
  ])("does nothing when %s", async (_label, overrides, reason) => {
    const apis = scenario();
    const outcome = await runAutobudget(makeEnv(createTestD1(), overrides as Partial<WorkerEnv>), { fetch: apis.fetch, now: NIGHT });
    expect(outcome).toEqual({ ran: false, reason });
    expect(apis.requests).toEqual([]);
  });

  it("skips every scheduled run while paused, and resumes", async () => {
    const db = createTestD1();
    const apis = scenario();
    const env = makeEnv(db);

    await setPaused(env, true, "on vacation", NIGHT);
    expect(await runAutobudget(env, { fetch: apis.fetch, now: NIGHT })).toEqual({ ran: false, reason: "paused" });
    expect(apis.requests).toEqual([]);
    expect((await status(env, NIGHT)).paused).toEqual({ since: NIGHT.toISOString(), reason: "on vacation" });

    await setPaused(env, false, undefined, NIGHT);
    expect(await runAutobudget(env, { fetch: apis.fetch, now: NIGHT })).toMatchObject({ ran: true, outcome: "ok" });
  });

  it("holds an owned lease so overlapping runs cannot interleave", async () => {
    const db = createTestD1();
    const apis = scenario();
    const store = new Store(db, PLAN_ID);

    expect(await store.acquireLease("owner-a", NIGHT, 60_000)).toBe(true);
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).toEqual({ ran: false, reason: "another run holds the lease" });
    await expect(dryRun(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).rejects.toThrow("in progress");

    const later = new Date(NIGHT.getTime() + 120_000);
    expect(await store.acquireLease("owner-b", later, 60_000)).toBe(true);
    await store.releaseLease("owner-a");
    expect(await store.acquireLease("owner-c", later, 60_000)).toBe(false);
    await store.releaseLease("owner-b");
    expect(await store.getState("lease")).toBeNull();
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: later })).toMatchObject({ ran: true });
  });

  it("reports a configured plan the token cannot see, naming the plans it can, and alerts once", async () => {
    const db = createTestD1();
    const apis = scenario();
    const env = makeEnv(db, { YNAB_PLAN_ID: "22222222-2222-4222-8222-222222222222" });

    const outcome = await runAutobudget(env, { fetch: apis.fetch, now: NIGHT });
    expect(outcome).toMatchObject({ ran: true, outcome: "plan_not_visible" });
    const error = (outcome as { error: string }).error;
    expect(error).toContain("is not one of the plans this YNAB token can access");
    expect(error).toContain(`"Household" (${PLAN_ID})`);
    expect(pushes(apis.requests)).toHaveLength(1);
    expect(pushParams(pushes(apis.requests)[0]).get("title")).toBe("Auto-budget cannot see its plan");

    await runAutobudget(env, { fetch: apis.fetch, now: NIGHT });
    expect(pushes(apis.requests)).toHaveLength(1);
    expect((await status(env, NIGHT)).lastRun).toMatchObject({ outcome: "plan_not_visible" });
  });

  it("clears plan visibility recovery before transaction persistence", async () => {
    const db = createTestD1();
    const apis = scenario();
    const configuredPlan = "22222222-2222-4222-8222-222222222222";
    const failure = controllableBatchFailure(db);
    const env = makeEnv(failure.binding, { YNAB_PLAN_ID: configuredPlan });
    let visible = false;
    const fetchWithChangingVisibility = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return apis.fetch(visible ? url.replace(configuredPlan, PLAN_ID) : url, init);
    }) as typeof fetch;

    await runAutobudget(env, { fetch: fetchWithChangingVisibility, now: NIGHT });
    visible = true;
    failure.failNextBatch();
    expect(await runAutobudget(env, { fetch: fetchWithChangingVisibility, now: NIGHT }))
      .toMatchObject({ outcome: "error", error: "injected D1 persistence failure" });
    visible = false;
    await runAutobudget(env, { fetch: fetchWithChangingVisibility, now: NIGHT });

    expect(pushes(apis.requests).map((request) => pushParams(request).get("title"))).toEqual([
      "Auto-budget cannot see its plan",
      "Auto-budget cannot see its plan",
    ]);
  });

  it("records a rate-limited run without failing the Worker", async () => {
    const apis = scenario();
    apis.state.failures = { "/transactions": 429 };
    expect(await runAutobudget(makeEnv(createTestD1()), { fetch: apis.fetch, now: NIGHT }))
      .toMatchObject({ ran: true, outcome: "rate_limited", error: "YNAB 429: Too many requests" });
  });

  it("sends each immediate alert once per period through Pushover", async () => {
    const db = createTestD1();
    const apis = scenario();

    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(pushes(apis.requests)).toHaveLength(1);
    const params = pushParams(pushes(apis.requests)[0]);
    expect(params.get("token")).toBe("app-token");
    expect(params.get("user")).toBe("user-key");
    expect(params.get("title")).toBe("Fun Money is overspent");

    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(pushes(apis.requests)).toHaveLength(1);
  });

  it("clears repaired import alerts before account persistence", async () => {
    const db = createTestD1();
    const apis = scenario();
    apis.state.month = month({ categories: [dining] });
    const broken = account({ direct_import_in_error: true });
    const failure = controllableBatchFailure(db);

    apis.state.accounts = [broken];
    await runAutobudget(makeEnv(failure.binding), { fetch: apis.fetch, now: NIGHT });
    failure.failNextBatch();
    apis.state.accounts = [account({ direct_import_in_error: false })];
    expect(await runAutobudget(makeEnv(failure.binding), { fetch: apis.fetch, now: NIGHT }))
      .toMatchObject({ outcome: "error", error: "injected D1 persistence failure" });
    apis.state.accounts = [broken];
    await runAutobudget(makeEnv(failure.binding), { fetch: apis.fetch, now: NIGHT });

    expect(pushes(apis.requests).map((r) => pushParams(r).get("title"))).toEqual([
      "Bank import broken: Checking",
      "Bank import broken: Checking",
    ]);
  });

  it("keeps alerts pending while Pushover is not configured or failing", async () => {
    const db = createTestD1();
    const apis = scenario();

    const unconfigured = await runAutobudget(makeEnv(db, { PUSHOVER_APP_TOKEN: undefined }), { fetch: apis.fetch, now: NIGHT });
    expect(unconfigured).toMatchObject({ alertsSent: 0, notifier: "not_configured" });
    expect(pushes(apis.requests)).toEqual([]);

    apis.state.pushoverStatus = 500;
    const failing = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(failing).toMatchObject({ outcome: "ok", alertsSent: 0, notifier: "failed: Pushover returned HTTP 500" });

    apis.state.pushoverStatus = 200;
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).toMatchObject({ alertsSent: 1 });
  });

  it("marks only immediate-alert batches that Pushover delivered", async () => {
    const db = createTestD1();
    const apis = scenario();
    const categories = Array.from({ length: 40 }, (_, index) => category({
      id: `overspent-${index}`,
      name: `Long overspent category ${index}`,
      balance: -20_000,
    }));
    apis.state.categoryGroups = groups(categories);
    apis.state.month = month({ categories });

    const failSecondPush = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === "api.pushover.net") {
        apis.state.pushoverStatus = pushes(apis.requests).length === 0 ? 200 : 500;
      }
      return apis.fetch(input, init);
    }) as typeof fetch;

    const first = await runAutobudget(makeEnv(db), { fetch: failSecondPush, now: NIGHT });
    const markedAfterFailure = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM alert").get() as { n: number }).n;
    expect(first).toMatchObject({ outcome: "ok", alertsSent: markedAfterFailure, notifier: "failed: Pushover returned HTTP 500" });
    expect(markedAfterFailure).toBeGreaterThan(0);
    expect(markedAfterFailure).toBeLessThan(categories.length);
    expect(pushes(apis.requests).every((request) => (pushParams(request).get("message")?.length ?? 0) <= 1024)).toBe(true);

    apis.state.pushoverStatus = 200;
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM alert").get()).toEqual({ n: categories.length });
  });

  it("does not build an undeliverable digest and still runs daily retention", async () => {
    const db = createTestD1();
    const store = new Store(db, PLAN_ID);
    const old = new Date("2025-01-01T00:00:00Z");
    await store.startRun("old-run", "shadow", old);
    await store.recordDecisions("old-run", "shadow", [{
      stage: "assign",
      subjectId: "old",
      action: "would_assign",
      reason: null,
      source: null,
      detail: {},
    }], old);
    await store.markAlertsSent([{ rule: "overspent", subjectId: "old", period: "2025-01" }], old);

    const apis = scenario();
    const outcome = await runAutobudget(makeEnv(db, { PUSHOVER_APP_TOKEN: undefined }), {
      fetch: apis.fetch,
      now: DIGEST_TIME,
    });

    expect(outcome).toMatchObject({ digest: "not_configured" });
    expect(ynabRequests(apis.requests).some((request) => request.url.includes("/scheduled_transactions"))).toBe(false);
    expect(pushes(apis.requests)).toEqual([]);
    expect(db.sqlite.prepare("SELECT id FROM run WHERE id = 'old-run'").get()).toBeUndefined();
    expect(db.sqlite.prepare("SELECT subject_id FROM decision WHERE subject_id = 'old'").get()).toBeUndefined();
    expect(db.sqlite.prepare("SELECT subject_id FROM alert WHERE subject_id = 'old'").get()).toBeUndefined();
    expect(await store.getState("last_prune")).toBe("2026-10-18");
  });

  it.each(["scheduled read", "delivery"])("retries the daily digest after a failed %s", async (failure) => {
    const db = createTestD1();
    const apis = scenario();
    apis.state.month = month({ categories: [dining, rent] });
    if (failure === "scheduled read") apis.state.failures = { "/scheduled_transactions": 500 };
    else apis.state.pushoverStatus = 500;

    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: DIGEST_TIME }))
      .toMatchObject({ digest: expect.stringContaining("failed:") });
    expect(await new Store(db, PLAN_ID).getState("last_digest")).toBeNull();

    apis.state.failures = {};
    apis.state.pushoverStatus = 200;
    const later = new Date("2026-10-18T09:05:00Z");
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: later })).toMatchObject({ digest: "sent" });
    expect(await new Store(db, PLAN_ID).getState("last_digest")).toBe("2026-10-18");
  });

  it("sends the daily digest once, in the digest hour", async () => {
    const db = createTestD1();
    const apis = scenario();
    apis.state.month = month({ to_be_budgeted: 100_000, categories: [dining, rent] });

    const night = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(night).toMatchObject({ digest: "not_due" });
    expect(ynabRequests(apis.requests).some((r) => r.url.includes("/scheduled_transactions"))).toBe(false);

    const morning = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: DIGEST_TIME });
    expect(morning).toMatchObject({ digest: "sent" });
    const [digest] = pushes(apis.requests);
    expect(pushParams(digest).get("title")).toBe("Budget digest for 2026-10-18");
    // Ready to Assign ($100) caps the $150 Rent shortfall.
    expect(pushParams(digest).get("message")).toContain("Would categorize 1, approve 1, assign $100.00 to 1 category");

    const again = await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: new Date("2026-10-18T08:40:00Z") });
    expect(again).toMatchObject({ digest: "not_due" });
    expect(pushes(apis.requests)).toHaveLength(1);
  });

  it("keeps notifier credentials out of the run record", async () => {
    const db = createTestD1();
    await runAutobudget(makeEnv(db), { fetch: scenario().fetch, now: DIGEST_TIME });
    const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM run").all())
      + JSON.stringify(db.sqlite.prepare("SELECT * FROM state").all());
    expect(stored).not.toContain("app-token");
    expect(stored).not.toContain("user-key");
    expect(stored).not.toContain("test-token");
  });
});

describe("dryRun", () => {
  it("shows the decisions without recording them or notifying", async () => {
    const db = createTestD1();
    const apis = scenario();
    const run = await dryRun(makeEnv(db, { AUTOBUDGET_MODE: undefined }), { fetch: apis.fetch, now: DIGEST_TIME });

    expect(run).toMatchObject({ mode: "off", paused: false });
    expect(run.evaluation.decisions.map((d) => d.action)).toEqual(["would_categorize", "would_approve", "would_assign"]);
    expect(decisionRows(db)).toEqual([]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
    expect(pushes(apis.requests)).toEqual([]);
  });

  it("refreshes the plan currency settings on every evaluation", async () => {
    const db = createTestD1();
    const apis = scenario();

    expect((await dryRun(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).evaluation.currency).toEqual({ isoCode: "USD", decimalDigits: 2 });
    apis.state.currencyFormat = { iso_code: "KWD", decimal_digits: 3 };
    expect((await dryRun(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).evaluation.currency).toEqual({ isoCode: "KWD", decimalDigits: 3 });
    expect(ynabRequests(apis.requests).filter((request) => request.url.endsWith("/settings"))).toHaveLength(2);
  });

  it("explains a configured plan the token cannot see", async () => {
    const env = makeEnv(createTestD1(), { YNAB_PLAN_ID: "22222222-2222-4222-8222-222222222222" });
    await expect(dryRun(env, { fetch: scenario().fetch, now: NIGHT })).rejects.toThrow("Plans it can access");
  });

  it("records a recovery it syncs, so a break after a dry run still alerts", async () => {
    const db = createTestD1();
    const apis = scenario();
    apis.state.month = month({ categories: [dining] });
    const titles = () => pushes(apis.requests).map((r) => pushParams(r).get("title"));

    apis.state.accounts = [account({ direct_import_in_error: true })];
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    expect(titles()).toEqual(["Bank import broken: Checking"]);

    // The link is repaired; only a dry run sees it before it breaks again.
    apis.state.accounts = [account({ direct_import_in_error: false })];
    await dryRun(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    apis.state.accounts = [account({ direct_import_in_error: true })];
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });

    expect(titles()).toEqual(["Bank import broken: Checking", "Bank import broken: Checking"]);
  });
});

describe("Store", () => {
  it("isolates every service record by plan", async () => {
    const db = createTestD1();
    const first = new Store(db, "plan-a");
    const second = new Store(db, "plan-b");
    const now = new Date("2026-10-18T00:00:00Z");
    const decision = {
      stage: "assign" as const,
      subjectId: "shared-subject",
      action: "would_assign" as const,
      reason: null,
      source: null,
      detail: { amount: 10 },
    };
    const alert = { rule: "overspent", subjectId: "shared-subject", period: "open" };

    await first.setState("last_digest", "first", now);
    await second.setState("last_digest", "second", now);
    await first.setCursor("transactions", 1, now);
    await second.setCursor("transactions", 2, now);
    await first.upsertTransactions([toStoredTransaction(txn({ id: "shared-txn", category_id: "first" }))]);
    await second.upsertTransactions([toStoredTransaction(txn({ id: "shared-txn", category_id: "second" }))]);
    await first.upsertAccounts([toStoredAccount(account({ id: "shared-account", name: "First" }))]);
    await second.upsertAccounts([toStoredAccount(account({ id: "shared-account", name: "Second" }))]);
    await first.startRun("shared-run", "shadow", now);
    await second.startRun("shared-run", "shadow", now);
    await first.finishRun("shared-run", now, "first", null, 1, {});
    await second.finishRun("shared-run", now, "second", null, 2, {});
    expect(await first.recordDecisions("shared-run", "shadow", [decision], now)).toBe(1);
    expect(await second.recordDecisions("shared-run", "shadow", [decision], now)).toBe(1);
    await first.markAlertsSent([alert], now);
    await second.markAlertsSent([alert], now);

    expect(await first.getState("last_digest")).toBe("first");
    expect(await second.getState("last_digest")).toBe("second");
    expect(await first.getCursor("transactions")).toBe(1);
    expect(await second.getCursor("transactions")).toBe(2);
    expect(db.sqlite.prepare("SELECT plan_id, category_id FROM txn WHERE id = 'shared-txn' ORDER BY plan_id").all()).toEqual([
      { plan_id: "plan-a", category_id: "first" },
      { plan_id: "plan-b", category_id: "second" },
    ]);
    expect(db.sqlite.prepare("SELECT plan_id, name FROM account WHERE id = 'shared-account' ORDER BY plan_id").all()).toEqual([
      { plan_id: "plan-a", name: "First" },
      { plan_id: "plan-b", name: "Second" },
    ]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM run WHERE id = 'shared-run'").get()).toEqual({ n: 2 });
    expect(await first.lastRun()).toMatchObject({ outcome: "first", calls_used: 1 });
    expect(await second.lastRun()).toMatchObject({ outcome: "second", calls_used: 2 });
    expect(await first.recordDecisions("shared-run", "shadow", [decision], now)).toBe(0);
    expect(await second.recordDecisions("shared-run", "shadow", [decision], now)).toBe(0);

    await first.clearOpenAlerts("overspent", []);
    expect(await first.sentAlerts()).toEqual(new Set());
    expect(await second.sentAlerts()).toEqual(new Set(["overspent|shared-subject|open"]));
  });

  it("keeps split-category outflows in the mirror for pace detection", async () => {
    const store = new Store(createTestD1(), PLAN_ID);
    const rows = Array.from({ length: 4 }, (_, index) => txn({
      id: `split-${index}`,
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      amount: -10_000,
      category_id: null,
      subtransactions: [{
        id: `split-part-${index}`,
        transaction_id: `split-${index}`,
        amount: -10_000,
        category_id: "c-groceries",
        deleted: false,
      }],
    }));

    await store.upsertTransactions(rows.map(toStoredTransaction));

    const counts = await store.outflowCounts("2026-10-01", "2026-10-15");
    expect(counts).toEqual(new Map([["c-groceries", 4]]));
    expect(paceAlerts(month({ categories: [category({
      id: "c-groceries",
      name: "Groceries",
      activity: -300_000,
      balance: 100_000,
    })] }), counts, "2026-10-15")).toHaveLength(1);
    expect((await store.pendingTransactions())[0].subtransactions[0]).toMatchObject({
      category_id: "c-groceries",
      amount: -10_000,
    });
  });

  it("excludes future transactions from history and pace counts", async () => {
    const store = new Store(createTestD1(), PLAN_ID);
    const rows = [
      txn({ id: "past", date: "2026-10-10", category_id: "c-dining", approved: true }),
      txn({ id: "future-1", date: "2026-10-20", category_id: "c-dining", approved: true }),
      txn({ id: "future-2", date: "2026-10-21", category_id: "c-dining", approved: true }),
      txn({
        id: "future-split",
        date: "2026-10-22",
        category_id: null,
        approved: true,
        subtransactions: [{
          id: "future-part",
          transaction_id: "future-split",
          amount: -10_000,
          category_id: "c-dining",
          deleted: false,
        }],
      }),
    ];
    await store.upsertTransactions(rows.map(toStoredTransaction));

    const history = await store.payeeHistory(["p-coffee"], "2025-10-01", "2026-10-15");
    expect(history.get("p-coffee")).toEqual({ categories: new Map([["c-dining", 1]]), approved: 1 });
    expect(await store.outflowCounts("2026-10-01", "2026-10-15")).toEqual(new Map([["c-dining", 1]]));
  });

  it("prunes periodic alerts but keeps open alerts until their condition clears", async () => {
    const db = createTestD1();
    const store = new Store(db, PLAN_ID);
    const old = new Date("2025-01-01T00:00:00Z");

    await store.markAlertsSent([
      { rule: "import_error", subjectId: "checking", period: "open" },
      { rule: "overspent", subjectId: "dining", period: "2025-01" },
    ], old);
    await store.prune(new Date("2026-01-01T00:00:00Z"), "2025-01-01");

    expect(await store.sentAlerts()).toEqual(new Set(["import_error|checking|open"]));

    await store.clearOpenAlerts("import_error", []);
    expect(await store.sentAlerts()).toEqual(new Set());
  });

  it("keeps the transaction mirror to the history window, but never drops rows still waiting on the owner", async () => {
    const db = createTestD1();
    const store = new Store(db, PLAN_ID);
    await store.upsertTransactions([
      txn({ id: "old-categorized", date: "2025-06-01", approved: true, category_id: "c-dining" }),
      txn({ id: "old-unapproved", date: "2025-06-01" }),
      txn({ id: "old-uncategorized", date: "2025-06-01", approved: true }),
      txn({ id: "old-transfer", date: "2025-06-01", approved: true, transfer_account_id: "other-account" }),
      txn({
        id: "old-split",
        date: "2025-06-01",
        approved: true,
        subtransactions: [{
          id: "old-split-part",
          transaction_id: "old-split",
          amount: -12_500,
          category_id: "c-dining",
          deleted: false,
        }],
      }),
      txn({ id: "recent-deleted", date: "2026-10-01", deleted: true }),
      txn({ id: "recent-approved", date: "2026-10-01", approved: true, category_id: "c-dining" }),
    ].map(toStoredTransaction));

    await store.prune(new Date("2025-01-01T00:00:00Z"), "2025-10-01");

    const ids = (db.sqlite.prepare("SELECT id FROM txn ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual(["old-unapproved", "old-uncategorized", "recent-approved"]);
    expect((await store.pendingTransactions()).map((row) => row.id)).toEqual(["old-unapproved", "old-uncategorized"]);
  });

  it("treats a same-amount row as a possible duplicate only within three days", async () => {
    const store = new Store(createTestD1(), PLAN_ID);
    await store.upsertTransactions([
      txn({ id: "near", date: "2026-10-10", amount: -5_000 }),
      txn({ id: "near-twin", date: "2026-10-13", amount: -5_000, approved: true }),
      txn({ id: "far", date: "2026-10-01", amount: -7_000 }),
      txn({ id: "far-twin", date: "2026-10-05", amount: -7_000, approved: true }),
    ].map(toStoredTransaction));

    expect(await store.possibleDuplicateIds()).toEqual(new Set(["near"]));
  });

  it("writes a large first sync in a few statements, well inside D1's per-run query limit", async () => {
    const db = createTestD1();
    const statements: number[] = [];
    const batch = db.batch.bind(db);
    db.batch = (async (list: D1PreparedStatement[]) => {
      statements.push(list.length);
      return batch(list);
    }) as typeof db.batch;
    const store = new Store(db, PLAN_ID);
    const rows = Array.from({ length: 20_001 }, (_, i) =>
      toStoredTransaction(txn({ id: `bulk-${i}`, date: "2026-09-15", approved: true, category_id: "c-dining" })));

    await store.upsertTransactions(rows);

    // A run makes roughly 20 other D1 queries, and the Free plan allows 50.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toBeLessThanOrEqual(15);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM txn").get()).toEqual({ n: 20_001 });
  });

  it("size-batches large backlog inputs into a handful of D1 queries", async () => {
    const db = createTestD1();
    const batchSizes: number[] = [];
    let historyQueries = 0;
    const batch = db.batch.bind(db);
    const prepare = db.prepare.bind(db);
    db.batch = (async (list: D1PreparedStatement[]) => {
      batchSizes.push(list.length);
      return batch(list);
    }) as typeof db.batch;
    db.prepare = ((sql: string) => {
      if (sql.includes("payee_id IN")) historyQueries++;
      return prepare(sql);
    }) as typeof db.prepare;
    const store = new Store(db, PLAN_ID);
    const count = 10_001;

    await store.upsertAccounts(Array.from({ length: count }, (_, i) =>
      toStoredAccount(account({ id: `account-${i}`, name: `Account ${i}` }))));
    expect(await store.payeeHistory(
      Array.from({ length: count }, (_, i) => `payee-${i}`),
      "2025-10-01",
      "2026-10-15",
    )).toEqual(new Map());
    const decisions = Array.from({ length: count * 2 }, (_, i) => ({
      stage: "categorize" as const,
      subjectId: `transaction-${i}`,
      action: "review" as const,
      reason: "new_payee",
      source: null,
      detail: { payee: `Payee ${i}` },
    }));
    expect(await store.recordDecisions("large-run", "shadow", decisions, NIGHT)).toBe(count * 2);

    expect(batchSizes).toHaveLength(2);
    expect(batchSizes.reduce((sum, size) => sum + size, historyQueries)).toBeLessThanOrEqual(15);
    expect(historyQueries).toBe(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM account").get()).toEqual({ n: count });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM decision").get()).toEqual({ n: count * 2 });
  });
});

describe("YnabReader", () => {
  it("refuses requests past its budget", async () => {
    const reader = new YnabReader("test-token", scenario().fetch, 1);
    await reader.get("/plans");
    await expect(reader.get("/plans")).rejects.toThrow("request budget of 1 YNAB calls per run is spent");
  });

  it("keeps the HTTP status on failures", async () => {
    const reader = new YnabReader("test-token", scenario().fetch);
    const error = await reader.get("/plans/unknown/transactions").catch((e) => e);
    expect(error).toBeInstanceOf(YnabRequestError);
    expect(error.status).toBe(404);
  });

});
