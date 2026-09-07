/** Bindings and secrets the Worker expects. Secrets are set with `wrangler secret put`. */
export interface WorkerEnv {
  /** YNAB Personal Access Token. Secret — never sent to the client. */
  YNAB_API_TOKEN: string;
  /** Optional default budget, so tool calls can omit budgetId. */
  YNAB_BUDGET_ID?: string;
  /** GitHub OAuth app credentials, used only to identify the caller. */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** The single GitHub login allowed to use this server. */
  ALLOWED_GITHUB_LOGIN: string;
  /** Set to "true" to expose only the read-only tools. */
  YNAB_READ_ONLY?: string;

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
  /** Only nag about transactions this recent. Defaults to 30 days. */
  NAG_SINCE_DAYS?: string;
}
