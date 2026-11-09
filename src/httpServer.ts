import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type * as ynab from "ynab";

import { registerAll } from "./registry.js";

// Tool calls are small JSON-RPC messages; refuse anything far larger.
export const MAX_BODY_BYTES = 1024 * 1024;

// Host header hostnames accepted while listening on a loopback address.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface HttpServerOptions {
  /** One client shared by every request, so per-client caches (plan settings) persist. */
  api: ynab.API;
  readOnly?: boolean;
  version: string;
  /**
   * Browser origins allowed to call /mcp (e.g. "https://app.example.com").
   * Each entry is normalised to its origin, so a trailing slash or path is
   * ignored. A request carrying any other Origin header is refused. Empty by
   * default: gateways and server-side clients send no Origin.
   */
  allowedOrigins?: string[];
  /**
   * Extra Host hostnames accepted while listening on a loopback address, for
   * a reverse proxy on the same machine that forwards the client's Host
   * (e.g. "mcp.example.com"). A port in an entry is ignored. Has no effect
   * when listening on a non-loopback address, where Host is not checked.
   */
  allowedHosts?: string[];
}

/** An allowed-origin entry as browsers send it: scheme, host and port only. */
export function normalizeOrigin(entry: string): string {
  let origin: string;
  try {
    origin = new URL(entry).origin;
  } catch {
    throw new TypeError(`Invalid allowed origin: ${entry}`);
  }
  if (origin === "null") throw new TypeError(`Invalid allowed origin: ${entry}`);
  return origin;
}

/** An allowed-host entry as the Host check compares it: the hostname only, lower-cased. */
export function normalizeHostname(entry: string): string {
  try {
    const { hostname } = new URL(`http://${entry}`);
    if (hostname) return hostname;
  } catch {
    // fall through
  }
  throw new TypeError(`Invalid allowed host: ${entry}`);
}

class BodyTooLargeError extends Error {}

/** True for an address the server can only be reached on from this machine. */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  const v4 = bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Reads the request body as JSON. Over MAX_BODY_BYTES it stops buffering,
 * discards the rest of the upload and rejects with BodyTooLargeError, leaving
 * the connection open so the caller can still send a 413.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      return reject(new BodyTooLargeError());
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off("data", onData);
        req.off("end", onEnd);
        chunks.length = 0;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/** Answers 413 and closes the connection once the response is on the wire. */
function sendBodyTooLarge(req: IncomingMessage, res: ServerResponse) {
  res.on("finish", () => {
    // Give the client a moment to read the response before the socket goes,
    // then close it even if the client is still uploading.
    setTimeout(() => req.socket.destroy(), 1000).unref();
  });
  jsonRpcError(res, 413, -32600, "Request body too large", { connection: "close" });
}

/**
 * A stateless streamable-HTTP MCP server for self-hosting (a container behind
 * a reverse proxy or MCP gateway). Each POST to /mcp gets its own McpServer and
 * transport; there are no sessions, so GET (standalone SSE) and DELETE are
 * refused. GET /healthz answers without touching YNAB.
 *
 * It does no authentication of its own: put it on a private network or behind
 * a proxy that authenticates callers, since anyone who can reach /mcp can use
 * the configured YNAB token. To stop web pages reaching it through DNS
 * rebinding, /mcp refuses any request with an Origin header that is not in
 * allowedOrigins and, while listening on a loopback address, any request whose
 * Host is not localhost, 127.0.0.1, [::1] or one of allowedHosts.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const { api, readOnly = false, version } = options;
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
  const allowedHostnames = new Set([...LOOPBACK_HOSTNAMES, ...(options.allowedHosts ?? []).map(normalizeHostname)]);

  /** The reason to refuse a request that may come from a browser, or undefined to allow it. */
  function rebindingCheck(req: IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return `Origin not allowed: ${origin}`;

    const address = server.address();
    if (address && typeof address === "object" && isLoopbackAddress(address.address)) {
      const hostHeader = req.headers.host;
      if (!hostHeader) return "Missing Host header";
      let hostname: string;
      try {
        hostname = new URL(`http://${hostHeader}`).hostname;
      } catch {
        return "Invalid Host header";
      }
      if (!allowedHostnames.has(hostname)) return `Host not allowed: ${hostname}`;
    }
    return undefined;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const refused = rebindingCheck(req);
    if (refused) {
      req.resume();
      return jsonRpcError(res, 403, -32000, refused);
    }

    if (req.method !== "POST") {
      req.resume();
      return jsonRpcError(res, 405, -32000, "Method not allowed: this server is stateless, use POST", { allow: "POST" });
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendBodyTooLarge(req, res);
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

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, HEAD" });
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
  return server;
}
