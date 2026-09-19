/**
 * Minimal Google Calendar client for a service account.
 *
 * Uses the JWT bearer flow (RFC 7523): sign a short-lived assertion with the
 * service account's private key, trade it for an access token, call the API.
 * No refresh tokens and no user consent screen — the account gets access by
 * having the calendar shared with it directly.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Turns the PEM in a service account key file into a WebCrypto signing key. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function getAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(claim)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importPrivateKey(key.private_key),
    new TextEncoder().encode(unsigned),
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`,
    }),
  });

  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new Error(`Google rejected the service account assertion: ${body.error_description ?? "unknown error"}`);
  }
  return body.access_token;
}

export interface CalendarEvent {
  /** Stable id, so re-running the job updates one event instead of piling up duplicates. */
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  timeZone: string;
  /** Minutes before the start to pop a reminder. */
  reminderMinutes?: number;
}

/**
 * Creates the event, or updates it if that id already exists.
 *
 * The job runs on a schedule and may run more than once against the same day,
 * so the id is derived from the date and the event is upserted rather than
 * inserted — otherwise a missed afternoon would leave a row of identical nags.
 */
export async function upsertEvent(
  key: ServiceAccountKey,
  calendarId: string,
  event: CalendarEvent,
): Promise<"created" | "updated"> {
  const token = await getAccessToken(key);
  const body = JSON.stringify({
    id: event.id,
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.start, timeZone: event.timeZone },
    end: { dateTime: event.end, timeZone: event.timeZone },
    reminders: {
      useDefault: false,
      overrides: event.reminderMinutes === undefined
        ? []
        : [{ method: "popup", minutes: event.reminderMinutes }],
    },
  });

  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const created = await fetch(base, { method: "POST", headers, body });
  if (created.ok) {
    return "created";
  }

  // 409 means an event with this id already exists — update it in place.
  if (created.status === 409) {
    const updated = await fetch(`${base}/${encodeURIComponent(event.id)}`, {
      method: "PUT",
      headers,
      body,
    });
    if (!updated.ok) {
      throw new Error(`Calendar update failed (${updated.status}): ${await updated.text()}`);
    }
    return "updated";
  }

  throw new Error(`Calendar insert failed (${created.status}): ${await created.text()}`);
}

/** Parses the service account JSON held in a Worker secret. */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  const key = JSON.parse(json) as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  return { client_email: key.client_email, private_key: key.private_key };
}
