import { afterEach, describe, expect, it } from "vitest";

import { getPlanId, resetPlanResolutionState, resolvePlanId } from "./tools/planToolUtils.js";

describe("planToolUtils", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPlanResolutionState();
  });

  it("prefers the explicit planId input", () => {
    process.env = { ...originalEnv, YNAB_PLAN_ID: "plan-env" };

    expect(getPlanId("plan-input")).toBe("plan-input");
  });

  it("falls back to YNAB_PLAN_ID", () => {
    process.env = { ...originalEnv, YNAB_PLAN_ID: "plan-env" };

    expect(getPlanId()).toBe("plan-env");
  });

  it("does not fall back to YNAB_BUDGET_ID", () => {
    process.env = { ...originalEnv, YNAB_BUDGET_ID: "budget-env" };

    expect(() => getPlanId()).toThrow("No plan ID provided. Please provide a plan ID or set YNAB_PLAN_ID.");
  });

  it("ignores a whitespace-only YNAB_PLAN_ID", async () => {
    process.env = { ...originalEnv, YNAB_PLAN_ID: "   " };
    const api = {
      plans: {
        getPlans: async () => ({
          data: {
            plans: [
              { id: "plan-1", name: "Home" },
            ],
            default_plan: null,
          },
        }),
      },
    };

    expect(() => getPlanId()).toThrow("No plan ID provided. Please provide a plan ID or set YNAB_PLAN_ID.");
    await expect(resolvePlanId(undefined, api as any)).resolves.toBe("plan-1");
  });

  it("resolves the YNAB default plan when no planId is configured", async () => {
    process.env = { ...originalEnv };
    const api = {
      plans: {
        getPlans: async () => ({
          data: {
            plans: [
              { id: "plan-1", name: "Home" },
              { id: "plan-2", name: "Work" },
            ],
            default_plan: { id: "plan-2", name: "Work" },
          },
        }),
      },
    };

    await expect(resolvePlanId(undefined, api as any)).resolves.toBe("plan-2");
  });

  it("resolves the only available plan when no default is returned", async () => {
    process.env = { ...originalEnv };
    const api = {
      plans: {
        getPlans: async () => ({
          data: {
            plans: [
              { id: "plan-1", name: "Home" },
            ],
            default_plan: null,
          },
        }),
      },
    };

    await expect(resolvePlanId(undefined, api as any)).resolves.toBe("plan-1");
  });

  it("fails clearly when no plan can be resolved", async () => {
    process.env = { ...originalEnv };
    const api = {
      plans: {
        getPlans: async () => ({
          data: {
            plans: [],
            default_plan: null,
          },
        }),
      },
    };

    await expect(resolvePlanId(undefined, api as any)).rejects.toThrow(
      "No plan ID provided. Please provide a plan ID, set YNAB_PLAN_ID, or configure a default YNAB plan.",
    );
  });
});
