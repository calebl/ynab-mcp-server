import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type * as ynab from "ynab";

import { registerAll } from "./registry.js";

// Tool calls are small JSON-RPC messages; refuse anything far larger.
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpServerOptions {
  /** One client shared by every request, so per-client caches (plan settings) persist. */
  api: ynab.API;
  readOnly?: boolean;
  version: string;
}

class BodyTooLargeError extends Error {}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * A stateless streamable-HTTP MCP server for self-hosting (a container behind
 * a reverse proxy or MCP gateway). Each POST to /mcp gets its own McpServer and
 * transport; there are no sessions, so GET (standalone SSE) and DELETE are
 * refused. GET /healthz answers without touching YNAB.
 *
 * It does no authentication of its own: put it on a private network or behind
 * a proxy that authenticates callers, since anyone who can reach /mcp can use
 * the configured YNAB token.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const { api, readOnly = false, version } = options;

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return jsonRpcError(res, 405, -32000, "Method not allowed: this server is stateless, use POST");
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return jsonRpcError(res, 413, -32600, "Request body too large");
      return jsonRpcError(res, 400, -32700, "Parse error");
    }

    const server = new McpServer({ name: "ynab-mcp-server", version });
    registerAll(server, api, { readOnly });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("allow", "GET, HEAD");
        return sendJson(res, 405, { error: "method not allowed" });
      }
      return sendJson(res, 200, { status: "ok" });
    }
    if (path === "/mcp") {
      handleMcp(req, res).catch((error) => {
        console.error("MCP request failed:", error instanceof Error ? error.message : error);
        if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
      });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
}
