import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./env.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/** Props attached to the grant and surfaced to the MCP handler as ctx.props. */
export interface UserProps extends Record<string, unknown> {
  login: string;
  name: string;
}

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Encodes the pending OAuth request into the GitHub `state` parameter so the
 * callback can resume it. Signed by GitHub's own round trip, and short-lived.
 */
function encodeState(req: AuthRequest): string {
  return btoa(JSON.stringify(req)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeState(state: string): AuthRequest {
  const padded = state.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded));
}

/**
 * Handles the browser-facing half of the OAuth flow: bounce the user to GitHub,
 * then turn a successful GitHub login into an MCP authorization grant.
 *
 * Only the login named by ALLOWED_GITHUB_LOGIN is granted. Every other GitHub
 * account is refused, because a grant here means full read/write access to the
 * budget behind YNAB_API_TOKEN.
 */
export const GitHubHandler = {
  async fetch(request: Request, env: WorkerEnv & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      let authRequest: AuthRequest;
      try {
        authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return html("<h1>Invalid request</h1><p>This endpoint is reached through an MCP client, not directly.</p>", 400);
      }
      if (!authRequest.clientId) {
        return html("<h1>Invalid request</h1><p>Missing client_id.</p>", 400);
      }

      const redirect = new URL(GITHUB_AUTHORIZE_URL);
      redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      redirect.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
      redirect.searchParams.set("scope", "read:user");
      redirect.searchParams.set("state", encodeState(authRequest));
      return Response.redirect(redirect.href, 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return html("<h1>Sign-in failed</h1><p>GitHub did not return a code.</p>", 400);
      }

      let authRequest: AuthRequest;
      try {
        authRequest = decodeState(state);
      } catch {
        return html("<h1>Sign-in failed</h1><p>The request state was malformed.</p>", 400);
      }

      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: new URL("/callback", request.url).href,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
      if (!tokenBody.access_token) {
        return html(`<h1>Sign-in failed</h1><p>GitHub rejected the code (${tokenBody.error ?? "unknown"}).</p>`, 401);
      }

      const userResponse = await fetch(GITHUB_USER_URL, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${tokenBody.access_token}`,
          "user-agent": "ynab-mcp-server",
        },
      });
      if (!userResponse.ok) {
        return html("<h1>Sign-in failed</h1><p>Could not read your GitHub profile.</p>", 401);
      }
      const user = (await userResponse.json()) as { login: string; name: string | null };

      const allowed = env.ALLOWED_GITHUB_LOGIN.toLowerCase();
      if (user.login.toLowerCase() !== allowed) {
        return html(
          `<h1>Access denied</h1><p>This server is private. The account <strong>${user.login}</strong> is not permitted.</p>`,
          403,
        );
      }

      const props: UserProps = { login: user.login, name: user.name ?? user.login };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: user.login,
        metadata: { label: user.name ?? user.login },
        scope: authRequest.scope,
        props,
      });

      return Response.redirect(redirectTo, 302);
    }

    if (url.pathname === "/") {
      return html(
        "<h1>YNAB MCP server</h1><p>This is a private remote MCP server. Add it as a custom connector in Claude; " +
          "the connector will walk you through GitHub sign-in.</p>",
      );
    }

    return html("<h1>Not found</h1>", 404);
  },
};
