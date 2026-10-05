import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./env.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * Ties a pending sign-in to the browser that started it. `__Host-` keeps other
 * origins from setting it; SameSite=Lax still sends it on GitHub's redirect back.
 */
const SESSION_COOKIE = "__Host-ynab_mcp_session";
/** How long an approval page or a GitHub round trip stays valid, in seconds. */
const PENDING_TTL = 600;
const APPROVAL_PREFIX = "oauth-approval:";
const STATE_PREFIX = "oauth-state:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type HandlerEnv = WorkerEnv & { OAUTH_PROVIDER: OAuthHelpers; OAUTH_KV: KVNamespace };

/** A sign-in waiting on the owner, stored server-side and never round-tripped. */
interface PendingAuth {
  authRequest: AuthRequest;
  sessionHash: string;
}

/** Props attached to the grant and surfaced to the MCP handler as ctx.props. */
export interface UserProps extends Record<string, unknown> {
  login: string;
  name: string;
}

function html(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}` +
      `code{overflow-wrap:anywhere}button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem}</style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parses ALLOWED_REDIRECT_URIS: exact redirect URIs separated by commas or
 * whitespace. Returns undefined when the setting is absent or blank.
 */
export function parseAllowedRedirectUris(value: string | undefined): string[] | undefined {
  const uris = (value ?? "").split(/[\s,]+/).filter(Boolean);
  return uris.length > 0 ? uris : undefined;
}

function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** True when the redirect is listed exactly, or is an http loopback address for a local client. */
export function isAllowedRedirectUri(uri: string, allowed: string[]): boolean {
  return allowed.includes(uri) || isLoopbackRedirect(uri);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function readSession(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value && TOKEN_PATTERN.test(value)) return value;
  }
  return undefined;
}

/**
 * Loads and consumes a pending sign-in. It must exist and belong to the
 * browser presenting it, so a forged, replayed, or cross-site request fails.
 */
async function takePending(env: HandlerEnv, key: string, session: string | undefined): Promise<PendingAuth | null> {
  if (!session) return null;
  const pending = await env.OAUTH_KV.get<PendingAuth>(key, "json");
  if (!pending || pending.sessionHash !== (await sha256Hex(session))) return null;
  await env.OAUTH_KV.delete(key);
  return pending;
}

const REDIRECT_REFUSED =
  "<h1>Client not allowed</h1><p>This server's ALLOWED_REDIRECT_URIS setting does not include the address this client asked to receive access at.</p>";
const REQUEST_EXPIRED =
  "<h1>Sign-in expired</h1><p>This sign-in request is no longer valid. Start connecting again from your MCP client.</p>";

function approvalPage(env: HandlerEnv, authRequest: AuthRequest, clientName: string | undefined, approvalId: string, session: string) {
  const destination = new URL(authRequest.redirectUri);
  const where = isLoopbackRedirect(authRequest.redirectUri)
    ? "a program on this computer (loopback address)"
    : escapeHtml(destination.host);
  const access = env.YNAB_READ_ONLY === "true" ? "read-only" : "read and write";
  const body =
    `<h1>Allow access to your YNAB plans?</h1>` +
    `<p>A client calling itself <strong>${escapeHtml(clientName || "an unnamed client")}</strong> is asking for ${access} ` +
    `access to every YNAB plan this server can reach.</p>` +
    `<p>If you approve, access is sent to <strong>${where}</strong>:</p>` +
    `<p><code>${escapeHtml(authRequest.redirectUri)}</code></p>` +
    `<p>Any client can choose its own name. Only approve if you just started connecting this server and you recognize that address.</p>` +
    `<form method="post" action="/authorize">` +
    `<input type="hidden" name="approval" value="${approvalId}">` +
    `<button type="submit" name="decision" value="approve">Approve</button>` +
    `<button type="submit" name="decision" value="deny">Deny</button>` +
    `</form>`;
  return html(body, 200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${PENDING_TTL}`,
  });
}

/**
 * Handles the browser-facing half of the OAuth flow: ask the owner to approve
 * the requesting client, bounce them to GitHub, then turn a successful GitHub
 * login into an MCP authorization grant.
 *
 * Client registration is open, so the owner's approval (and, when set,
 * ALLOWED_REDIRECT_URIS) is what decides where a grant may be delivered. The
 * pending request lives in OAUTH_KV and is bound to the browser by a session
 * cookie; nothing the client or GitHub sends back is trusted as the request.
 *
 * Only the login named by ALLOWED_GITHUB_LOGIN is granted. Every other GitHub
 * account is refused, because a grant here means full read/write access to
 * every plan available through YNAB_API_TOKEN.
 */
export const GitHubHandler = {
  async fetch(request: Request, env: HandlerEnv): Promise<Response> {
    const url = new URL(request.url);
    const allowedRedirects = parseAllowedRedirectUris(env.ALLOWED_REDIRECT_URIS);

    if (url.pathname === "/authorize" && request.method === "GET") {
      let authRequest: AuthRequest;
      try {
        authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return html("<h1>Invalid request</h1><p>This endpoint is reached through an MCP client, not directly.</p>", 400);
      }
      if (!authRequest.clientId) {
        return html("<h1>Invalid request</h1><p>Missing client_id.</p>", 400);
      }
      if (allowedRedirects && !isAllowedRedirectUri(authRequest.redirectUri, allowedRedirects)) {
        return html(REDIRECT_REFUSED, 400);
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      const session = readSession(request) ?? randomToken();
      const approvalId = randomToken();
      const pending: PendingAuth = { authRequest, sessionHash: await sha256Hex(session) };
      await env.OAUTH_KV.put(APPROVAL_PREFIX + approvalId, JSON.stringify(pending), { expirationTtl: PENDING_TTL });
      return approvalPage(env, authRequest, client?.clientName, approvalId, session);
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const approvalId = form.get("approval");
      if (typeof approvalId !== "string" || !TOKEN_PATTERN.test(approvalId)) {
        return html(REQUEST_EXPIRED, 400);
      }
      const pending = await takePending(env, APPROVAL_PREFIX + approvalId, readSession(request));
      if (!pending) {
        return html(REQUEST_EXPIRED, 400);
      }
      const { authRequest } = pending;

      if (form.get("decision") !== "approve") {
        const denied = new URL(authRequest.redirectUri);
        denied.searchParams.set("error", "access_denied");
        if (authRequest.state) denied.searchParams.set("state", authRequest.state);
        return Response.redirect(denied.href, 302);
      }

      const state = randomToken();
      await env.OAUTH_KV.put(STATE_PREFIX + state, JSON.stringify(pending), { expirationTtl: PENDING_TTL });

      const redirect = new URL(GITHUB_AUTHORIZE_URL);
      redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      redirect.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
      redirect.searchParams.set("scope", "read:user");
      redirect.searchParams.set("state", state);
      return Response.redirect(redirect.href, 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return html("<h1>Sign-in failed</h1><p>GitHub did not return a code.</p>", 400);
      }
      if (!TOKEN_PATTERN.test(state)) {
        return html(REQUEST_EXPIRED, 400);
      }
      const pending = await takePending(env, STATE_PREFIX + state, readSession(request));
      if (!pending) {
        return html(REQUEST_EXPIRED, 400);
      }
      const { authRequest } = pending;

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

      if (allowedRedirects && !isAllowedRedirectUri(authRequest.redirectUri, allowedRedirects)) {
        return html(REDIRECT_REFUSED, 400);
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
        "<h1>YNAB MCP server</h1><p>This is a private remote MCP server. Add it as a custom connector in your MCP client; " +
          "the connector will walk you through approval and GitHub sign-in.</p>",
      );
    }

    return html("<h1>Not found</h1>", 404);
  },
};
