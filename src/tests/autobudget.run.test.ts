import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_CALLS_PER_RUN, readConfig } from "../worker/autobudget/config.js";
import { dryRun, runAutobudget, setPaused, status } from "../worker/autobudget/run.js";
import { Store } from "../worker/autobudget/store.js";
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

  it("never sends YNAB anything but GET requests, in any mode", async () => {
    for (const mode of ["shadow", "live"]) {
      const db = createTestD1();
      const apis = scenario();
      await runAutobudget(makeEnv(db, { AUTOBUDGET_MODE: mode }), { fetch: apis.fetch, now: DIGEST_TIME });
      await dryRun(makeEnv(db, { AUTOBUDGET_MODE: mode }), { fetch: apis.fetch, now: DIGEST_TIME });
      const ynab = ynabRequests(apis.requests);
      expect(ynab.length).toBeGreaterThan(0);
      expect(ynab.every((r) => r.method === "GET" && r.body === null)).toBe(true);
    }
  });

  it("stays within its per-run YNAB request budget", async () => {
    const apis = scenario();
    const outcome = await runAutobudget(makeEnv(createTestD1()), { fetch: apis.fetch, now: DIGEST_TIME });
    expect(outcome).toMatchObject({ ran: true, outcome: "ok" });
    expect(ynabRequests(apis.requests).length).toBeLessThanOrEqual(MAX_CALLS_PER_RUN);
  });

  it("treats YNAB_READ_ONLY as a hard stop: live is forced to shadow", async () => {
    const db = createTestD1();
    const apis = scenario();
    const env = makeEnv(db, { AUTOBUDGET_MODE: "live", YNAB_READ_ONLY: "true" });

    expect(readConfig(env)).toMatchObject({ requestedMode: "live", mode: "shadow", readOnly: true });
    expect(readConfig(env).modeReason).toContain("YNAB_READ_ONLY");
    expect(await runAutobudget(env, { fetch: apis.fetch, now: NIGHT })).toMatchObject({ ran: true, mode: "shadow" });
    expect(ynabRequests(apis.requests).every((r) => r.method === "GET")).toBe(true);
    expect(await status(env, NIGHT)).toMatchObject({ mode: "shadow", requestedMode: "live", readOnly: true });
  });

  it("runs live as shadow even without read-only, since this version has no write stage", () => {
    const config = readConfig(makeEnv(createTestD1(), { AUTOBUDGET_MODE: "live" }));
    expect(config).toMatchObject({ mode: "shadow", modeReason: "this version has no write stages, so live runs as shadow" });
  });

  it.each([
    ["the mode is off", { AUTOBUDGET_MODE: undefined }, "AUTOBUDGET_MODE is off"],
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

  it("holds a lease so overlapping runs cannot interleave, and releases it", async () => {
    const db = createTestD1();
    const apis = scenario();
    const store = new Store(db, PLAN_ID);

    expect(await store.acquireLease(NIGHT, 60_000)).toBe(true);
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).toEqual({ ran: false, reason: "another run holds the lease" });
    await expect(dryRun(makeEnv(db), { fetch: apis.fetch, now: NIGHT })).rejects.toThrow("in progress");

    // An expired lease does not block.
    const later = new Date(NIGHT.getTime() + 120_000);
    expect(await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: later })).toMatchObject({ ran: true });
    expect(await store.getState("lease")).toBeNull();
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

  it("re-alerts a bank import that breaks again after being fixed", async () => {
    const db = createTestD1();
    const apis = scenario();
    apis.state.month = month({ categories: [dining] });
    const broken = account({ direct_import_in_error: true });

    apis.state.accounts = [broken];
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    apis.state.accounts = [account({ direct_import_in_error: false })];
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });
    apis.state.accounts = [broken];
    await runAutobudget(makeEnv(db), { fetch: apis.fetch, now: NIGHT });

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

  it("explains a configured plan the token cannot see", async () => {
    const env = makeEnv(createTestD1(), { YNAB_PLAN_ID: "22222222-2222-4222-8222-222222222222" });
    await expect(dryRun(env, { fetch: scenario().fetch, now: NIGHT })).rejects.toThrow("Plans it can access");
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

  it("has no way to send anything but GET", () => {
    expect(Object.getOwnPropertyNames(YnabReader.prototype).sort()).toEqual(["constructor", "get"]);
  });
});

describe("the service source", () => {
  const dir = fileURLToPath(new URL("../worker/autobudget/", import.meta.url));
  const sources = readdirSync(dir).filter((file) => file.endsWith(".ts")).map((file) => ({ file, text: readFileSync(`${dir}${file}`, "utf8") }));

  it("imports the YNAB SDK for types only, so it cannot call a write method", () => {
    for (const { file, text } of sources) {
      for (const line of text.split("\n").filter((l) => /from "ynab"/.test(l))) {
        expect(line, file).toMatch(/^import type /);
      }
    }
  });

  it("calls fetch only in the GET-only YNAB reader and the Pushover sender", () => {
    const callers = sources.filter(({ text }) => /\bfetchImpl\(|\bfetch\(/.test(text)).map(({ file }) => file).sort();
    expect(callers).toEqual(["pushover.ts", "ynab.ts"]);
    const ynabSource = sources.find(({ file }) => file === "ynab.ts")!.text;
    expect(ynabSource.match(/method: "[A-Z]+"/g)).toEqual(['method: "GET"']);
  });
});
