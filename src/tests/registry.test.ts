import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as ynab from "ynab";

import { registerAll, tools, type ToolRegistrar } from "../registry.js";

interface RegisteredTool {
  config: Record<string, any>;
  callback: (input: any) => Promise<any>;
}

function register() {
  const registered = new Map<string, RegisteredTool>();
  const server: ToolRegistrar = {
    registerTool(name, config, callback) {
      registered.set(name, { config, callback });
    },
  };
  registerAll(server, {} as ynab.API);
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

      for (const [name, schema] of Object.entries(module.inputSchema)) {
        if ((schema as z.ZodType).safeParse(undefined).success) {
          expect(
            (registeredSchema[name] as z.ZodType).safeParse(null).success,
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

      for (const [name, schema] of Object.entries(registeredSchema)) {
        const jsonSchema = z.toJSONSchema(schema as z.ZodType) as { description?: unknown };
        expect(typeof jsonSchema.description, `${module.name}.${name}`).toBe("string");
        expect((jsonSchema.description as string).length, `${module.name}.${name}`).toBeGreaterThan(0);
      }
    }
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
