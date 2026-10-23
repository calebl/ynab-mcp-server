import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as ynab from "ynab";

import { isReadOnly, registerAll, registerTools } from "../registry.js";
import { autobudgetTools } from "./autobudget/tools.js";
import type { WorkerEnv } from "./env.js";

// Bound nested tool arguments before schema validation can exhaust resources.
const MAX_TOOL_INPUT_ELEMENTS = 10_000;
// Keep authenticated MCP request bodies within the Worker's practical needs.
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

/**
 * The tool modules read configuration from `process.env` (they were written for
 * the stdio server). Workers has no ambient environment, so mirror the bindings
 * onto `process.env` before building the server. Safe here because this Worker
 * uses one server-wide YNAB credential rather than per-request credentials.
 */
function applyEnv(env: WorkerEnv) {
  process.env.YNAB_API_TOKEN = env.YNAB_API_TOKEN;
  const optionalBindings: Array<[string, string | undefined]> = [
    ["YNAB_PLAN_ID", env.YNAB_PLAN_ID],
    ["YNAB_BUDGET_ID", env.YNAB_BUDGET_ID],
    ["TYPESAFE_API_KEY", env.TYPESAFE_API_KEY],
    ["YNAB_AI_CATEGORIZATION", env.YNAB_AI_CATEGORIZATION],
    ["YNAB_AI_TYPICAL_PAYEES", env.YNAB_AI_TYPICAL_PAYEES],
  ];
  for (const [name, value] of optionalBindings) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export function createServer(env: WorkerEnv) {
  applyEnv(env);

  const server = new McpServer({
    name: "ynab-mcp-server",
    version: "0.7.0",
  }, {
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
  });

  const api = new ynab.API(env.YNAB_API_TOKEN);
  const readOnly = isReadOnly(env.YNAB_READ_ONLY);
  registerAll(server, api, { readOnly });
  // The auto-budget tools keep their state in D1, which only the Worker has.
  if (env.AUTOBUDGET_DB) registerTools(server, api, autobudgetTools(env), { readOnly });

  return server;
}

/**
 * Serves /mcp. Behind OAuthProvider this is only reached with a valid access
 * token, so every request here belongs to an authorized grant.
 */
export const McpApiHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const handler = createMcpHandler(() => createServer(env), {
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    });
    try {
      return await handler.fetch(request);
    } finally {
      await handler.close();
    }
  },
};
