/** Bindings and secrets the Worker expects. Secrets are set with `wrangler secret put`. */
export interface WorkerEnv {
  /** YNAB Personal Access Token. Secret — never sent to the client. */
  YNAB_API_TOKEN: string;
  /** Optional default plan, so tool calls can omit planId. */
  YNAB_PLAN_ID?: string;
  /** Deprecated but still accepted compatibility alias; no removal date. */
  YNAB_BUDGET_ID?: string;
  /** GitHub OAuth app credentials, used only to identify the caller. */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** The single GitHub login allowed to use this server. */
  ALLOWED_GITHUB_LOGIN: string;
  /**
   * Optional exact OAuth redirect URIs, separated by commas or whitespace, that
   * MCP clients may receive grants at. http loopback redirects are always
   * allowed. May be a plain var or a secret.
   */
  ALLOWED_REDIRECT_URIS?: string;
  /** Set to "true" to expose only the read-only tools. */
  YNAB_READ_ONLY?: string;
  /** TypeSafe API credential for the optional category suggestion preview. */
  TYPESAFE_API_KEY?: string;
  /** Set to "true" as a separate opt-in for category suggestions. */
  YNAB_AI_CATEGORIZATION?: string;
  /** Set to "true" to send each category's most frequent payee names to the model. */
  YNAB_AI_TYPICAL_PAYEES?: string;

  /**
   * Calendar reminder. Absent means the scheduled nag stays switched off.
   * The service account key is a secret; the rest is plain config.
   */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  NAG_CALENDAR_ID?: string;
  /** IANA zone the reminder is scheduled in. Defaults to America/Los_Angeles. */
  NAG_TIMEZONE?: string;
  /**
   * The reminder lands on a random hour inside this window, chosen fresh each
   * day. Set both to the same value for a fixed time. Defaults to 8-20.
   */
  NAG_HOUR_MIN?: string;
  NAG_HOUR_MAX?: string;

  /**
   * Auto-budget service. Absent database means the service stays off and its
   * tools are not registered.
   */
  AUTOBUDGET_DB?: D1Database;
  /** "off" (default) or "shadow". */
  AUTOBUDGET_MODE?: string;
  /** IANA zone for the daily digest. Defaults to NAG_TIMEZONE, then America/Los_Angeles. */
  AUTOBUDGET_TIMEZONE?: string;
  /** Local hour (0-23) the daily digest is sent. Defaults to 8. */
  AUTOBUDGET_DIGEST_HOUR?: string;
  /** Pushover credentials for alerts and the digest. Secrets; absent means nothing is sent. */
  PUSHOVER_APP_TOKEN?: string;
  PUSHOVER_USER_KEY?: string;
}
