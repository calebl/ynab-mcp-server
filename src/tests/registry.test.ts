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
});
