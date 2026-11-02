#!/usr/bin/env node
// Sets up Cloudflare Access sign-in (Managed OAuth) for the Worker from the
// command line. See DEPLOY.md, "Cloudflare Access".
//
//   npm run cf-access -- inspect  (--worker <name> | --hostname <host>)
//   npm run cf-access -- apply    (--worker <name> | --hostname <host>)
//                                 --email <you> --redirect-uri <uri> [...] [--yes]
//   npm run cf-access -- rollback --from <backup.json> [--yes]
//
// Talks only to the Cloudflare v4 API. Reads the API token from
// CLOUDFLARE_API_TOKEN and, optionally, the account from CLOUDFLARE_ACCOUNT_ID.
// `apply` and `rollback` print what they would send unless given --yes.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";
const DEFAULT_BACKUP_DIR = ".cloudflare-access";
// Fields the API sets itself; a PUT body leaves them out.
const READ_ONLY_APP_FIELDS = ["id", "aud", "created_at", "updated_at"];
const WORKER_DESTINATIONS = new Set(["worker", "preview_worker"]);
const DURATION = /^\d+(\.\d+)?(s|m|h)$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const PENDING_POLICY_ID = "<server-assigned policy id from the policy POST>";
const PLAIN_POLICY_FIELDS = new Set([
  "id",
  "uid",
  "account_id",
  "app_count",
  "reusable",
  "name",
  "decision",
  "include",
  "exclude",
  "require",
  "precedence",
  "created_at",
  "updated_at",
]);

const USAGE = `Usage: npm run cf-access -- <command> [options]

Commands:
  help      Show this help (also --help or -h).
  inspect   Show the team domain, login methods, and the matching Access
            application with its policies and Managed OAuth settings.
            Read-only.
  apply     Create or reuse an Allow policy for --email, then create or update
            the Access application with Managed OAuth and the redirect
            allowlist. Prints CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.
  rollback  Undo an apply from its backup file: restore the destinations,
            policies and Managed OAuth settings, or delete the application if
            apply created it.

Target (inspect and apply; exactly one):
  --worker <name>         Worker-level Access for this Worker (all traffic,
                          including its workers.dev address)
  --hostname <host>       Self-hosted Access application on a custom domain

apply options:
  --email <address>       Identity the Allow policy admits (required)
  --redirect-uri <uri>    Exact https, loopback http, or custom-scheme callback
                          URI of an MCP client (required, repeatable). HTTP(S)
                          paths may use one wildcard as a final /* suffix.
  --allow-localhost       Admit any client redirecting to localhost
  --allow-loopback        Admit any client redirecting to a loopback address
  --token-lifetime <d>    Access token lifetime (default 15m)
  --grant-session <d>     How long a sign-in lasts before the client has to
                          sign in again (default 336h)

rollback options:
  --from <file>           Backup written by apply (required)

  --yes                   Send the changes. Without it, apply and rollback
                          only print the requests they would make. If apply
                          must create a policy, the app body labels its one
                          placeholder for the policy ID assigned by Cloudflare;
                          that ID is the only value substituted with --yes.

Environment:
  CLOUDFLARE_API_TOKEN    API token (required)
  CLOUDFLARE_ACCOUNT_ID   Account to use when the token sees more than one
`;

class CliError extends Error {}

const fail = (message) => {
  throw new CliError(message);
};

const json = (value) => JSON.stringify(value, null, 2);

/**
 * Runs one command. Returns the process exit code.
 *
 * @param {string[]} argv arguments after the script name
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 *   backupDir?: string,
 *   now?: () => Date,
 * }} [deps]
 */
export async function run(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  try {
    await dispatch(argv, {
      env: deps.env ?? process.env,
      fetch: deps.fetch ?? globalThis.fetch,
      log,
      backupDir: deps.backupDir ?? DEFAULT_BACKUP_DIR,
      now: deps.now ?? (() => new Date()),
    });
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    error(`error: ${err.message}`);
    return 1;
  }
}

async function dispatch(argv, ctx) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        worker: { type: "string" },
        hostname: { type: "string" },
        email: { type: "string" },
        "redirect-uri": { type: "string", multiple: true },
        "allow-localhost": { type: "boolean" },
        "allow-loopback": { type: "boolean" },
        "token-lifetime": { type: "string" },
        "grant-session": { type: "string" },
        from: { type: "string" },
        yes: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (values.help || !command || command === "help") {
    ctx.log(USAGE);
    return;
  }
  if (extra.length) fail(`unexpected argument: ${extra[0]}`);

  if (command === "inspect") {
    rejectInapplicableOptions(values, command, ["worker", "hostname"]);
    return inspect(values, ctx);
  }
  if (command === "apply") {
    rejectInapplicableOptions(values, command, [
      "worker",
      "hostname",
      "email",
      "redirect-uri",
      "allow-localhost",
      "allow-loopback",
      "token-lifetime",
      "grant-session",
      "yes",
    ]);
    return apply(values, ctx);
  }
  if (command === "rollback") {
    rejectInapplicableOptions(values, command, ["from", "yes"]);
    return rollback(values, ctx);
  }
  fail(`unknown command "${command}"\n\n${USAGE}`);
}

function rejectInapplicableOptions(values, command, allowed) {
  const allowedSet = new Set([...allowed, "help"]);
  const invalid = Object.keys(values).find((name) => !allowedSet.has(name));
  if (invalid) fail(`--${invalid} does not apply to ${command}`);
}

// ---------------------------------------------------------------------------
// Cloudflare API

function client(ctx) {
  const token = ctx.env.CLOUDFLARE_API_TOKEN;
  if (!token) fail("CLOUDFLARE_API_TOKEN is not set");

  async function request(method, path, body) {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res;
    try {
      res = await ctx.fetch(`${API}${path}`, init);
    } catch (err) {
      fail(`${method} ${path} failed: ${err.message}`);
    }
    let payload;
    try {
      payload = await res.json();
    } catch {
      fail(`${method} ${path} failed: HTTP ${res.status} with a non-JSON body`);
    }
    if (!res.ok || !payload?.success) {
      const messages = (payload?.errors ?? [])
        .map((e) => (e.code ? `${e.code} ${e.message}` : e.message))
        .join("; ");
      fail(`${method} ${path} failed: HTTP ${res.status}${messages ? `: ${messages}` : ""}`);
    }
    return payload;
  }

  return {
    async get(path) {
      return (await request("GET", path)).result;
    },
    // Every page of a list endpoint.
    async list(path) {
      const first = await request("GET", path);
      const items = [...(first.result ?? [])];
      const pages = first.result_info?.total_pages ?? 1;
      for (let page = 2; page <= pages; page++) {
        const sep = path.includes("?") ? "&" : "?";
        items.push(...((await request("GET", `${path}${sep}page=${page}`)).result ?? []));
      }
      return items;
    },
    async send(method, path, body) {
      return (await request(method, path, body)).result;
    },
  };
}

async function accountId(api, ctx) {
  if (ctx.env.CLOUDFLARE_ACCOUNT_ID) return ctx.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await api.list("/accounts");
  if (accounts.length !== 1) {
    fail(
      `the token can see ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID to choose one`,
    );
  }
  return accounts[0].id;
}

// ---------------------------------------------------------------------------
// Target selection

function readTarget(values) {
  const hasWorker = values.worker !== undefined;
  const hasHostname = values.hostname !== undefined;
  if (hasWorker === hasHostname) fail("pass exactly one of --worker <name> or --hostname <host>");
  if (hasWorker) {
    if (!values.worker) fail("--worker needs a Worker name");
    return { kind: "worker", name: values.worker };
  }
  const rawHost = values.hostname;
  if (!rawHost || rawHost !== rawHost.trim() || !HOSTNAME.test(rawHost)) {
    fail("--hostname must be a bare hostname, like ynab.example.com");
  }
  return { kind: "hostname", host: rawHost.toLowerCase() };
}

async function resolveTarget(target, api, account) {
  if (target.kind === "hostname") return { ...target, label: target.host };
  const scripts = await api.list(`/accounts/${account}/workers/scripts`);
  const script = scripts.find((s) => s.id === target.name);
  if (!script) fail(`no Worker named "${target.name}" on this account`);
  if (!script.tag) fail(`the Worker "${target.name}" has no script tag in the API response`);
  return { ...target, tag: script.tag, label: `Worker ${target.name}` };
}

const hostOf = (uri) => String(uri).toLowerCase().split("/")[0];

function appMatches(app, target) {
  const destinations = app.destinations ?? [];
  if (target.kind === "worker") {
    return destinations.some((d) => WORKER_DESTINATIONS.has(d.type) && d.worker_id === target.tag);
  }
  const uris = [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...destinations.filter((d) => d.type === "public").map((d) => d.uri),
  ].filter(Boolean);
  return uris.some((uri) => hostOf(uri) === target.host);
}

async function findApps(target, api, account) {
  const apps = await api.list(`/accounts/${account}/access/apps`);
  return apps.filter((app) => appMatches(app, target));
}

function summarize(app) {
  return {
    name: app.name,
    id: app.id,
    aud: app.aud,
    type: app.type,
    domain: app.domain,
    destinations: app.destinations,
    policies: (app.policies ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      decision: p.decision,
      precedence: p.precedence,
      include: p.include,
      exclude: p.exclude,
      require: p.require,
    })),
    session_duration: app.session_duration,
    allowed_idps: app.allowed_idps,
    oauth_configuration: app.oauth_configuration ?? null,
  };
}

// ---------------------------------------------------------------------------
// inspect

async function inspect(values, ctx) {
  const target = readTarget(values);
  const api = client(ctx);
  const account = await accountId(api, ctx);
  const org = await api.get(`/accounts/${account}/access/organizations`);
  const idps = await api.list(`/accounts/${account}/access/identity_providers`);
  const resolved = await resolveTarget(target, api, account);
  const apps = await findApps(resolved, api, account);

  ctx.log(`Account: ${account}`);
  ctx.log(`Team domain: ${org?.auth_domain ?? "(none)"}`);
  ctx.log("Login methods:");
  if (idps.length === 0) ctx.log("  (none; add one under Zero Trust > Settings > Authentication)");
  for (const idp of idps) ctx.log(`  ${idp.type}  ${idp.name}  ${idp.id}`);
  if (resolved.kind === "worker") ctx.log(`Worker ${resolved.name}: script tag ${resolved.tag}`);
  ctx.log(`Access applications for ${resolved.label}: ${apps.length}`);
  for (const app of apps) ctx.log(json(summarize(app)));
  if (apps.length === 0) ctx.log("apply would create one.");
  if (apps.length > 1) {
    fail(
      `${apps.length} Access applications match ${resolved.label} (${apps
        .map((app) => app.id)
        .join(", ")}); remove the extra ones first`,
    );
  }
}

// ---------------------------------------------------------------------------
// apply

function readApplyOptions(values) {
  if (!values.email) fail("--email is required");
  const email = values.email.trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(`--email "${values.email}" is not an email address`);

  const redirectUris = values["redirect-uri"] ?? [];
  if (redirectUris.length === 0) {
    fail("--redirect-uri is required; pass the exact callback URI of each MCP client");
  }
  for (const uri of redirectUris) validateRedirectUri(uri);

  const tokenLifetime = values["token-lifetime"] ?? "15m";
  const grantSession = values["grant-session"] ?? "336h";
  for (const [flag, value] of [
    ["--token-lifetime", tokenLifetime],
    ["--grant-session", grantSession],
  ]) {
    if (!DURATION.test(value)) fail(`${flag} "${value}" must be a duration like 15m or 336h`);
  }

  return {
    email,
    redirectUris: [...new Set(redirectUris)],
    allowLocalhost: Boolean(values["allow-localhost"]),
    allowLoopback: Boolean(values["allow-loopback"]),
    tokenLifetime,
    grantSession,
  };
}

function validateRedirectUri(uri) {
  if (uri !== uri.trim()) fail(`--redirect-uri "${uri}" is not a valid callback URI`);

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    fail(`--redirect-uri "${uri}" is not a URL`);
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    fail(`--redirect-uri "${uri}" must be an https, loopback http, or custom-scheme URI`);
  }

  const wildcardCount = [...uri].filter((character) => character === "*").length;
  if (
    wildcardCount > 0 &&
    (wildcardCount !== 1 ||
      !["https:", "http:"].includes(parsed.protocol) ||
      !uri.endsWith("/*") ||
      !parsed.pathname.endsWith("/*"))
  ) {
    fail(
      `--redirect-uri "${uri}" may use a wildcard only as a final /* HTTP(S) path suffix`,
    );
  }

  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:") {
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.")) return;
    fail(`--redirect-uri "${uri}" may use http only for a loopback address`);
  }
}

const isOnlyEmail = (policy, email) =>
  Object.keys(policy).every((field) => PLAIN_POLICY_FIELDS.has(field)) &&
  policy.decision === "allow" &&
  (policy.include ?? []).length === 1 &&
  policy.include[0]?.email?.email?.toLowerCase() === email.toLowerCase() &&
  (policy.exclude ?? []).length === 0 &&
  (policy.require ?? []).length === 0;

function otherDestinations(app, target) {
  return (app.destinations ?? []).filter((destination) => {
    if (target.kind === "worker") {
      return !(
        WORKER_DESTINATIONS.has(destination.type) && destination.worker_id === target.tag
      );
    }
    return !(destination.type === "public" && hostOf(destination.uri) === target.host);
  });
}

function describeDestination(destination) {
  if (destination.type === "public") return `public:${destination.uri}`;
  if (WORKER_DESTINATIONS.has(destination.type)) {
    return `${destination.type}:${destination.worker_id}`;
  }
  return JSON.stringify(destination);
}

function oauthConfiguration(existing, opts) {
  const current = existing ?? {};
  return {
    ...current,
    enabled: true,
    dynamic_client_registration: {
      ...(current.dynamic_client_registration ?? {}),
      enabled: true,
      allowed_uris: opts.redirectUris,
      allow_any_on_localhost: opts.allowLocalhost,
      allow_any_on_loopback: opts.allowLoopback,
    },
    grant: {
      ...(current.grant ?? {}),
      access_token_lifetime: opts.tokenLifetime,
      session_duration: opts.grantSession,
    },
  };
}

// A PUT body: the app as fetched, minus read-only fields, with policies
// listed by reference.
function putBody(app) {
  const body = { ...app };
  for (const field of READ_ONLY_APP_FIELDS) delete body[field];
  return body;
}

const policyRefs = (policies) =>
  (policies ?? []).map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 }));

function writeBackup(ctx, label, record) {
  mkdirSync(ctx.backupDir, { recursive: true });
  const stamp = ctx.now().toISOString().replace(/[:.]/g, "-");
  const file = join(ctx.backupDir, `${stamp}-${label}.json`);
  writeFileSync(file, `${json(record)}\n`, { flag: "wx", mode: 0o600 });
  ctx.log(`Backup: ${file}`);
  return file;
}

function printRequest(ctx, method, path, body) {
  ctx.log(`${method} ${API}${path}`);
  if (body !== undefined) ctx.log(json(body));
}

async function apply(values, ctx) {
  const target = readTarget(values);
  const opts = readApplyOptions(values);
  const dryRun = !values.yes;
  const api = client(ctx);
  const account = await accountId(api, ctx);
  const org = await api.get(`/accounts/${account}/access/organizations`);
  const teamDomain = org?.auth_domain;
  if (!teamDomain) fail("the account has no Zero Trust team domain; set up Zero Trust first");
  const resolved = await resolveTarget(target, api, account);
  const matches = await findApps(resolved, api, account);
  if (matches.length > 1) {
    fail(
      `${matches.length} Access applications match ${resolved.label} (${matches
        .map((a) => a.id)
        .join(", ")}); remove the extra ones or run inspect`,
    );
  }

  // The current app, fetched on its own so the PUT starts from the full record.
  const existing = matches.length
    ? await api.get(`/accounts/${account}/access/apps/${matches[0].id}`)
    : undefined;
  if (existing) {
    const others = otherDestinations(existing, resolved);
    if (others.length > 0) {
      fail(
        `Access application ${existing.name} (${existing.id}) also protects other destinations: ${others
          .map(describeDestination)
          .join(", ")}; split them into separate Access applications or use the dashboard`,
      );
    }
  }

  const policies = await api.list(`/accounts/${account}/access/policies`);
  const reusable = policies.find((p) => isOnlyEmail(p, opts.email));
  const policyBody = reusable
    ? undefined
    : {
        name: `Allow ${opts.email}`,
        decision: "allow",
        include: [{ email: { email: opts.email } }],
      };
  let workerDomain;
  if (!existing && resolved.kind === "worker") {
    const workersSubdomain = await api.get(`/accounts/${account}/workers/subdomain`);
    if (!workersSubdomain?.subdomain) {
      fail("the account has no workers.dev subdomain; enable workers.dev before creating Worker-level Access");
    }
    workerDomain = `${resolved.name}.${workersSubdomain.subdomain}.workers.dev`;
  }

  const appBody = (policyId) => {
    const policiesRef = [{ id: policyId, precedence: 1 }];
    if (existing) {
      const body = putBody(existing);
      if (resolved.kind === "worker") {
        body.destinations = [
          ...(existing.destinations ?? []).filter(
            (d) => !(WORKER_DESTINATIONS.has(d.type) && d.worker_id === resolved.tag),
          ),
          { type: "worker", worker_id: resolved.tag },
        ];
      }
      body.policies = policiesRef;
      body.oauth_configuration = oauthConfiguration(existing.oauth_configuration, opts);
      return body;
    }
    const base =
      resolved.kind === "worker"
        ? {
            name: resolved.name,
            domain: workerDomain,
            destinations: [{ type: "worker", worker_id: resolved.tag }],
          }
        : {
            name: resolved.host,
            domain: resolved.host,
            destinations: [{ type: "public", uri: resolved.host }],
          };
    return {
      ...base,
      type: "self_hosted",
      session_duration: "24h",
      app_launcher_visible: false,
      policies: policiesRef,
      oauth_configuration: oauthConfiguration(undefined, opts),
    };
  };

  const appsPath = `/accounts/${account}/access/apps`;
  const appPath = existing ? `${appsPath}/${existing.id}` : appsPath;
  const appMethod = existing ? "PUT" : "POST";

  ctx.log(`Team domain: ${teamDomain}`);
  ctx.log(
    existing
      ? `Updating Access application ${existing.name} (${existing.id}) for ${resolved.label}.`
      : `Creating an Access application for ${resolved.label}.`,
  );
  ctx.log(
    reusable
      ? `Reusing Allow policy ${reusable.name} (${reusable.id}) for ${opts.email}.`
      : `Creating an Allow policy for ${opts.email}.`,
  );

  if (dryRun) {
    ctx.log("\nDry run. These are the requests apply would send:\n");
    if (policyBody) printRequest(ctx, "POST", `/accounts/${account}/access/policies`, policyBody);
    printRequest(ctx, appMethod, appPath, appBody(reusable ? reusable.id : PENDING_POLICY_ID));
    if (policyBody) {
      ctx.log(
        `\n${PENDING_POLICY_ID} is the only placeholder; with --yes it is replaced by the policy ID returned by the preceding POST.`,
      );
    }
    ctx.log("\nNothing was changed. Run again with --yes to apply.");
    return;
  }

  const backupRecord = {
    command: "apply",
    created: !existing,
    account_id: account,
    target: resolved.kind === "worker" ? { worker: resolved.name } : { hostname: resolved.host },
    app: existing ?? null,
  };
  const backupFile = writeBackup(
    ctx,
    `apply-${existing ? existing.id : "new"}`,
    backupRecord,
  );

  let policyId = reusable?.id;
  if (policyBody) {
    const created = await api.send("POST", `/accounts/${account}/access/policies`, policyBody);
    policyId = created.id;
    ctx.log(`Created policy ${policyId}.`);
  }

  const result = await api.send(appMethod, appPath, appBody(policyId));
  if (!existing) {
    // Record the new app's id so rollback can delete it.
    writeFileSync(backupFile, `${json({ ...backupRecord, app: { id: result.id, name: result.name } })}\n`);
  }
  ctx.log(`${existing ? "Updated" : "Created"} Access application ${result.id}.`);
  ctx.log("\nSet these on the Worker (see DEPLOY.md):\n");
  ctx.log(`CF_ACCESS_TEAM_DOMAIN=${teamDomain}`);
  ctx.log(`CF_ACCESS_AUD=${result.aud ?? existing?.aud}`);
  ctx.log(`\nTo undo: npm run cf-access -- rollback --from ${backupFile}`);
}

// ---------------------------------------------------------------------------
// rollback

function readBackup(file) {
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read backup ${file}: ${err.message}`);
  }
  if (record?.command !== "apply" || !record.account_id || !record.app?.id) {
    fail(`${file} is not a backup written by apply --yes`);
  }
  return record;
}

async function rollback(values, ctx) {
  if (!values.from) fail("--from <backup file> is required");
  const backup = readBackup(values.from);
  const dryRun = !values.yes;
  const api = client(ctx);
  const account = backup.account_id;
  const appPath = `/accounts/${account}/access/apps/${backup.app.id}`;

  if (backup.created) {
    ctx.log(`apply created Access application ${backup.app.id}; rollback deletes it.`);
    if (dryRun) {
      ctx.log("\nDry run. This is the request rollback would send:\n");
      printRequest(ctx, "DELETE", appPath);
      ctx.log("\nNothing was changed. Run again with --yes to roll back.");
      return;
    }
    const current = await api.get(appPath);
    writeBackup(ctx, `rollback-${backup.app.id}`, {
      command: "rollback",
      account_id: account,
      app: current,
    });
    await api.send("DELETE", appPath);
    ctx.log(`Deleted Access application ${backup.app.id}.`);
    return;
  }

  const current = await api.get(appPath);
  const body = putBody(current);
  body.destinations = backup.app.destinations ?? current.destinations;
  body.policies = policyRefs(backup.app.policies);
  body.oauth_configuration = backup.app.oauth_configuration ?? { enabled: false };

  ctx.log(
    `Restoring the destinations, policies and Managed OAuth settings of ${current.name} (${current.id}) from ${values.from}.`,
  );
  if (dryRun) {
    ctx.log("\nDry run. This is the request rollback would send:\n");
    printRequest(ctx, "PUT", appPath, body);
    ctx.log("\nNothing was changed. Run again with --yes to roll back.");
    return;
  }
  writeBackup(ctx, `rollback-${current.id}`, { command: "rollback", account_id: account, app: current });
  await api.send("PUT", appPath, body);
  ctx.log(`Restored Access application ${current.id}.`);
}

// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
