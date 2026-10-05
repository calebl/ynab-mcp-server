import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import worker from "../worker/index.js";
import { isAllowedRedirectUri, parseAllowedRedirectUris } from "../worker/github-handler.js";

/**
 * Drives the real Worker entry (OAuth provider + GitHub handler + MCP handler)
 * with an in-memory KV and GitHub stubbed out, to check when and where grants
 * can be delivered.
 */

const ORIGIN = "https://ynab-mcp.example.workers.dev";
const OWNER = "owner";
const ATTACKER_CB = "https://attacker.example/cb";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CB = "https://chatgpt.com/connector_platform_oauth_redirect";
const LOOPBACK_CB = "http://localhost:53682/callback";

class MemoryKV {
  store = new Map<string, string>();
  async get(key: string, options?: string | { type?: string }) {
    const value = this.store.get(key);
    if (value === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(options: { prefix?: string } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(options.prefix ?? "")).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

function makeEnv(overrides: Record<string, string> = {}) {
  return {
    YNAB_API_TOKEN: "test-token",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ALLOWED_GITHUB_LOGIN: OWNER,
    OAUTH_KV: new MemoryKV(),
    ...overrides,
  } as any;
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

/** URLs the Worker fetched; GitHub answers as the allowed owner. */
const githubCalls: string[] = [];

function base64url(bytes: Uint8Array | string) {
  const binary = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const VERIFIER = "test-verifier-" + "x".repeat(43);
async function challenge() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return base64url(new Uint8Array(digest));
}

function grants(env: any) {
  return [...env.OAUTH_KV.store.keys()].filter((k: string) => k.startsWith("grant:"));
}

async function register(env: any, redirectUri: string, clientName = "Test client") {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: clientName }),
    }),
    env,
    ctx,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorize(env: any, clientId: string, redirectUri: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: await challenge(),
    code_challenge_method: "S256",
    state: "client-state",
  });
  return worker.fetch(new Request(`${ORIGIN}/authorize?${params}`), env, ctx);
}

/** Reads the session cookie and approval id the approval page hands the browser. */
async function approvalFrom(response: Response) {
  const page = await response.text();
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const approvalId = /name="approval" value="([^"]+)"/.exec(page)![1];
  return { page, cookie, approvalId };
}

function decide(env: any, approvalId: string, decision: "approve" | "deny", cookie?: string) {
  return worker.fetch(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams({ approval: approvalId, decision }),
    }),
    env,
    ctx,
  );
}

function callback(env: any, state: string, cookie?: string) {
  return worker.fetch(
    new Request(`${ORIGIN}/callback?code=gh-code&state=${state}`, { headers: cookie ? { cookie } : {} }),
    env,
    ctx,
  );
}

/** Registers and approves a client, returning GitHub's state and the browser's cookie. */
async function approveUpToGitHub(env: any, redirectUri: string) {
  const clientId = await register(env, redirectUri);
  const { cookie, approvalId } = await approvalFrom(await authorize(env, clientId, redirectUri));
  const approved = await decide(env, approvalId, "approve", cookie);
  expect(approved.status).toBe(302);
  const github = new URL(approved.headers.get("location")!);
  expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
  return { clientId, cookie, state: github.searchParams.get("state")! };
}

function exchange(env: any, clientId: string, redirectUri: string, code: string) {
  return worker.fetch(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: VERIFIER,
      }),
    }),
    env,
    ctx,
  );
}

describe("parseAllowedRedirectUris", () => {
  it.each([undefined, "", "   ", " , "])("treats %j as unset", (value) => {
    expect(parseAllowedRedirectUris(value)).toBeUndefined();
  });

  it("splits on commas and whitespace", () => {
    expect(parseAllowedRedirectUris(`${CLAUDE_CB}, ${CHATGPT_CB}\nhttps://example.com/cb`)).toEqual([
      CLAUDE_CB,
      CHATGPT_CB,
      "https://example.com/cb",
    ]);
  });
});

describe("isAllowedRedirectUri", () => {
  const allowed = [CLAUDE_CB, CHATGPT_CB];

  it.each([CLAUDE_CB, CHATGPT_CB, LOOPBACK_CB, "http://127.0.0.1:9000/cb", "http://[::1]:9000/cb"])(
    "allows %s",
    (uri) => {
      expect(isAllowedRedirectUri(uri, allowed)).toBe(true);
    },
  );

  it.each([
    ATTACKER_CB,
    "https://claude.ai.attacker.example/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback.attacker.example",
    "https://claude.ai/api/mcp/auth_callback?next=https://attacker.example",
    "https://claude.ai/api/mcp/auth_callback/../evil",
    "http://claude.ai/api/mcp/auth_callback",
    "http://localhost.attacker.example/cb",
    "https://localhost/cb",
    "http://127.0.0.2:9000/cb",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "not a url",
    "",
  ])("refuses %s", (uri) => {
    expect(isAllowedRedirectUri(uri, allowed)).toBe(false);
  });
});

describe("Worker OAuth flow", () => {
  beforeEach(() => {
    githubCalls.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      githubCalls.push(url);
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_test" });
      if (url === "https://api.github.com/user") return Response.json({ login: OWNER, name: "Owner" });
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("reported attack paths", () => {
    it("asks the owner before sending any newly registered client to GitHub", async () => {
      const env = makeEnv();
      const clientId = await register(env, ATTACKER_CB, "Claude");

      const response = await authorize(env, clientId, ATTACKER_CB);

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      const { page } = await approvalFrom(response);
      expect(page).toContain("Claude");
      expect(page).toContain("<strong>attacker.example</strong>");
      expect(page).toContain(ATTACKER_CB);
      expect(githubCalls).toEqual([]);
      expect(grants(env)).toEqual([]);
    });

    it("refuses an approval posted without the owner's session", async () => {
      const env = makeEnv();
      const clientId = await register(env, ATTACKER_CB);
      const { approvalId } = await approvalFrom(await authorize(env, clientId, ATTACKER_CB));

      expect((await decide(env, approvalId, "approve")).status).toBe(400);
      expect((await decide(env, approvalId, "approve", `__Host-ynab_mcp_session=${"a".repeat(43)}`)).status).toBe(400);
      expect(githubCalls).toEqual([]);
    });

    it("refuses a forged unsigned state at /callback without contacting GitHub", async () => {
      const env = makeEnv();
      const clientId = await register(env, ATTACKER_CB);
      const { cookie } = await approvalFrom(await authorize(env, clientId, ATTACKER_CB));
      const forged = base64url(
        JSON.stringify({
          responseType: "code",
          clientId,
          redirectUri: ATTACKER_CB,
          scope: [],
          state: "",
          codeChallenge: await challenge(),
          codeChallengeMethod: "S256",
        }),
      );

      for (const session of [undefined, cookie]) {
        const response = await callback(env, forged, session);
        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
      }
      expect(githubCalls).toEqual([]);
      expect(grants(env)).toEqual([]);
    });

    it("refuses a genuine state presented by a different browser", async () => {
      const env = makeEnv();
      const { state } = await approveUpToGitHub(env, CLAUDE_CB);

      expect((await callback(env, state)).status).toBe(400);
      expect((await callback(env, state, `__Host-ynab_mcp_session=${"b".repeat(43)}`)).status).toBe(400);
      expect(githubCalls).toEqual([]);
      expect(grants(env)).toEqual([]);
    });
  });

  describe("approval page", () => {
    it.each([CLAUDE_CB, CHATGPT_CB, LOOPBACK_CB])("completes sign-in for %s once approved", async (redirectUri) => {
      const env = makeEnv();
      const { clientId, cookie, state } = await approveUpToGitHub(env, redirectUri);

      const completed = await callback(env, state, cookie);
      expect(completed.status).toBe(302);
      const location = completed.headers.get("location")!;
      expect(location.startsWith(`${redirectUri}?`)).toBe(true);

      const token = await exchange(env, clientId, redirectUri, new URL(location).searchParams.get("code")!);
      expect(token.status).toBe(200);
      expect(((await token.json()) as { access_token?: string }).access_token).toBeTruthy();
    });

    it("returns access_denied to the client and never contacts GitHub when denied", async () => {
      const env = makeEnv();
      const clientId = await register(env, CLAUDE_CB);
      const { cookie, approvalId } = await approvalFrom(await authorize(env, clientId, CLAUDE_CB));

      const denied = await decide(env, approvalId, "deny", cookie);

      expect(denied.status).toBe(302);
      const location = new URL(denied.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(CLAUDE_CB);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("state")).toBe("client-state");
      expect(githubCalls).toEqual([]);
      expect(grants(env)).toEqual([]);
    });

    it("uses each approval and each GitHub state only once", async () => {
      const env = makeEnv();
      const clientId = await register(env, CLAUDE_CB);
      const { cookie, approvalId } = await approvalFrom(await authorize(env, clientId, CLAUDE_CB));
      const approved = await decide(env, approvalId, "approve", cookie);
      const state = new URL(approved.headers.get("location")!).searchParams.get("state")!;

      expect((await decide(env, approvalId, "approve", cookie)).status).toBe(400);
      expect((await callback(env, state, cookie)).status).toBe(302);
      expect((await callback(env, state, cookie)).status).toBe(400);
    });

    it("escapes the client name and cannot be framed", async () => {
      const env = makeEnv();
      const clientId = await register(env, CLAUDE_CB, '<script>alert("x")</script>');

      const response = await authorize(env, clientId, CLAUDE_CB);
      const { page } = await approvalFrom(response);

      expect(page).not.toContain("<script>");
      expect(page).toContain("&lt;script&gt;");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    });

    it("says when the server is read-only", async () => {
      const env = makeEnv({ YNAB_READ_ONLY: "true" });
      const clientId = await register(env, CLAUDE_CB);

      const { page } = await approvalFrom(await authorize(env, clientId, CLAUDE_CB));

      expect(page).toContain("read-only access");
    });
  });

  describe("ALLOWED_REDIRECT_URIS", () => {
    const allowlist = { ALLOWED_REDIRECT_URIS: `${CLAUDE_CB},${CHATGPT_CB}` };

    it("refuses an unlisted redirect at /authorize without showing the approval page", async () => {
      const env = makeEnv(allowlist);
      const clientId = await register(env, ATTACKER_CB);

      const response = await authorize(env, clientId, ATTACKER_CB);

      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toContain('name="approval"');
    });

    it.each([CHATGPT_CB, LOOPBACK_CB])("still asks for approval for allowed %s, then completes", async (redirectUri) => {
      const env = makeEnv(allowlist);
      const clientId = await register(env, redirectUri);

      const response = await authorize(env, clientId, redirectUri);
      expect(response.status).toBe(200);
      const { cookie, approvalId } = await approvalFrom(response);
      const approved = await decide(env, approvalId, "approve", cookie);
      const state = new URL(approved.headers.get("location")!).searchParams.get("state")!;

      const completed = await callback(env, state, cookie);
      expect(completed.status).toBe(302);
      expect(completed.headers.get("location")!.startsWith(`${redirectUri}?`)).toBe(true);
    });

    it("is enforced again at /callback before the grant is issued", async () => {
      const env = makeEnv();
      const { cookie, state } = await approveUpToGitHub(env, ATTACKER_CB);

      env.ALLOWED_REDIRECT_URIS = CLAUDE_CB;
      const response = await callback(env, state, cookie);

      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(grants(env)).toEqual([]);
    });

    it("is ignored when blank", async () => {
      const env = makeEnv({ ALLOWED_REDIRECT_URIS: " " });
      const clientId = await register(env, ATTACKER_CB);

      expect((await authorize(env, clientId, ATTACKER_CB)).status).toBe(200);
    });
  });
});
