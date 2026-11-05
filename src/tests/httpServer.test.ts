import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as ynab from "ynab";

import { createHttpServer } from "../httpServer.js";
import { tools } from "../registry.js";

let server: Server | undefined;

async function start(readOnly = false) {
  const api = new ynab.API("test-token");
  server = createHttpServer({ api, readOnly, version: "test" });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { api, base: `http://127.0.0.1:${port}` };
}

async function connect(base: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

describe("streamable HTTP server", () => {
  beforeEach(() => {
    vi.stubEnv("YNAB_API_TOKEN", "test-token");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("answers the health check without calling YNAB", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("lists every tool, and only the read tools in read-only mode", async () => {
    const full = await start(false);
    const client = await connect(full.base);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      tools.filter((t) => t.module.name !== "ynab_suggest_categories").map((t) => t.module.name).sort()
    );
    await client.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const ro = await start(true);
    const roClient = await connect(ro.base);
    const roTools = (await roClient.listTools()).tools;
    expect(roTools.length).toBeGreaterThan(0);
    expect(roTools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await roClient.close();
  });

  it("runs a tool call against the shared YNAB client", async () => {
    const { api, base } = await start();
    const getPlans = vi.spyOn(api.plans, "getPlans").mockResolvedValue({
      data: { plans: [{ id: "plan-1", name: "Household" }] },
    } as unknown as ynab.PlanSummaryResponse);

    const client = await connect(base);
    const result = await client.callTool({ name: "ynab_list_plans", arguments: {} });
    await client.close();

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual([{ id: "plan-1", name: "Household" }]);
    expect(getPlans).toHaveBeenCalledTimes(1);
  });

  it("refuses GET on /mcp because it keeps no sessions", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects a malformed body with a JSON-RPC parse error", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32700);
  });

  it("returns 404 for any other path", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});
