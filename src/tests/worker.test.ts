import { describe, it, expect } from "vitest";

import { McpApiHandler } from "../worker/mcp.js";
import { tools } from "../registry.js";
import type { WorkerEnv } from "../worker/env.js";

const env: WorkerEnv = {
  YNAB_API_TOKEN: "test-token",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  ALLOWED_GITHUB_LOGIN: "someone",
};

/** Sends one JSON-RPC message to the Worker's /mcp handler. */
async function call(body: unknown, overrides: Partial<WorkerEnv> = {}) {
  const request = new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  return McpApiHandler.fetch(request, { ...env, ...overrides });
}

/** The handler may answer as JSON or as a single SSE frame; accept both. */
async function readResult(response: Response) {
  const text = await response.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

describe("worker MCP handler", () => {
  it("responds to initialize over HTTP", async () => {
    const response = await call(initialize);
    expect(response.status).toBe(200);

    const result = await readResult(response);
    expect(result.result.serverInfo.name).toBe("ynab-mcp-server");
  });

  it("serves every tool", async () => {
    const response = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = await readResult(response);

    const names = result.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(tools.length);
    expect(names).toContain("ynab_budget_summary");
    expect(names).toContain("ynab_create_transaction");
  });

  it("hides write tools when YNAB_READ_ONLY is true", async () => {
    const response = await call(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { YNAB_READ_ONLY: "true" },
    );
    const result = await readResult(response);

    const names = result.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("ynab_budget_summary");
    expect(names).not.toContain("ynab_create_transaction");
    expect(names).not.toContain("ynab_delete_transaction");
  });
});
