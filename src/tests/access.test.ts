import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTPayload,
} from "jose";

import worker from "../worker/index.js";

// Pretend the calendar reminder acted, which is when the Worker purges expired OAuth data.
vi.mock("../worker/nag.js", () => ({ runNag: async () => ({ ran: true }) }));
import type { WorkerEnv } from "../worker/env.js";

const TEAM_DOMAIN = "team.cloudflareaccess.com";
const AUD = "test-aud";
const OWNER_EMAIL = "owner@example.com";

const env: WorkerEnv = {
  YNAB_API_TOKEN: "test-token",
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_ALLOWED_EMAIL: OWNER_EMAIL,
};

let privateKey: CryptoKey;
let otherKey: CryptoKey;
// A team whose signing keys can't be fetched.
const DOWN_TEAM_DOMAIN = "down.cloudflareaccess.com";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "key-1",
    alg: "RS256",
  };

  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      if (url === `https://${DOWN_TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        return new Response("down", { status: 503 });
      }
      return realFetch(input, init);
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function token(
  overrides: {
    claims?: JWTPayload;
    aud?: string;
    iss?: string;
    exp?: string;
    key?: CryptoKey;
  } = {},
) {
  return new SignJWT(overrides.claims ?? { email: OWNER_EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(overrides.iss ?? `https://${TEAM_DOMAIN}`)
    .setAudience(overrides.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(overrides.key ?? privateKey);
}

/** An unsigned token that claims everything a valid one does. */
function unsignedToken() {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUD,
    iat: now,
    exp: now + 300,
  };
  return `${encode({ alg: "none", kid: "key-1" })}.${encode(claims)}.`;
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

async function call(
  path: string,
  assertion?: string,
  overrides: Partial<WorkerEnv> = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (assertion) headers["cf-access-jwt-assertion"] = assertion;
  const request = new Request(`https://ynab.example.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(initialize),
  });
  return worker.fetch(
    request,
    { ...env, ...overrides },
    {} as ExecutionContext,
  );
}

describe("worker.fetch", () => {
  describe("when Cloudflare Access is configured", () => {
    describe("when the request carries a valid Access token", () => {
      it("serves /mcp", async () => {
        const response = await call("/mcp", await token());
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("ynab-mcp-server");
      });

      it.each(["/authorize", "/token", "/register", "/"])(
        "responds to %s with a 404 status",
        async (path) => {
          const response = await call(path, await token());
          expect(response.status).toBe(404);
        },
      );
    });

    describe("when the token's email differs from the allowed one only in case", () => {
      it("serves /mcp", async () => {
        const response = await call(
          "/mcp",
          await token({ claims: { email: "Owner@Example.com" } }),
        );
        expect(response.status).toBe(200);
      });
    });

    describe("when the token belongs to another email", () => {
      it("responds with a 403 status", async () => {
        const response = await call(
          "/mcp",
          await token({ claims: { email: "someone@example.com" } }),
        );
        expect(response.status).toBe(403);
      });
    });

    describe("when the token is a service token", () => {
      it("responds with a 403 status", async () => {
        const response = await call(
          "/mcp",
          await token({ claims: { common_name: "service.access", sub: "" } }),
        );
        expect(response.status).toBe(403);
      });
    });

    describe("when ALLOWED_REDIRECT_URIS is set", () => {
      it("responds with a 500 status", async () => {
        const response = await call("/mcp", await token(), {
          ALLOWED_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback",
        });
        expect(response.status).toBe(500);
      });
    });

    describe("when ALLOWED_REDIRECT_URIS is blank", () => {
      it("serves /mcp", async () => {
        const response = await call("/mcp", await token(), {
          ALLOWED_REDIRECT_URIS: " ",
        });
        expect(response.status).toBe(200);
      });
    });

    describe("when the request has no Access token", () => {
      it("responds with a 401 status", async () => {
        expect((await call("/mcp")).status).toBe(401);
      });
    });

    describe("when the token is for another Access application", () => {
      it("responds with a 401 status", async () => {
        expect(
          (await call("/mcp", await token({ aud: "other-aud" }))).status,
        ).toBe(401);
      });
    });

    describe("when the token is from another team", () => {
      it("responds with a 401 status", async () => {
        const response = await call(
          "/mcp",
          await token({ iss: "https://other.cloudflareaccess.com" }),
        );
        expect(response.status).toBe(401);
      });
    });

    describe("when the token is expired", () => {
      it("responds with a 401 status", async () => {
        expect((await call("/mcp", await token({ exp: "-1m" }))).status).toBe(
          401,
        );
      });
    });

    describe("when the token is signed by another key", () => {
      it("responds with a 401 status", async () => {
        expect(
          (await call("/mcp", await token({ key: otherKey }))).status,
        ).toBe(401);
      });
    });

    describe("when the token is unsigned", () => {
      it("responds with a 401 status", async () => {
        expect((await call("/mcp", unsignedToken())).status).toBe(401);
      });
    });

    describe("when the token is malformed", () => {
      it("responds with a 401 status", async () => {
        expect((await call("/mcp", "not-a-jwt")).status).toBe(401);
      });
    });

    describe("when the signing keys can't be fetched", () => {
      it("responds with a 401 status and logs the failure", async () => {
        const consoleError = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        try {
          const assertion = await token({ iss: `https://${DOWN_TEAM_DOMAIN}` });
          const response = await call("/mcp", assertion, {
            CF_ACCESS_TEAM_DOMAIN: DOWN_TEAM_DOMAIN,
          });
          expect(response.status).toBe(401);
          expect(consoleError).toHaveBeenCalled();
        } finally {
          consoleError.mockRestore();
        }
      });
    });
  });

  describe("when only some Access settings are present", () => {
    it.each([
      [
        "CF_ACCESS_TEAM_DOMAIN",
        { CF_ACCESS_AUD: undefined, CF_ACCESS_ALLOWED_EMAIL: undefined },
      ],
      [
        "CF_ACCESS_AUD",
        { CF_ACCESS_TEAM_DOMAIN: undefined, CF_ACCESS_ALLOWED_EMAIL: undefined },
      ],
      [
        "CF_ACCESS_ALLOWED_EMAIL",
        { CF_ACCESS_TEAM_DOMAIN: undefined, CF_ACCESS_AUD: undefined },
      ],
      [
        "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD",
        { CF_ACCESS_ALLOWED_EMAIL: undefined },
      ],
    ])(
      "responds with a 500 status when only %s is set",
      async (_name, overrides) => {
        const response = await call("/register", await token(), overrides);
        expect(response.status).toBe(500);
      },
    );
  });

  describe("when Cloudflare Access isn't configured", () => {
    it("falls back to the built-in OAuth", async () => {
      const response = await call("/mcp", await token(), {
        CF_ACCESS_TEAM_DOMAIN: undefined,
        CF_ACCESS_AUD: undefined,
        CF_ACCESS_ALLOWED_EMAIL: undefined,
        OAUTH_KV: {} as KVNamespace,
      });
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    });
  });
});

describe("worker.scheduled", () => {
  describe("when Cloudflare Access is configured", () => {
    it("skips the OAuth housekeeping, which has no store to purge", async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as ExecutionContext;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await worker.scheduled({} as ScheduledController, env, ctx);
        await expect(Promise.all(pending)).resolves.toBeDefined();
      } finally {
        log.mockRestore();
      }
    });
  });
});
