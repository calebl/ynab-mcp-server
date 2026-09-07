import { describe, it, expect } from "vitest";

import { buildSnark } from "../worker/snark.js";

describe("buildSnark", () => {
  it("is stable within a day so hourly runs agree", () => {
    const a = buildSnark("2026-09-07", 19, "$486.31", "19 uncategorized", 61);
    const b = buildSnark("2026-09-07", 19, "$486.31", "19 uncategorized", 61);
    expect(a).toEqual(b);
  });

  it("changes wording across days", () => {
    const summaries = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      summaries.add(buildSnark(date, 5, "$100.00", "5 uncategorized", 0).summary);
    }
    expect(summaries.size).toBeGreaterThan(4);
  });

  it("always carries the count and the amount", () => {
    for (let day = 1; day <= 28; day++) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      const snark = buildSnark(date, 7, "$123.45", "7 uncategorized", 0);
      expect(snark.summary).toContain("7");
      expect(snark.summary).toContain("$123.45");
    }
  });

  it("uses the singular noun for one transaction", () => {
    for (let day = 1; day <= 28; day++) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      const snark = buildSnark(date, 1, "$9.99", "1 uncategorized", 0);
      expect(snark.summary).not.toMatch(/1 transactions/);
    }
  });

  it("frames the count as this month", () => {
    const snark = buildSnark("2026-09-07", 3, "$50.00", "3 uncategorized", 0);
    expect(snark.description).toContain("this month");
  });

  it("drops the amount from the title when it nets to zero", () => {
    for (let day = 1; day <= 14; day++) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      const snark = buildSnark(date, 2, "$0.00", "2 uncategorized", 0);
      expect(snark.summary).not.toContain("$0.00");
      expect(snark.summary).toContain("2");
    }
  });

  it("adds a backlog line only when there is one", () => {
    expect(buildSnark("2026-09-07", 3, "$50.00", "3 uncategorized", 12).description).toContain("12 stragglers");
    expect(buildSnark("2026-09-07", 3, "$50.00", "3 uncategorized", 1).description).toContain("1 straggler");
    expect(buildSnark("2026-09-07", 3, "$50.00", "3 uncategorized", 0).description).not.toContain("straggler");
  });
});
