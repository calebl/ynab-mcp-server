import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { GitHubHandler } from "./github-handler.js";
import { McpApiHandler } from "./mcp.js";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler as any,
  defaultHandler: GitHubHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
