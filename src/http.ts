#!/usr/bin/env node
import { createRequire } from "node:module";
import * as ynab from "ynab";

import { createHttpServer, isLoopbackAddress } from "./httpServer.js";
import { isReadOnly } from "./registry.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const token = process.env.YNAB_API_TOKEN;
if (!token) {
  console.error("YNAB_API_TOKEN is not set; refusing to start");
  process.exit(1);
}

// Namespaced rather than HOST: some shells (tcsh) export HOST as the machine's
// hostname, which would silently move the bind off loopback.
const host = process.env.YNAB_MCP_HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const readOnly = isReadOnly(process.env.YNAB_READ_ONLY);
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

let server: ReturnType<typeof createHttpServer>;
try {
  server = createHttpServer({
    api: new ynab.API(token),
    readOnly,
    version,
    allowedOrigins: list(process.env.YNAB_MCP_ALLOWED_ORIGINS),
    allowedHosts: list(process.env.YNAB_MCP_ALLOWED_HOSTS),
  });
} catch (error) {
  console.error(`${error instanceof Error ? error.message : error}; refusing to start`);
  process.exit(1);
}

server.listen(port, host, () => {
  console.error(`YNAB MCP server on http://${host}:${port}/mcp${readOnly ? " (read-only)" : ""}`);
  if (!isLoopbackAddress(host) && !readOnly) {
    console.error(
      `Warning: listening on ${host} with write tools enabled and no authentication. ` +
        "Anyone who can reach this port can change your YNAB plan. Keep it on a private network " +
        "or behind an authenticating proxy, or set YNAB_READ_ONLY=true."
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
