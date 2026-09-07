import { describe, it, expect } from "vitest";

import {
  buildNagEvent,
  getPendingWork,
  localDateParts,
  runNag,
  sinceDate,
  type NagConfig,
  type PendingWork,
} from "../worker/nag.js";
import type { WorkerEnv } from "../worker/env.js";

const config: NagConfig = {
  calendarId: "family@group.calendar.google.com",
  timeZone: "America/Los_Angeles",
  hour: 18,
  sinceDays: 30,
};

function pending(overrides: Partial<PendingWork> = {}): PendingWork {
  return { unapproved: 3, uncategorized: 1, total: 4, amount: -212.5, backlog: 0, ...overrides };
}

describe("localDateParts", () => {
  it("reports the local date and hour, not UTC", () => {
    // 2026-09-08T01:30Z is still the 7th at 18:30 in Los Angeles (UTC-7).
    const parts = localDateParts(new Date("2026-09-08T01:30:00Z"), "America/Los_Angeles");
    expect(parts).toEqual({ date: "2026-09-07", hour: 18 });
  });

  it("tracks the wall clock across the daylight saving boundary", () => {
    // After the November change Los Angeles is UTC-8, so the same wall-clock
    // hour sits an hour later in UTC.
    const summer = localDateParts(new Date("2026-09-08T01:00:00Z"), "America/Los_Angeles");
    const winter = localDateParts(new Date("2026-12-08T02:00:00Z"), "America/Los_Angeles");
    expect(summer.hour).toBe(18);
    expect(winter.hour).toBe(18);
  });

  it("normalises midnight to hour zero", () => {
    const parts = localDateParts(new Date("2026-09-07T07:00:00Z"), "America/Los_Angeles");
    expect(parts.hour).toBe(0);
    expect(parts.date).toBe("2026-09-07");
  });
});

describe("buildNagEvent", () => {
  it("stays silent when nothing is pending", () => {
    expect(buildNagEvent(pending({ total: 0 }), "2026-09-07", config)).toBeNull();
  });

  it("uses a date-derived id so re-runs update one event", () => {
    const event = buildNagEvent(pending(), "2026-09-07", config)!;
    expect(event.id).toBe("ncat20260907");
    // Google only accepts base32hex characters in an event id.
    expect(event.id).toMatch(/^[a-v0-9]{5,}$/);
  });

  it("puts the count and amount in the title", () => {
    const event = buildNagEvent(pending({ total: 4, amount: -212.5 }), "2026-09-07", config)!;
    expect(event.summary).toBe("Categorize 4 YNAB transactions ($212.50)");
  });

  it("uses the singular for one transaction", () => {
    const event = buildNagEvent(
      pending({ unapproved: 1, uncategorized: 0, total: 1, amount: -9.99 }),
      "2026-09-07",
      config,
    )!;
    expect(event.summary).toBe("Categorize 1 YNAB transaction ($9.99)");
  });

  it("schedules a 15 minute slot at the configured hour with a popup", () => {
    const event = buildNagEvent(pending(), "2026-09-07", config)!;
    expect(event.start).toBe("2026-09-07T18:00:00");
    expect(event.end).toBe("2026-09-07T18:15:00");
    expect(event.timeZone).toBe("America/Los_Angeles");
    expect(event.reminderMinutes).toBe(0);
  });

  it("breaks down the counts in the description", () => {
    const event = buildNagEvent(pending({ unapproved: 3, uncategorized: 1 }), "2026-09-07", config)!;
    expect(event.description).toContain("3 unapproved");
    expect(event.description).toContain("1 uncategorized");
  });
});

describe("runNag", () => {
  const configured: WorkerEnv = {
    YNAB_API_TOKEN: "token",
    YNAB_BUDGET_ID: "budget",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    ALLOWED_GITHUB_LOGIN: "someone",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    NAG_CALENDAR_ID: "family@group.calendar.google.com",
    NAG_HOUR: "18",
  };

  it("does nothing when the calendar is not configured", async () => {
    const outcome = await runNag({ ...configured, GOOGLE_SERVICE_ACCOUNT_JSON: undefined });
    expect(outcome).toEqual({ ran: false, reason: "calendar reminder not configured" });
  });

  it("waits for the configured local hour", async () => {
    // 16:00 in Los Angeles, two hours early.
    const outcome = await runNag(configured, new Date("2026-09-07T23:00:00Z"));
    expect(outcome.ran).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("waiting for 18");
  });
});

describe("sinceDate", () => {
  it("returns the cutoff date n days back", () => {
    expect(sinceDate(new Date("2026-09-07T18:00:00Z"), 30)).toBe("2026-08-08");
    expect(sinceDate(new Date("2026-09-07T18:00:00Z"), 7)).toBe("2026-08-31");
  });
});

describe("getPendingWork", () => {
  function txn(id: string, date: string, amount: number) {
    return { id, date, amount, deleted: false };
  }

  /** Mirrors the real backlog: a few recent items, many old ones. */
  const api = {
    transactions: {
      getTransactions: async (_budget: string, _since: undefined, type: string) => ({
        data: {
          transactions: type === "unapproved"
            ? [txn("recent-1", "2026-09-01", -25000)]
            : [
                txn("recent-1", "2026-09-01", -25000),
                txn("recent-2", "2026-08-20", -10000),
                txn("old-1", "2026-04-04", -500000),
                txn("old-2", "2026-05-11", -300000),
                txn("deleted", "2026-09-02", -1000),
              ].filter((t) => t.id !== "deleted"),
        },
      }),
    },
  } as any;

  it("counts only the recent window and reports the rest as backlog", async () => {
    const pending = await getPendingWork(api, "budget", "2026-08-08");

    expect(pending.total).toBe(2);
    expect(pending.backlog).toBe(2);
  });

  it("sums only the recent amounts", async () => {
    const pending = await getPendingWork(api, "budget", "2026-08-08");
    expect(pending.amount).toBe(-35);
  });

  it("counts a transaction that is both unapproved and uncategorized once", async () => {
    const pending = await getPendingWork(api, "budget", "2026-08-08");
    expect(pending.unapproved).toBe(1);
    expect(pending.uncategorized).toBe(2);
    expect(pending.total).toBe(2); // not 3
  });
});

describe("backlog in the description", () => {
  it("mentions older items without putting them in the title", () => {
    const event = buildNagEvent(pending({ total: 2, backlog: 61 }), "2026-09-07", config)!;
    expect(event.summary).toContain("Categorize 2 YNAB transactions");
    expect(event.summary).not.toContain("61");
    expect(event.description).toContain("61 older items");
  });

  it("says nothing about a backlog when there is none", () => {
    const event = buildNagEvent(pending({ backlog: 0 }), "2026-09-07", config)!;
    expect(event.description).not.toContain("older");
  });
});
