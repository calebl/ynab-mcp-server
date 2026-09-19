import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { GitHubHandler } from "./github-handler.js";
import { McpApiHandler } from "./mcp.js";
import { runNag } from "./nag.js";
import type { WorkerEnv } from "./env.js";

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler as any,
  defaultHandler: GitHubHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return provider.fetch(request, env as any, ctx);
  },

  /**
   * Runs hourly. The nag itself only acts in the configured local hour, so the
   * reminder holds its wall-clock time through daylight saving changes.
   */
  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const outcome = await runNag(env);
      console.log("nag:", JSON.stringify(outcome));

      if (outcome.ran) {
        // Piggyback the OAuth housekeeping on a run that already did work.
        const purged = await provider.purgeExpiredData(env as any);
        console.log("oauth purge:", JSON.stringify(purged));
      }
    })());
  },
};
