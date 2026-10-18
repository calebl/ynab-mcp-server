import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as ynab from "ynab";

import { registerAll, tools, type ToolRegistrar } from "../registry.js";

interface RegisteredTool {
  config: Record<string, any>;
  callback: (input: any) => Promise<any>;
}

function register(api: ynab.API = {} as ynab.API) {
  const registered = new Map<string, RegisteredTool>();
  const server: ToolRegistrar = {
    registerTool(name, config, callback) {
      registered.set(name, { config, callback });
    },
  };
  registerAll(server, api);
  return registered;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool registration", () => {
  it("accepts null for every optional tool input", () => {
    vi.stubEnv("YNAB_AI_CATEGORIZATION", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const registered = register();

    for (const { module } of tools) {
      const registeredSchema = registered.get(module.name)?.config.inputSchema;
      expect(registeredSchema, module.name).toBeDefined();
      const shape = (registeredSchema as z.ZodObject<z.ZodRawShape>).shape;

      for (const [name, schema] of Object.entries(module.inputSchema)) {
        if ((schema as z.ZodType).safeParse(undefined).success) {
          expect(
            (shape[name] as z.ZodType).safeParse(null).success,
            `${module.name}.${name}`,
          ).toBe(true);
        }
      }
    }
  });

  it("carries a property-level description for every field of every tool", () => {
    vi.stubEnv("YNAB_AI_CATEGORIZATION", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const registered = register();

    for (const { module } of tools) {
      const registeredSchema = registered.get(module.name)?.config.inputSchema;
      expect(registeredSchema, module.name).toBeDefined();
      const shape = (registeredSchema as z.ZodObject<z.ZodRawShape>).shape;

      for (const [name, schema] of Object.entries(shape)) {
        const jsonSchema = z.toJSONSchema(schema as z.ZodType) as { description?: unknown };
        expect(typeof jsonSchema.description, `${module.name}.${name}`).toBe("string");
        expect((jsonSchema.description as string).length, `${module.name}.${name}`).toBeGreaterThan(0);
      }
    }
  });

  it("wraps every tool's input schema in z.object()", () => {
    vi.stubEnv("YNAB_AI_CATEGORIZATION", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const registered = register();

    for (const { module } of tools) {
      const registeredSchema = registered.get(module.name)?.config.inputSchema;
      expect(registeredSchema, module.name).toBeInstanceOf(z.ZodObject);
    }
  });

  it("advertises the JSON Schema unchanged apart from the z.object() wrapping", () => {
    vi.stubEnv("YNAB_AI_CATEGORIZATION", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const registered = register();

    for (const { module } of tools) {
      const registeredSchema = registered.get(module.name)?.config.inputSchema as z.ZodObject<z.ZodRawShape>;
      const rawObjectSchema = z.object(module.inputSchema as z.ZodRawShape);

      const wrappedJsonSchema = z.toJSONSchema(registeredSchema);
      const rawJsonSchema = z.toJSONSchema(rawObjectSchema);

      // Only field-level nullability differs (added by nullCompatibleInputSchema), so
      // compare property descriptions and required-ness rather than a strict deep-equal.
      for (const [name, prop] of Object.entries(rawJsonSchema.properties ?? {})) {
        const wrappedProp = (wrappedJsonSchema.properties ?? {})[name] as { description?: unknown };
        expect(wrappedProp, `${module.name}.${name}`).toBeDefined();
        expect(wrappedProp.description, `${module.name}.${name}`).toBe((prop as { description?: unknown }).description);
      }
    }
  });

  it("publishes annotations derived from the registry for every tool", () => {
    vi.stubEnv("YNAB_AI_CATEGORIZATION", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const registered = register();

    for (const tool of tools) {
      const annotations = registered.get(tool.module.name)?.config.annotations;
      expect(annotations, tool.module.name).toEqual({
        title: tool.title,
        readOnlyHint: !tool.writes,
        destructiveHint: Boolean(tool.destructive),
        idempotentHint: Boolean(tool.idempotent),
        openWorldHint: true,
      });
    }

    // Spot-check the specific hints called out for this tool set.
    expect(registered.get("ynab_delete_transaction")?.config.annotations.destructiveHint).toBe(true);
    expect(registered.get("ynab_create_transaction")?.config.annotations.destructiveHint).toBe(false);
    expect(registered.get("ynab_approve_transaction")?.config.annotations.idempotentHint).toBe(true);
    expect(registered.get("ynab_update_transaction")?.config.annotations.idempotentHint).toBe(true);
    expect(registered.get("ynab_bulk_approve_transactions")?.config.annotations.idempotentHint).toBe(true);
    expect(registered.get("ynab_update_category_budget")?.config.annotations.idempotentHint).toBe(true);
    expect(registered.get("ynab_create_transaction")?.config.annotations.idempotentHint).toBe(false);
    expect(registered.get("ynab_move_money")?.config.annotations.idempotentHint).toBe(false);
    expect(registered.get("ynab_auto_assign")?.config.annotations.idempotentHint).toBe(false);
    expect(registered.get("ynab_import_transactions")?.config.annotations.idempotentHint).toBe(false);
  });

  it("rejects ynab_create_transaction input missing both accountId and accountName", () => {
    const registered = register();
    const schema = registered.get("ynab_create_transaction")!.config.inputSchema as z.ZodType;

    const result = schema.safeParse({
      date: "2024-03-24",
      amount: 10,
      payeeName: "Some Payee",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === "Either accountId or accountName must be provided")).toBe(true);
  });

  it("rejects ynab_create_transaction input missing both payeeId and payeeName", () => {
    const registered = register();
    const schema = registered.get("ynab_create_transaction")!.config.inputSchema as z.ZodType;

    const result = schema.safeParse({
      date: "2024-03-24",
      amount: 10,
      accountName: "Checking",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === "Either payeeId or payeeName must be provided")).toBe(true);
  });

  it("passes null optional inputs to tools as omissions", async () => {
    let received: unknown;
    const entry = {
      title: "Null normalization test",
      writes: false,
      module: {
        name: "null_normalization_test",
        description: "test",
        inputSchema: {
          optional: z.string().optional(),
          required: z.string(),
        },
        async execute(input: unknown) {
          received = input;
          return { content: [] };
        },
      },
    };
    tools.push(entry);

    try {
      const registered = register();
      await registered.get(entry.module.name)!.callback({ optional: null, required: "value" });
      expect(received).toEqual({ required: "value" });
    } finally {
      tools.pop();
    }
  });

  it.each([
    {
      label: "planId",
      input: { planId: "input-plan" },
      planEnv: "environment-plan",
      budgetEnv: "environment-budget",
      expected: "input-plan",
    },
    {
      label: "budgetId",
      input: { budgetId: "input-budget" },
      planEnv: "environment-plan",
      budgetEnv: "environment-budget",
      expected: "input-budget",
    },
    {
      label: "YNAB_PLAN_ID",
      input: {},
      planEnv: "environment-plan",
      budgetEnv: "",
      expected: "environment-plan",
    },
    {
      label: "YNAB_BUDGET_ID",
      input: {},
      planEnv: "",
      budgetEnv: "environment-budget",
      expected: "environment-budget",
    },
    {
      label: "planId over budgetId",
      input: { planId: "input-plan", budgetId: "input-budget" },
      planEnv: "environment-plan",
      budgetEnv: "environment-budget",
      expected: "input-plan",
    },
    {
      label: "YNAB_PLAN_ID over YNAB_BUDGET_ID",
      input: {},
      planEnv: "environment-plan",
      budgetEnv: "environment-budget",
      expected: "environment-plan",
    },
  ])("resolves $label through a registered plan tool", async ({ input, planEnv, budgetEnv, expected }) => {
    vi.stubEnv("YNAB_PLAN_ID", planEnv);
    vi.stubEnv("YNAB_BUDGET_ID", budgetEnv);
    const api = {
      accounts: { getAccounts: vi.fn().mockResolvedValue({ data: { accounts: [] } }) },
      months: {
        getPlanMonth: vi.fn().mockResolvedValue({
          data: {
            month: {
              month: "2024-01-01",
              income: 0,
              budgeted: 0,
              activity: 0,
              to_be_budgeted: 0,
              age_of_money: null,
              note: null,
              categories: [],
            },
          },
        }),
      },
    };
    const registered = register(api as unknown as ynab.API);

    const result = await registered.get("ynab_plan_summary")!.callback(input);

    expect(result.isError).toBeUndefined();
    expect(api.accounts.getAccounts).toHaveBeenCalledWith(expected);
    expect(api.months.getPlanMonth).toHaveBeenCalledWith(expected, "current");
  });

  it("successfully calls canonical and legacy plan tool registrations", async () => {
    vi.stubEnv("YNAB_API_TOKEN", "test-token");
    const api = {
      plans: { getPlans: vi.fn().mockResolvedValue({ data: { plans: [] } }) },
      accounts: { getAccounts: vi.fn().mockResolvedValue({ data: { accounts: [] } }) },
      months: {
        getPlanMonth: vi.fn().mockResolvedValue({
          data: {
            month: {
              month: "2024-01-01",
              income: 0,
              budgeted: 0,
              activity: 0,
              to_be_budgeted: 0,
              age_of_money: null,
              note: null,
              categories: [],
            },
          },
        }),
      },
    };
    const registered = register(api as unknown as ynab.API);

    for (const name of ["ynab_list_plans", "ynab_list_budgets"]) {
      const result = await registered.get(name)!.callback({});
      expect(result.isError, name).toBeUndefined();
    }
    for (const name of ["ynab_plan_summary", "ynab_budget_summary"]) {
      const result = await registered.get(name)!.callback({ planId: "test-plan" });
      expect(result.isError, name).toBeUndefined();
    }

    expect(api.plans.getPlans).toHaveBeenCalledTimes(2);
    expect(api.accounts.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("marks the registered list-budgets missing-token failure as isError", async () => {
    vi.stubEnv("YNAB_API_TOKEN", "");
    const registered = register();

    const result = await registered.get("ynab_list_budgets")!.callback({});

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: "YNAB API Token is not set",
    });
  });

  it("marks a thrown execute failure as isError", async () => {
    const entry = {
      title: "Throwing tool test",
      writes: false,
      module: {
        name: "throwing_tool_test",
        description: "test",
        inputSchema: {},
        async execute(): Promise<any> {
          throw new Error("boom");
        },
      },
    };
    tools.push(entry);

    try {
      const registered = register();
      const result = await registered.get(entry.module.name)!.callback({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ success: false, error: "boom" });
    } finally {
      tools.pop();
    }
  });

  it("marks a {success: false} execute result as isError", async () => {
    const entry = {
      title: "Failing result tool test",
      writes: false,
      module: {
        name: "failing_result_tool_test",
        description: "test",
        inputSchema: {},
        async execute() {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "nope" }) }],
          };
        },
      },
    };
    tools.push(entry);

    try {
      const registered = register();
      const result = await registered.get(entry.module.name)!.callback({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ success: false, error: "nope" });
    } finally {
      tools.pop();
    }
  });

  it("does not mark a successful execute result as isError", async () => {
    const entry = {
      title: "Success result tool test",
      writes: false,
      module: {
        name: "success_result_tool_test",
        description: "test",
        inputSchema: {},
        async execute() {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }],
          };
        },
      },
    };
    tools.push(entry);

    try {
      const registered = register();
      const result = await registered.get(entry.module.name)!.callback({});
      expect(result.isError).toBeUndefined();
    } finally {
      tools.pop();
    }
  });
});

describe("a configured plan the token cannot see", () => {
  const notFound = { error: { id: "404.2", name: "resource_not_found", detail: "Resource not found" } };

  function apiWithPlans(plans: Array<{ id: string; name: string }>) {
    return {
      plans: { getPlans: vi.fn().mockResolvedValue({ data: { plans } }) },
      accounts: { getAccounts: vi.fn().mockRejectedValue(notFound) },
    } as unknown as ynab.API;
  }

  it("is named in the error of a call that relied on it, with the plans the token can see", async () => {
    vi.stubEnv("YNAB_PLAN_ID", "configured-plan");
    const api = apiWithPlans([{ id: "real-plan", name: "Household" }]);
    const registered = register(api);

    const result = await registered.get("ynab_list_accounts")!.callback({});
    expect(result.isError).toBe(true);
    const { error, plan_visibility_error: planVisibilityError } = JSON.parse(result.content[0].text);
    expect(error).toBe("Resource not found");
    expect(planVisibilityError).toContain("The configured plan configured-plan (YNAB_PLAN_ID) is not one of the plans this YNAB token can access");
    expect(planVisibilityError).toContain('"Household" (real-plan)');

    await registered.get("ynab_list_accounts")!.callback({});
    expect(api.plans.getPlans).toHaveBeenCalledTimes(2);
  });

  it("preserves a partial-write failure while attaching the plan visibility explanation", async () => {
    vi.stubEnv("YNAB_PLAN_ID", "configured-plan");
    const entry = {
      title: "Partial failure tool test",
      writes: true,
      module: {
        name: "partial_failure_tool_test",
        description: "test",
        inputSchema: { planId: z.string().optional().describe("Plan ID") },
        async execute() {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                partial: true,
                assigned: [{ id: "funded" }],
                not_assigned: [{ id: "unfunded" }],
                recovery: "Restore the source category.",
              }),
            }],
          };
        },
      },
    };
    tools.push(entry);

    try {
      const result = await register(apiWithPlans([])).get(entry.module.name)!.callback({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: false,
        partial: true,
        assigned: [{ id: "funded" }],
        not_assigned: [{ id: "unfunded" }],
        recovery: "Restore the source category.",
        plan_visibility_error: expect.stringContaining("configured-plan"),
      });
    } finally {
      tools.pop();
    }
  });

  it("revalidates plan visibility after access changes", async () => {
    vi.stubEnv("YNAB_PLAN_ID", "configured-plan");
    const plans = [{ id: "real-plan", name: "Household" }];
    const api = apiWithPlans(plans);
    const registered = register(api);

    const missing = await registered.get("ynab_list_accounts")!.callback({});
    expect(JSON.parse(missing.content[0].text).plan_visibility_error).toContain("is not one of the plans");

    plans.splice(0, plans.length, { id: "configured-plan", name: "Restored" });
    const restored = await registered.get("ynab_list_accounts")!.callback({});
    expect(JSON.parse(restored.content[0].text).error).toBe("Resource not found");

    plans.splice(0, plans.length, { id: "real-plan", name: "Household" });
    const revoked = await registered.get("ynab_list_accounts")!.callback({});
    expect(JSON.parse(revoked.content[0].text).plan_visibility_error).toContain("is not one of the plans");
    expect(api.plans.getPlans).toHaveBeenCalledTimes(3);
  });

  it("leaves the error alone when the plan is visible or was passed explicitly", async () => {
    vi.stubEnv("YNAB_PLAN_ID", "real-plan");
    const visible = await register(apiWithPlans([{ id: "real-plan", name: "Household" }]))
      .get("ynab_list_accounts")!.callback({});
    expect(JSON.parse(visible.content[0].text).error).toBe("Resource not found");

    vi.stubEnv("YNAB_PLAN_ID", "configured-plan");
    const api = apiWithPlans([]);
    const explicit = await register(api).get("ynab_list_accounts")!.callback({ planId: "other-plan" });
    expect(JSON.parse(explicit.content[0].text).error).toBe("Resource not found");
    expect(api.plans.getPlans).not.toHaveBeenCalled();
  });

  it("falls back to the original error when the plan list cannot be read", async () => {
    vi.stubEnv("YNAB_PLAN_ID", "configured-plan");
    const api = {
      plans: { getPlans: vi.fn().mockRejectedValue(new Error("offline")) },
      accounts: { getAccounts: vi.fn().mockRejectedValue(notFound) },
    } as unknown as ynab.API;
    const registered = register(api);

    for (let i = 0; i < 2; i++) {
      const result = await registered.get("ynab_list_accounts")!.callback({});
      expect(JSON.parse(result.content[0].text).error).toBe("Resource not found");
    }
    // A failed lookup is not cached.
    expect(api.plans.getPlans).toHaveBeenCalledTimes(2);
  });
});
