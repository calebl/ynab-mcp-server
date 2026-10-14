import { afterEach, describe, expect, it, vi } from "vitest";

import { tools } from "../registry.js";

const registered: string[] = [];

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string) {
      registered.push(name);
    }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

/** Loads the stdio entry fresh under the current env and returns the tool names it registered. */
async function loadStdioEntry() {
  registered.length = 0;
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../index.js");
  return [...registered];
}

const writeTools = tools.filter((t) => t.writes).map((t) => t.module.name);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("stdio entry", () => {
  it("registers write tools when YNAB_READ_ONLY is unset", async () => {
    vi.stubEnv("YNAB_READ_ONLY", undefined);
    const names = await loadStdioEntry();
    expect(names).toContain("ynab_delete_transaction");
  });

  it.each(["true", "TRUE", " true "])("registers no write tools when YNAB_READ_ONLY is %j", async (value) => {
    vi.stubEnv("YNAB_READ_ONLY", value);
    const names = await loadStdioEntry();
    expect(names).toContain("ynab_list_plans");
    for (const name of writeTools) expect(names).not.toContain(name);
  });

  it("keeps write tools when YNAB_READ_ONLY is false", async () => {
    vi.stubEnv("YNAB_READ_ONLY", "false");
    const names = await loadStdioEntry();
    expect(names).toContain("ynab_delete_transaction");
  });
});
