import { createServer as createNodeServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { resetPlanResolutionState } from "./tools/planToolUtils.js";
const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "OPTIONS, POST",
    "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
    "access-control-expose-headers": "Mcp-Session-Id",
};
const HTTP_ALLOWED_METHODS = ["POST"];
function applyCorsHeaders(res) {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
        res.setHeader(name, value);
    }
}
function getRequestPath(req) {
    if (!req.url) {
        return "/";
    }
    return new URL(req.url, "http://127.0.0.1").pathname;
}
function getFirstHeaderValue(value) {
    if (typeof value === "string") {
        return value.split(",")[0]?.trim();
    }
    return value?.[0]?.split(",")[0]?.trim();
}
function parseHostName(host) {
    if (!host) {
        return undefined;
    }
    try {
        return new URL(`http://${host}`).hostname;
    }
    catch {
        return undefined;
    }
}
function isLoopbackHostname(hostname) {
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";
}
function getRequestHostName(req) {
    const forwardedHost = getFirstHeaderValue(req.headers["x-forwarded-host"]);
    const host = forwardedHost ?? getFirstHeaderValue(req.headers.host);
    return parseHostName(host);
}
function normalizeOrigin(origin) {
    return new URL(origin).origin;
}
function isOriginAllowed(req, allowedOrigins) {
    const originHeader = getFirstHeaderValue(req.headers.origin);
    if (!originHeader) {
        return true;
    }
    try {
        const normalizedOrigin = normalizeOrigin(originHeader);
        if (allowedOrigins.has(normalizedOrigin)) {
            return true;
        }
        const requestHostName = getRequestHostName(req);
        const originHostName = new URL(normalizedOrigin).hostname;
        return isLoopbackHostname(requestHostName) && isLoopbackHostname(originHostName);
    }
    catch {
        return false;
    }
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
        return undefined;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function writeJson(res, statusCode, body) {
    res.statusCode = statusCode;
    applyCorsHeaders(res);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
}
function writeJsonRpcError(res, statusCode, code, message) {
    writeJson(res, statusCode, {
        jsonrpc: "2.0",
        error: {
            code,
            message,
        },
        id: null,
    });
}
function writeMethodNotAllowed(res, allowedMethods) {
    res.setHeader("allow", allowedMethods.join(", "));
    writeJsonRpcError(res, 405, -32000, "Method not allowed.");
}
function writeNotFound(res) {
    writeJson(res, 404, {
        error: "Not found",
    });
}
function writeForbiddenOrigin(res) {
    writeJson(res, 403, {
        error: "Forbidden origin",
    });
}
function writeParseError(res) {
    writeJsonRpcError(res, 400, -32700, "Parse error");
}
function writeInternalServerError(res) {
    writeJsonRpcError(res, 500, -32603, "Internal server error");
}
function logHttpDebug(event, details) {
    console.error("[http]", event, details);
}
function getSessionId(req) {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
        return undefined;
    }
    const values = sessionId
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (values.length !== 1) {
        return undefined;
    }
    return values[0];
}
function getRequestDebugDetails(req) {
    return {
        method: req.method ?? "UNKNOWN",
        origin: getFirstHeaderValue(req.headers.origin),
        path: getRequestPath(req),
        protocolVersion: getFirstHeaderValue(req.headers["mcp-protocol-version"]),
        sessionId: getSessionId(req),
    };
}
function getJsonRpcDebugDetails(parsedBody) {
    if (!parsedBody || typeof parsedBody !== "object") {
        return {};
    }
    const request = parsedBody;
    const details = {};
    if (typeof request.method === "string") {
        details.jsonRpcMethod = request.method;
    }
    if ("id" in request) {
        details.jsonRpcId = request.id;
    }
    return details;
}
function hasMultipleSessionHeaderValues(req) {
    const sessionId = req.headers["mcp-session-id"];
    if (Array.isArray(sessionId)) {
        return sessionId.length > 1 || sessionId.some((value) => value.includes(","));
    }
    if (typeof sessionId !== "string") {
        return false;
    }
    return sessionId
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean).length > 1;
}
async function createManagedRequest() {
    const mcpServer = createServer();
    const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    return {
        transport,
        close: async () => {
            await transport.close();
            await mcpServer.close();
        },
    };
}
async function resolveRequest(req, createRequest) {
    if (hasMultipleSessionHeaderValues(req)) {
        return {
            status: "invalid-session-header",
        };
    }
    if (req.method !== "POST") {
        return {
            status: "method-not-allowed",
        };
    }
    const managedRequest = await createRequest();
    return {
        cleanup: managedRequest.close,
        managedRequest,
        status: "ready",
    };
}
function writeRequestResolution(res, resolution) {
    switch (resolution.status) {
        case "invalid-session-header":
            writeJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header must be a single value");
            return;
        case "method-not-allowed":
            writeMethodNotAllowed(res, HTTP_ALLOWED_METHODS);
            return;
    }
}
async function closeNodeServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                if (error.code === "ERR_SERVER_NOT_RUNNING") {
                    resolve();
                    return;
                }
                reject(error);
                return;
            }
            resolve();
        });
    });
}
export async function startHttpServer(options = {}) {
    const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => normalizeOrigin(origin)));
    const host = options.host ?? "127.0.0.1";
    const path = options.path ?? "/mcp";
    const port = options.port ?? 3000;
    const server = createNodeServer(async (req, res) => {
        logHttpDebug("request.received", getRequestDebugDetails(req));
        if (!isOriginAllowed(req, allowedOrigins)) {
            logHttpDebug("request.rejected", {
                ...getRequestDebugDetails(req),
                reason: "forbidden-origin",
            });
            writeForbiddenOrigin(res);
            return;
        }
        if (req.method === "OPTIONS") {
            logHttpDebug("request.preflight", getRequestDebugDetails(req));
            applyCorsHeaders(res);
            res.statusCode = 204;
            res.end();
            return;
        }
        if (getRequestPath(req) !== path) {
            logHttpDebug("request.rejected", {
                ...getRequestDebugDetails(req),
                reason: "path-not-found",
            });
            writeNotFound(res);
            return;
        }
        if (req.method !== "POST") {
            logHttpDebug("request.rejected", {
                ...getRequestDebugDetails(req),
                reason: "method-not-allowed",
            });
            writeMethodNotAllowed(res, HTTP_ALLOWED_METHODS);
            return;
        }
        try {
            const parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
            const resolution = await resolveRequest(req, createManagedRequest);
            if (resolution.status !== "ready") {
                logHttpDebug("request.rejected", {
                    ...getRequestDebugDetails(req),
                    reason: resolution.status,
                });
                writeRequestResolution(res, resolution);
                return;
            }
            let cleanedUp = false;
            const cleanup = async () => {
                if (cleanedUp) {
                    return;
                }
                cleanedUp = true;
                await resolution.cleanup?.();
            };
            try {
                res.once("close", () => {
                    void cleanup();
                });
                logHttpDebug("transport.handoff", {
                    ...getRequestDebugDetails(req),
                    ...getJsonRpcDebugDetails(parsedBody),
                    cleanup: Boolean(resolution.cleanup),
                });
                applyCorsHeaders(res);
                await resolution.managedRequest.transport.handleRequest(req, res, parsedBody);
            }
            catch (error) {
                await cleanup();
                throw error;
            }
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                logHttpDebug("request.parse_error", getRequestDebugDetails(req));
                writeParseError(res);
                return;
            }
            console.error("Error handling MCP request:", {
                ...getRequestDebugDetails(req),
                error,
            });
            if (!res.headersSent) {
                writeInternalServerError(res);
            }
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("HTTP server did not expose a TCP address");
    }
    const resolvedAddress = address;
    let closed = false;
    return {
        host,
        path,
        port: resolvedAddress.port,
        url: `http://${host}:${resolvedAddress.port}${path}`,
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            resetPlanResolutionState();
            await closeNodeServer(server);
        },
    };
}
