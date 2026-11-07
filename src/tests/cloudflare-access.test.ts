import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error -- plain ESM script with no type declarations
import { run } from "../../scripts/cloudflare-access.mjs";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = "acct-1";
const TEAM_DOMAIN = "team.cloudflareaccess.com";
const EMAIL = "owner@example.com";
const CALLBACK = "https://client.example/oauth/callback";

type Json = Record<string, any>;
type Call = { method: string; path: string; body?: Json };

const plainPolicy = (overrides: Json = {}): Json => ({
  id: "pol-mine",
  uid: "policy-uid",
  account_id: ACCOUNT,
  app_count: 1,
  reusable: true,
  name: "Mine",
  precedence: 1,
  decision: "allow",
  include: [{ email: { email: EMAIL } }],
  exclude: [],
  require: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const workerApp = (): Json => ({
  id: "app-w",
  aud: "aud-w",
  name: "ynab-mcp-server",
  type: "self_hosted",
  domain: null,
  destinations: [{ type: "preview_worker", worker_id: "tag-main" }],
  policies: [
    {
      id: "pol-old",
      name: "Old policy",
      decision: "allow",
      precedence: 1,
      include: [{ everyone: {} }],
    },
  ],
  session_duration: "24h",
  allowed_idps: ["idp-1"],
  custom_deny_message: "unrelated field",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const hostnameApp = (): Json => ({
  id: "app-h",
  aud: "aud-h",
  name: "ynab.example.com",
  type: "self_hosted",
  domain: "ynab.example.com",
  destinations: [{ type: "public", uri: "ynab.example.com" }],
  policies: [],
  session_duration: "24h",
});

const otherWorkerApp = (): Json => ({
  id: "app-other",
  aud: "aud-other",
  name: "other",
  type: "self_hosted",
  domain: null,
  destinations: [{ type: "worker", worker_id: "tag-other" }],
  policies: [],
});

const WORKER_DESTINATION_TYPES = new Set(["worker", "preview_worker"]);

/**
 * Mirrors Cloudflare's validation of a self-hosted app body: a public
 * destination needs a `domain`, and a worker destination must not have one
 * (the live API answers error 12130, "domain not included in destinations").
 */
function invalidAppBody(body?: Json): Json | undefined {
  if (body?.type !== "self_hosted") return undefined;
  const destinations: Json[] = body.destinations ?? [];
  const hasWorker = destinations.some((d) => WORKER_DESTINATION_TYPES.has(d.type));
  const hasPublic = destinations.some((d) => d.type === "public");
  if (body.domain && hasWorker) {
    return {
      success: false,
      errors: [{ code: 12130, message: "domain not included in destinations" }],
    };
  }
  if (!body.domain && hasPublic) {
    return { success: false, errors: [{ code: 1000, message: "domain is required" }] };
  }
  return undefined;
}

/** An in-memory stand-in for the parts of the Cloudflare API the script uses. */
function fakeCloudflare(options: { apps?: Json[]; policies?: Json[] } = {}) {
  const apps = new Map<string, Json>(
    (options.apps ?? [workerApp(), hostnameApp(), otherWorkerApp()]).map((a) => [a.id, a]),
  );
  const policies = options.policies ?? [];
  const calls: Call[] = [];
  const failures = new Map<string, Json>();
  let onWrite: (call: Call) => void = () => {};

  const ok = (result: unknown) => ({ success: true, errors: [], result });

  function route(method: string, path: string, body?: Json): [number, Json] {
    const key = `${method} ${path}`;
    if (failures.has(key)) return [400, failures.get(key)!];
    const base = `/accounts/${ACCOUNT}`;
    if (key === "GET /accounts") return [200, ok([{ id: ACCOUNT }])];
    if (key === `GET ${base}/access/organizations`) return [200, ok({ auth_domain: TEAM_DOMAIN })];
    if (key === `GET ${base}/access/identity_providers`) {
      return [200, ok([{ id: "idp-1", type: "onetimepin", name: "PIN" }])];
    }
    if (key === `GET ${base}/workers/scripts`) {
      return [
        200,
        ok([
          { id: "ynab-mcp-server", tag: "tag-main" },
          { id: "other", tag: "tag-other" },
          { id: "trial", tag: "tag-trial" },
        ]),
      ];
    }
    if (key === `GET ${base}/access/apps`) return [200, ok([...apps.values()])];
    if (key === `GET ${base}/access/policies`) return [200, ok(policies)];
    if (key === `POST ${base}/access/policies`) return [200, ok({ ...body, id: "pol-new" })];
    if (key === `POST ${base}/access/apps`) {
      const invalid = invalidAppBody(body);
      if (invalid) return [400, invalid];
      const app = { ...body, id: "app-new", aud: "aud-new" };
      apps.set(app.id, app);
      return [200, ok(app)];
    }
    const match = path.match(new RegExp(`^${base}/access/apps/([^/]+)$`));
    if (match && apps.has(match[1])) {
      const id = match[1];
      const current = apps.get(id)!;
      if (method === "GET") return [200, ok(current)];
      if (method === "PUT") {
        const invalid = invalidAppBody(body);
        if (invalid) return [400, invalid];
        const updated = { ...body, id, aud: current.aud, created_at: current.created_at };
        apps.set(id, updated);
        return [200, ok(updated)];
      }
      if (method === "DELETE") {
        apps.delete(id);
        return [200, ok({ id })];
      }
    }
    return [404, { success: false, errors: [{ code: 7003, message: `no route for ${key}` }] }];
  }

  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(url.startsWith(API)).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const method = init.method ?? "GET";
    const path = url.slice(API.length);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path, body };
    calls.push(call);
    if (method !== "GET") onWrite(call);
    const [status, payload] = route(method, path, body);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  return {
    fetch,
    calls,
    apps,
    writes: () => calls.filter((c) => c.method !== "GET"),
    failOn(method: string, path: string) {
      failures.set(`${method} ${path}`, {
        success: false,
        errors: [{ code: 12130, message: "access.api.error.invalid_request" }],
      });
    },
    beforeWrite(fn: (call: Call) => void) {
      onWrite = fn;
    },
  };
}

let backupDir: string;
let output: string[];
let errors: string[];

beforeEach(() => {
  backupDir = join(mkdtempSync(join(tmpdir(), "cf-access-test-")), "backups");
  output = [];
  errors = [];
  // The script must only use the fetch it is given: no network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network call");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(join(backupDir, ".."), { recursive: true, force: true });
});

function cli(cf: ReturnType<typeof fakeCloudflare>, args: string[], env: Json = {}) {
  return run(args, {
    env: { CLOUDFLARE_API_TOKEN: "test-token", ...env },
    fetch: cf.fetch,
    log: (line: string) => output.push(line),
    error: (line: string) => errors.push(line),
    backupDir,
    now: () => new Date("2026-11-02T12:00:00.000Z"),
  });
}

const text = () => output.join("\n");
const printedBodyAfter = (request: string) => {
  const index = output.indexOf(request);
  expect(index).toBeGreaterThanOrEqual(0);
  return JSON.parse(output[index + 1]);
};
const backups = () => (existsSync(backupDir) ? readdirSync(backupDir) : []);
const readBackup = (name: string) => JSON.parse(readFileSync(join(backupDir, name), "utf8"));
const applyArgs = (target: string[]) => [
  "apply",
  ...target,
  "--email",
  EMAIL,
  "--redirect-uri",
  CALLBACK,
];

describe("inspect", () => {
  it("sends only GETs and shows the matching Worker-level app", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, ["inspect", "--worker", "ynab-mcp-server"])).toBe(0);

    expect(cf.calls.length).toBeGreaterThan(0);
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(text()).toContain(`Team domain: ${TEAM_DOMAIN}`);
    expect(text()).toContain("onetimepin  PIN  idp-1");
    expect(text()).toContain("Access applications for Worker ynab-mcp-server: 1");
    expect(text()).toContain('"id": "app-w"');
    expect(text()).toContain("Old policy");
    expect(text()).not.toContain("app-other");
    expect(text()).not.toContain("app-h");
  });

  it("selects the self-hosted app for --hostname", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, ["inspect", "--hostname", "YNAB.example.com"])).toBe(0);

    expect(cf.writes()).toEqual([]);
    expect(text()).toContain("Access applications for ynab.example.com: 1");
    expect(text()).toContain('"id": "app-h"');
    expect(text()).not.toContain('"id": "app-w"');
    // A hostname needs no Worker lookup.
    expect(cf.calls.some((c) => c.path.endsWith("/workers/scripts"))).toBe(false);
  });

  it("uses CLOUDFLARE_ACCOUNT_ID instead of listing accounts", async () => {
    const cf = fakeCloudflare();
    expect(
      await cli(cf, ["inspect", "--worker", "ynab-mcp-server"], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }),
    ).toBe(0);
    expect(cf.calls.some((c) => c.path === "/accounts")).toBe(false);
  });

  it("prints every ambiguous match and exits non-zero", async () => {
    const second = { ...workerApp(), id: "app-w2", destinations: [{ type: "worker", worker_id: "tag-main" }] };
    const cf = fakeCloudflare({ apps: [workerApp(), second] });

    expect(await cli(cf, ["inspect", "--worker", "ynab-mcp-server"])).toBe(1);
    expect(text()).toContain('"id": "app-w"');
    expect(text()).toContain('"id": "app-w2"');
    expect(errors.join("\n")).toContain("2 Access applications match Worker ynab-mcp-server");
    expect(cf.writes()).toEqual([]);
  });
});

describe("apply", () => {
  it("is a dry run without --yes: prints the request body and sends no writes", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, applyArgs(["--worker", "ynab-mcp-server"]))).toBe(0);

    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(text()).toContain(`POST ${API}/accounts/${ACCOUNT}/access/policies`);
    expect(text()).toContain(`PUT ${API}/accounts/${ACCOUNT}/access/apps/app-w`);
    expect(text()).toContain(`"allowed_uris": [\n        "${CALLBACK}"\n      ]`);
    expect(text()).toContain('"custom_deny_message": "unrelated field"');
    expect(text()).toContain("Nothing was changed");
  });

  it("substitutes only the server-assigned policy ID in the printed app body", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, applyArgs(["--worker", "ynab-mcp-server"]))).toBe(0);

    const policyRequest = `POST ${API}/accounts/${ACCOUNT}/access/policies`;
    const appRequest = `PUT ${API}/accounts/${ACCOUNT}/access/apps/app-w`;
    const dryPolicyBody = printedBodyAfter(policyRequest);
    const dryAppBody = printedBodyAfter(appRequest);
    expect(dryAppBody.policies).toEqual([
      { id: "<server-assigned policy id from the policy POST>", precedence: 1 },
    ]);
    expect(text()).toContain("is the only placeholder");

    output = [];
    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(0);
    const writes = cf.writes();
    expect(writes[0].body).toEqual(dryPolicyBody);
    const expectedAppBody = structuredClone(dryAppBody);
    expectedAppBody.policies[0].id = "pol-new";
    expect(writes[1].body).toEqual(expectedAppBody);
  });

  it("backs up the app before writing and keeps unrelated fields in the PUT", async () => {
    const cf = fakeCloudflare();
    const backupsAtWrite: string[][] = [];
    cf.beforeWrite(() => backupsAtWrite.push(backups()));

    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(0);

    const writes = cf.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `POST /accounts/${ACCOUNT}/access/policies`,
      `PUT /accounts/${ACCOUNT}/access/apps/app-w`,
    ]);
    // The backup existed before the first write.
    expect(backupsAtWrite[0]).toHaveLength(1);
    const backup = readBackup(backupsAtWrite[0][0]);
    expect(backup).toMatchObject({ command: "apply", created: false, account_id: ACCOUNT });
    expect(backup.app).toEqual(workerApp());

    expect(writes[0].body).toEqual({
      name: `Allow ${EMAIL}`,
      decision: "allow",
      include: [{ email: { email: EMAIL } }],
    });
    const put = writes[1].body!;
    expect(put).not.toHaveProperty("id");
    expect(put).not.toHaveProperty("aud");
    expect(put).not.toHaveProperty("created_at");
    expect(put).not.toHaveProperty("updated_at");
    expect(put).toMatchObject({
      name: "ynab-mcp-server",
      type: "self_hosted",
      custom_deny_message: "unrelated field",
      allowed_idps: ["idp-1"],
      session_duration: "24h",
      destinations: [{ type: "worker", worker_id: "tag-main" }],
      policies: [{ id: "pol-new", precedence: 1 }],
      oauth_configuration: {
        enabled: true,
        dynamic_client_registration: {
          enabled: true,
          allowed_uris: [CALLBACK],
          allow_any_on_localhost: false,
          allow_any_on_loopback: false,
        },
        grant: { access_token_lifetime: "15m", session_duration: "336h" },
      },
    });

    expect(text()).toContain(`CF_ACCESS_TEAM_DOMAIN=${TEAM_DOMAIN}`);
    expect(text()).toContain("CF_ACCESS_AUD=aud-w");
  });

  it("reuses an existing Allow policy for the email and passes the optional flags", async () => {
    const cf = fakeCloudflare({
      apps: [workerApp()],
      policies: [
        { id: "pol-broad", decision: "allow", include: [{ everyone: {} }] },
        plainPolicy({ include: [{ email: { email: "Owner@Example.com" } }] }),
      ],
    });
    const args = [
      ...applyArgs(["--worker", "ynab-mcp-server"]),
      "--redirect-uri",
      "https://other.example/cb",
      "--allow-localhost",
      "--token-lifetime",
      "30m",
      "--grant-session",
      "720h",
      "--yes",
    ];
    expect(await cli(cf, args)).toBe(0);

    const writes = cf.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({
      policies: [{ id: "pol-mine", precedence: 1 }],
      oauth_configuration: {
        dynamic_client_registration: {
          allowed_uris: [CALLBACK, "https://other.example/cb"],
          allow_any_on_localhost: true,
          allow_any_on_loopback: false,
        },
        grant: { access_token_lifetime: "30m", session_duration: "720h" },
      },
    });
  });

  it("accepts exact custom-scheme, loopback, and suffix-wildcard callbacks", async () => {
    const cf = fakeCloudflare({
      apps: [workerApp()],
      policies: [plainPolicy()],
    });
    const callbacks = [
      CALLBACK,
      "com.example.client:/oauth/callback",
      "http://127.0.0.1:43123/oauth/callback",
      "http://127.5.6.7/oauth/callback",
      "http://[::1]:43123/oauth/callback",
      "http://localhost:43123/oauth/callback",
      "https://client.example/oauth/*",
    ];
    const args = applyArgs(["--worker", "ynab-mcp-server"]);
    for (const callback of callbacks.slice(1)) args.push("--redirect-uri", callback);

    expect(await cli(cf, [...args, "--allow-localhost", "--allow-loopback", "--yes"])).toBe(0);
    expect(cf.writes()).toHaveLength(1);
    expect(cf.writes()[0].body).toMatchObject({
      oauth_configuration: {
        dynamic_client_registration: {
          allowed_uris: callbacks,
          allow_any_on_localhost: true,
          allow_any_on_loopback: true,
        },
      },
    });
  });

  it("creates a plain policy instead of reusing one with additional access controls", async () => {
    const cf = fakeCloudflare({
      apps: [workerApp()],
      policies: [
        {
          id: "pol-restricted",
          decision: "allow",
          include: [{ email: { email: EMAIL } }],
          approval_required: true,
          approval_groups: [{ approvals_needed: 1, email_addresses: ["admin@example.com"] }],
          purpose_justification_required: true,
          isolation_required: true,
          connection_rules: { ssh: { usernames: ["owner"] } },
          session_duration: "1h",
        },
      ],
    });

    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(0);
    expect(cf.writes().map((write) => write.method)).toEqual(["POST", "PUT"]);
    expect(cf.writes()[0].body).toEqual({
      name: `Allow ${EMAIL}`,
      decision: "allow",
      include: [{ email: { email: EMAIL } }],
    });
    expect(cf.writes()[1].body?.policies).toEqual([{ id: "pol-new", precedence: 1 }]);
  });

  it("creates a Worker-level app when the Worker has none", async () => {
    const cf = fakeCloudflare({ policies: [plainPolicy()] });
    expect(await cli(cf, [...applyArgs(["--worker", "trial"]), "--yes"])).toBe(0);

    const writes = cf.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST /accounts/${ACCOUNT}/access/apps`]);
    expect(writes[0].body).toMatchObject({
      name: "trial",
      type: "self_hosted",
      destinations: [{ type: "worker", worker_id: "tag-trial" }],
      policies: [{ id: "pol-mine", precedence: 1 }],
      oauth_configuration: { enabled: true },
    });
    expect(writes[0].body).not.toHaveProperty("domain");
    expect(text()).toContain("CF_ACCESS_AUD=aud-new");
    const [file] = backups();
    expect(readBackup(file)).toMatchObject({ created: true, app: { id: "app-new" } });
  });

  it("the fake Cloudflare enforces the domain rule for each destination type", () => {
    for (const type of ["worker", "preview_worker"]) {
      const destinations = [{ type, worker_id: "tag-trial" }];
      expect(
        invalidAppBody({ type: "self_hosted", domain: "trial.example.workers.dev", destinations })?.errors[0].code,
      ).toBe(12130);
      expect(invalidAppBody({ type: "self_hosted", destinations })).toBeUndefined();
    }
    const publicDestinations = [{ type: "public", uri: "ynab.example.com" }];
    expect(invalidAppBody({ type: "self_hosted", destinations: publicDestinations })).toBeDefined();
    expect(
      invalidAppBody({ type: "self_hosted", domain: "ynab.example.com", destinations: publicDestinations }),
    ).toBeUndefined();
  });

  it("creates a self-hosted app on the custom domain for --hostname", async () => {
    const cf = fakeCloudflare({ apps: [workerApp()] });
    expect(await cli(cf, [...applyArgs(["--hostname", "ynab.example.com"]), "--yes"])).toBe(0);

    const app = cf.writes().find((w) => w.path.endsWith("/access/apps"))!;
    expect(app.method).toBe("POST");
    expect(app.body).toMatchObject({
      name: "ynab.example.com",
      domain: "ynab.example.com",
      destinations: [{ type: "public", uri: "ynab.example.com" }],
    });
    // The Worker-level app was left alone.
    expect(cf.writes().some((w) => w.path.endsWith("/app-w"))).toBe(false);
  });

  it("accepts worker and preview destinations for the same Worker", async () => {
    const app = workerApp();
    app.destinations = [
      { type: "worker", worker_id: "tag-main" },
      { type: "preview_worker", worker_id: "tag-main" },
    ];
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(0);
    expect(cf.writes()).toHaveLength(1);
    expect(cf.writes()[0].body?.destinations).toEqual([
      { type: "worker", worker_id: "tag-main" },
    ]);
  });

  it("refuses to change a Worker app shared with another destination", async () => {
    const app = workerApp();
    app.destinations.push({ type: "public", uri: "admin.example.com" });
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("other destinations: public:admin.example.com");
    expect(errors.join("\n")).toContain("split them into separate Access applications or use the dashboard");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it("refuses to change a hostname app shared with another destination", async () => {
    const app = hostnameApp();
    app.destinations.push({ type: "public", uri: "admin.example.com" });
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--hostname", "ynab.example.com"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("other destinations: public:admin.example.com");
    expect(errors.join("\n")).toContain("split them into separate Access applications or use the dashboard");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it("refuses a hostname destination with a path", async () => {
    const app = hostnameApp();
    app.domain = "ynab.example.com/admin";
    app.destinations = [{ type: "public", uri: "ynab.example.com/admin" }];
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--hostname", "ynab.example.com"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("public:ynab.example.com/admin");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it("refuses a hostname app with an additional legacy domain", async () => {
    const app = hostnameApp();
    app.self_hosted_domains = ["ynab.example.com", "admin.example.com"];
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--hostname", "ynab.example.com"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("self_hosted_domain:admin.example.com");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it("refuses a hostname destination with overrides", async () => {
    const app = hostnameApp();
    app.destinations[0].overrides = [{ behavior: "public", path_pattern: "/mcp" }];
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--hostname", "ynab.example.com"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("destination overrides on public:ynab.example.com");
    expect(errors.join("\n")).toContain("remove the overrides or use the dashboard");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it("refuses a Worker destination with overrides", async () => {
    const app = workerApp();
    app.destinations[0].overrides = [{ behavior: "bypass", path_pattern: "/mcp" }];
    const cf = fakeCloudflare({ apps: [app], policies: [plainPolicy()] });

    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("destination overrides on preview_worker:tag-main");
    expect(errors.join("\n")).toContain("remove the overrides or use the dashboard");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it("updates the custom-domain app for --hostname without touching its destinations", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, [...applyArgs(["--hostname", "ynab.example.com"]), "--yes"])).toBe(0);

    const put = cf.writes().find((w) => w.method === "PUT")!;
    expect(put.path).toBe(`/accounts/${ACCOUNT}/access/apps/app-h`);
    expect(put.body!.destinations).toEqual([{ type: "public", uri: "ynab.example.com" }]);
    expect(text()).toContain("CF_ACCESS_AUD=aud-h");
  });

  it("refuses when more than one app matches", async () => {
    const second = { ...workerApp(), id: "app-w2", destinations: [{ type: "worker", worker_id: "tag-main" }] };
    const cf = fakeCloudflare({ apps: [workerApp(), second] });
    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(1);

    expect(errors.join("\n")).toContain("2 Access applications match Worker ynab-mcp-server");
    expect(cf.writes()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it.each([
    [["apply", "--worker", "ynab-mcp-server", "--email", EMAIL], "--redirect-uri is required"],
    [["apply", "--worker", "ynab-mcp-server", "--redirect-uri", CALLBACK], "--email is required"],
    [["apply", "--email", EMAIL, "--redirect-uri", CALLBACK], "exactly one of --worker"],
    [
      ["apply", "--worker", "w", "--hostname", "h.example.com", "--email", EMAIL, "--redirect-uri", CALLBACK],
      "exactly one of --worker",
    ],
    [
      [...applyArgs(["--worker", "w"]).slice(0, -1), "http://client.example/cb"],
      "may use http only for a loopback address",
    ],
    [
      [
        ...applyArgs(["--worker", "w"]).slice(0, -1),
        "http://127.example.com/cb",
        "--allow-loopback",
      ],
      "may use http only for a loopback address",
    ],
    [
      [...applyArgs(["--worker", "w"]).slice(0, -1), "https://client.example/*/callback"],
      "may use a wildcard only as a final /* HTTP(S) path suffix",
    ],
    [
      [...applyArgs(["--worker", "w"]).slice(0, -1), "https://client.example/callback?next=/*"],
      "may use a wildcard only as a final /* HTTP(S) path suffix",
    ],
    [
      [...applyArgs(["--worker", "w"]).slice(0, -1), "com.example.client:/oauth/*"],
      "may use a wildcard only as a final /* HTTP(S) path suffix",
    ],
    [[...applyArgs(["--worker", "w"]), "--grant-session", "two weeks"], "must be a duration"],
    [[...applyArgs(["--hostname", "https://ynab.example.com/"])], "must be a bare hostname"],
    [[...applyArgs(["--hostname", "ynab.example.com/path"])], "must be a bare hostname"],
  ])("refuses a missing or invalid input: %j", async (args, message) => {
    const cf = fakeCloudflare();
    expect(await cli(cf, [...args, "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain(message);
    expect(cf.calls).toEqual([]);
  });

  it("refuses to run without an API token", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, ["inspect", "--worker", "ynab-mcp-server"], { CLOUDFLARE_API_TOKEN: "" })).toBe(1);
    expect(errors.join("\n")).toContain("CLOUDFLARE_API_TOKEN is not set");
    expect(cf.calls).toEqual([]);
  });

  it("stops on an API error", async () => {
    const cf = fakeCloudflare();
    cf.failOn("POST", `/accounts/${ACCOUNT}/access/policies`);
    expect(await cli(cf, [...applyArgs(["--worker", "ynab-mcp-server"]), "--yes"])).toBe(1);

    expect(errors.join("\n")).toContain("access.api.error.invalid_request");
    expect(cf.writes().map((w) => w.method)).toEqual(["POST"]);
    expect(text()).not.toContain("CF_ACCESS_AUD");
  });

  it("stops when the Worker does not exist", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, [...applyArgs(["--worker", "missing"]), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain('no Worker named "missing"');
    expect(cf.writes()).toEqual([]);
  });
});

describe("rollback", () => {
  async function applied(cf: ReturnType<typeof fakeCloudflare>, target: string[]) {
    expect(await cli(cf, [...applyArgs(target), "--yes"])).toBe(0);
    const [file] = backups();
    output = [];
    cf.calls.length = 0;
    return join(backupDir, file);
  }

  it("restores the backed-up destinations, policies and OAuth settings", async () => {
    const cf = fakeCloudflare();
    const backup = await applied(cf, ["--worker", "ynab-mcp-server"]);

    expect(await cli(cf, ["rollback", "--from", backup])).toBe(0);
    expect(cf.writes()).toEqual([]);
    expect(text()).toContain(`PUT ${API}/accounts/${ACCOUNT}/access/apps/app-w`);

    expect(await cli(cf, ["rollback", "--from", backup, "--yes"])).toBe(0);
    const put = cf.writes()[0];
    expect(put.method).toBe("PUT");
    expect(put.body).toMatchObject({
      custom_deny_message: "unrelated field",
      destinations: [{ type: "preview_worker", worker_id: "tag-main" }],
      policies: [{ id: "pol-old", precedence: 1 }],
      oauth_configuration: { enabled: false },
    });
    expect(put.body).not.toHaveProperty("id");
    // The state before the rollback was backed up too.
    expect(backups().filter((f) => f.includes("rollback-app-w"))).toHaveLength(1);
  });

  it("deletes the app when apply created it", async () => {
    const cf = fakeCloudflare({ apps: [] });
    const backup = await applied(cf, ["--worker", "trial"]);
    expect(cf.apps.has("app-new")).toBe(true);

    expect(await cli(cf, ["rollback", "--from", backup])).toBe(0);
    expect(cf.writes()).toEqual([]);
    expect(text()).toContain(`DELETE ${API}/accounts/${ACCOUNT}/access/apps/app-new`);

    expect(await cli(cf, ["rollback", "--from", backup, "--yes"])).toBe(0);
    expect(cf.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      `DELETE /accounts/${ACCOUNT}/access/apps/app-new`,
    ]);
    expect(cf.apps.has("app-new")).toBe(false);
  });

  it("refuses a file that is not an apply backup", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, ["rollback", "--from", join(backupDir, "missing.json"), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("cannot read backup");
    expect(await cli(cf, ["rollback", "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("--from <backup file> is required");
    expect(cf.calls).toEqual([]);
  });
});

describe("command-line interface", () => {
  it.each([["help"], ["--help"], ["-h"]])("prints usage for %j", async (...args) => {
    const cf = fakeCloudflare();
    expect(await cli(cf, args)).toBe(0);
    expect(text()).toContain("Usage: npm run cf-access");
    expect(cf.calls).toEqual([]);
  });

  it.each([
    [["inspect", "--worker", "ynab-mcp-server", "--email", EMAIL], "--email does not apply to inspect"],
    [[...applyArgs(["--worker", "ynab-mcp-server"]), "--from", "backup.json"], "--from does not apply to apply"],
    [["rollback", "--from", "backup.json", "--worker", "ynab-mcp-server"], "--worker does not apply to rollback"],
  ])("rejects command-inapplicable options: %j", async (args, message) => {
    const cf = fakeCloudflare();
    expect(await cli(cf, args)).toBe(1);
    expect(errors.join("\n")).toContain(message);
    expect(cf.calls).toEqual([]);
  });

  it("rejects unknown commands", async () => {
    const cf = fakeCloudflare();
    expect(await cli(cf, ["launch"])).toBe(1);
    expect(errors.join("\n")).toContain('unknown command "launch"');
    expect(cf.calls).toEqual([]);
  });
});
