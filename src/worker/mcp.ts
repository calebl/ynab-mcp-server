import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as ynab from "ynab";

import { registerAll } from "../registry.js";
import type { WorkerEnv } from "./env.js";

/**
 * The tool modules read configuration from `process.env` (they were written for
 * the stdio server). Workers has no ambient environment, so mirror the bindings
 * onto `process.env` before building the server. Safe here because this Worker
 * serves exactly one YNAB account.
 */
function applyEnv(env: WorkerEnv) {
  process.env.YNAB_API_TOKEN = env.YNAB_API_TOKEN;
  if (env.YNAB_BUDGET_ID) {
    process.env.YNAB_BUDGET_ID = env.YNAB_BUDGET_ID;
  }
}

export function createServer(env: WorkerEnv) {
  applyEnv(env);

  const server = new McpServer({
    name: "ynab-mcp-server",
    version: "0.2.0",
  });

  const api = new ynab.API(env.YNAB_API_TOKEN);
  registerAll(server, api, { readOnly: env.YNAB_READ_ONLY === "true" });

  return server;
}

/**
 * Serves /mcp. Behind OAuthProvider this is only reached with a valid access
 * token, so every request here belongs to an authorized grant.
 */
export const McpApiHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const handler = createMcpHandler(() => createServer(env));
    try {
      return await handler.fetch(request);
    } finally {
      await handler.close();
    }
  },
};
