#!/usr/bin/env node
import { createRequire } from "node:module";
import * as ynab from "ynab";

import { createHttpServer } from "./httpServer.js";
import { isReadOnly } from "./registry.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const token = process.env.YNAB_API_TOKEN;
if (!token) {
  console.error("YNAB_API_TOKEN is not set; refusing to start");
  process.exit(1);
}

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const readOnly = isReadOnly(process.env.YNAB_READ_ONLY);

const server = createHttpServer({
  api: new ynab.API(token),
  readOnly,
  version,
});

server.listen(port, host, () => {
  console.error(`YNAB MCP server on http://${host}:${port}/mcp${readOnly ? " (read-only)" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
