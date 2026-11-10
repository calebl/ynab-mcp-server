import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as ynab from "ynab";

import {
  createHttpServer,
  isLoopbackAddress,
  MAX_BODY_BYTES,
  normalizeHostname,
  normalizeOrigin,
  type HttpServerOptions,
} from "../httpServer.js";
import { tools } from "../registry.js";

let server: Server | undefined;

async function start(options: Partial<HttpServerOptions> = {}, host = "127.0.0.1") {
  const api = new ynab.API("test-token");
  server = createHttpServer({ api, version: "test", ...options });
  await new Promise<void>((resolve) => server!.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return { api, port, base: `http://127.0.0.1:${port}` };
}

async function stop() {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
}

async function connect(base: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

const deleteCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "ynab_delete_transaction", arguments: { planId: "plan-1", transactionId: "txn-1" } },
});

/**
 * A raw POST to /mcp, so tests control Host and Origin exactly. With
 * `chunked`, the body goes out in 64 KiB chunks with no Content-Length.
 */
function post(port: number, headers: Record<string, string>, body: string | Buffer, { chunked = false } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    if (!chunked) return void req.end(body);
    const buffer = Buffer.from(body);
    const step = 64 * 1024;
    // Stop writing once the response arrives: the server discards the rest.
    let answered = false;
    req.on("response", () => (answered = true));
    const writeFrom = (offset: number): void => {
      if (answered || offset >= buffer.length) return void req.end();
      const more = req.write(buffer.subarray(offset, offset + step));
      if (more) setImmediate(() => writeFrom(offset + step));
      else req.once("drain", () => writeFrom(offset + step));
    };
    writeFrom(0);
  });
}

describe("streamable HTTP server", () => {
  beforeEach(() => {
    vi.stubEnv("YNAB_API_TOKEN", "test-token");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await stop();
  });

  it("answers the health check without calling YNAB", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("lists every tool, and only the read tools in read-only mode", async () => {
    const full = await start();
    const client = await connect(full.base);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      tools.filter((t) => t.module.name !== "ynab_suggest_categories").map((t) => t.module.name).sort()
    );
    await client.close();
    await stop();

    const ro = await start({ readOnly: true });
    const roClient = await connect(ro.base);
    const roTools = (await roClient.listTools()).tools;
    expect(roTools.length).toBeGreaterThan(0);
    expect(roTools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await roClient.close();
  });

  it("refuses a write tool call in read-only mode without calling YNAB", async () => {
    const { api, base } = await start({ readOnly: true });
    const deleteTransaction = vi.spyOn(api.transactions, "deleteTransaction");

    const client = await connect(base);
    const result = await client.callTool({
      name: "ynab_delete_transaction",
      arguments: { planId: "plan-1", transactionId: "txn-1" },
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(deleteTransaction).not.toHaveBeenCalled();
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

  describe("DNS rebinding protection", () => {
    it("refuses a request with a foreign Origin and runs no tool", async () => {
      const { api, port } = await start();
      const deleteTransaction = vi.spyOn(api.transactions, "deleteTransaction");

      const response = await post(
        port,
        { host: `127.0.0.1:${port}`, origin: "http://attacker.example:3000" },
        deleteCall
      );

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).error.message).toContain("Origin not allowed");
      expect(deleteTransaction).not.toHaveBeenCalled();
    });

    it("refuses a foreign Host while listening on loopback, even with no Origin", async () => {
      const { api, port } = await start();
      const deleteTransaction = vi.spyOn(api.transactions, "deleteTransaction");

      const response = await post(port, { host: `attacker.example:${port}` }, deleteCall);

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).error.message).toContain("Host not allowed");
      expect(deleteTransaction).not.toHaveBeenCalled();
    });

    it("runs a request with no Origin and a loopback Host", async () => {
      const { api, port } = await start();
      const deleteTransaction = vi
        .spyOn(api.transactions, "deleteTransaction")
        .mockResolvedValue({ data: { transaction: { id: "txn-1" } } } as unknown as ynab.TransactionResponse);

      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        const response = await post(port, { host }, deleteCall);
        expect(response.status).toBe(200);
      }
      expect(deleteTransaction).toHaveBeenCalledTimes(3);
    });

    it("accepts an Origin that is on the allow-list", async () => {
      const { api, port } = await start({ allowedOrigins: ["https://app.example.com"] });
      vi.spyOn(api.transactions, "deleteTransaction").mockResolvedValue({
        data: { transaction: { id: "txn-1" } },
      } as unknown as ynab.TransactionResponse);

      const allowed = await post(port, { host: `127.0.0.1:${port}`, origin: "https://app.example.com" }, deleteCall);
      const other = await post(port, { host: `127.0.0.1:${port}`, origin: "https://other.example.com" }, deleteCall);

      expect(allowed.status).toBe(200);
      expect(other.status).toBe(403);
    });

    it("accepts an allowed Host on loopback, for a reverse proxy that forwards Host", async () => {
      const { api, port } = await start({ allowedHosts: ["MCP.example.com:443"] });
      const deleteTransaction = vi
        .spyOn(api.transactions, "deleteTransaction")
        .mockResolvedValue({ data: { transaction: { id: "txn-1" } } } as unknown as ynab.TransactionResponse);

      const proxied = await post(port, { host: "mcp.example.com" }, deleteCall);
      const other = await post(port, { host: `attacker.example:${port}` }, deleteCall);

      expect(proxied.status).toBe(200);
      expect(other.status).toBe(403);
      expect(deleteTransaction).toHaveBeenCalledTimes(1);
    });

    it("matches an allowed Origin written with a trailing slash or path", async () => {
      const { api, port } = await start({ allowedOrigins: ["https://app.example.com/", "https://b.example.com/x"] });
      vi.spyOn(api.transactions, "deleteTransaction").mockResolvedValue({
        data: { transaction: { id: "txn-1" } },
      } as unknown as ynab.TransactionResponse);

      for (const origin of ["https://app.example.com", "https://b.example.com"]) {
        const response = await post(port, { host: `127.0.0.1:${port}`, origin }, deleteCall);
        expect(response.status).toBe(200);
      }
    });

    it("refuses to start with an allowed origin or host it cannot parse", () => {
      const api = new ynab.API("test-token");
      expect(() => createHttpServer({ api, version: "test", allowedOrigins: ["app.example.com"] })).toThrow(
        "Invalid allowed origin: app.example.com"
      );
      expect(() => createHttpServer({ api, version: "test", allowedHosts: ["bad host"] })).toThrow(
        "Invalid allowed host: bad host"
      );
    });

    it("normalises allowed origins and hosts", () => {
      expect(normalizeOrigin("https://App.Example.com:443/path")).toBe("https://app.example.com");
      expect(normalizeOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
      expect(normalizeHostname("MCP.Example.com:8443")).toBe("mcp.example.com");
      expect(normalizeHostname("[::1]")).toBe("[::1]");
    });

    it("does not check Host when listening on a non-loopback address", async () => {
      const { api, port } = await start({}, "0.0.0.0");
      vi.spyOn(api.transactions, "deleteTransaction").mockResolvedValue({
        data: { transaction: { id: "txn-1" } },
      } as unknown as ynab.TransactionResponse);

      const response = await post(port, { host: `ynab-mcp:${port}` }, deleteCall);

      expect(response.status).toBe(200);
    });

    it("recognises loopback addresses", () => {
      for (const address of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1", "localhost"]) {
        expect(isLoopbackAddress(address)).toBe(true);
      }
      for (const address of ["0.0.0.0", "::", "10.0.0.5", "192.168.1.2", "example.com"]) {
        expect(isLoopbackAddress(address)).toBe(false);
      }
    });
  });

  it("answers an oversized body with a 413 rather than a reset", async () => {
    const { api, port } = await start();
    const deleteTransaction = vi.spyOn(api.transactions, "deleteTransaction");
    const body = Buffer.alloc(MAX_BODY_BYTES * 2, "a");

    const response = await post(port, { host: `127.0.0.1:${port}` }, body);

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error.message).toBe("Request body too large");
    expect(deleteTransaction).not.toHaveBeenCalled();
  });

  it("answers a chunked body that crosses the limit with a 413 rather than a reset", async () => {
    const { api, port } = await start();
    const deleteTransaction = vi.spyOn(api.transactions, "deleteTransaction");
    const body = Buffer.alloc(MAX_BODY_BYTES * 2, "a");

    const response = await post(port, { host: `127.0.0.1:${port}`, "transfer-encoding": "chunked" }, body, {
      chunked: true,
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error.message).toBe("Request body too large");
    expect(deleteTransaction).not.toHaveBeenCalled();
  });

  it("refuses GET on /mcp because it keeps no sessions", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects a malformed body with a JSON-RPC parse error", async () => {
    const { port } = await start();
    const response = await post(port, { host: `127.0.0.1:${port}` }, "{not json");
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(-32700);
  });

  it("returns 404 for any other path", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});
