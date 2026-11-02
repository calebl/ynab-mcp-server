import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

import { parseAllowedRedirectUris } from "./github-handler.js";
import { McpApiHandler } from "./mcp.js";
import type { WorkerEnv } from "./env.js";

/** True when any Access setting is present. */
export function usesAccess(env: WorkerEnv): boolean {
  return Boolean(
    env.CF_ACCESS_TEAM_DOMAIN ||
      env.CF_ACCESS_AUD ||
      env.CF_ACCESS_ALLOWED_EMAIL,
  );
}

let keys:
  { issuer: string; set: ReturnType<typeof createRemoteJWKSet> } | undefined;

function keySet(issuer: string) {
  if (keys?.issuer !== issuer) {
    keys = {
      issuer,
      set: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    };
  }
  return keys.set;
}

/** Errors a bad, expired or forged token produces, as opposed to an outage or misconfiguration. */
const REJECTED_TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JOSEAlgNotAllowed,
  errors.JWKSNoMatchingKey,
];

/** The claims of the request's Access token, or undefined when it has no valid one. */
async function verifiedClaims(
  request: Request,
  teamDomain: string,
  audience: string,
): Promise<JWTPayload | undefined> {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return undefined;

  const issuer = `https://${teamDomain}`;
  try {
    const { payload } = await jwtVerify(assertion, keySet(issuer), {
      issuer,
      audience,
      algorithms: ["RS256"],
    });
    return payload;
  } catch (error) {
    if (!REJECTED_TOKEN_ERRORS.some((type) => error instanceof type)) {
      console.error("access: could not verify token:", error);
    }
    return undefined;
  }
}

/** True when the token's email matches `allowedEmail`, ignoring case. */
function isOwner(claims: JWTPayload, allowedEmail: string): boolean {
  return (
    typeof claims.email === "string" &&
    claims.email.toLowerCase() === allowedEmail.toLowerCase()
  );
}

/**
 * Serves /mcp to the owner's valid Access token: 404 elsewhere, 401 without a
 * valid token, 403 for anyone else's.
 */
export const AccessHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const {
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_AUD: audience,
      CF_ACCESS_ALLOWED_EMAIL: allowedEmail,
    } = env;
    if (!teamDomain || !audience || !allowedEmail) {
      return new Response(
        "Cloudflare Access needs CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and CF_ACCESS_ALLOWED_EMAIL",
        { status: 500 },
      );
    }
    if (parseAllowedRedirectUris(env.ALLOWED_REDIRECT_URIS)) {
      return new Response(
        "ALLOWED_REDIRECT_URIS has no effect with Cloudflare Access; list redirect URIs in the Access application instead",
        { status: 500 },
      );
    }
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    const claims = await verifiedClaims(request, teamDomain, audience);
    if (!claims) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!isOwner(claims, allowedEmail)) {
      return new Response("Forbidden", { status: 403 });
    }
    return McpApiHandler.fetch(request, env);
  },
};
