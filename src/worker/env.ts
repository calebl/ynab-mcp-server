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
}
