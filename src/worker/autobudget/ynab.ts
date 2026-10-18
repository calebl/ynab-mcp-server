import { describeMissingPlan } from "../../tools/planId.js";
import { MAX_CALLS_PER_RUN } from "./config.js";

const API_BASE = "https://api.ynab.com/v1";

/** A failed YNAB request, keeping the HTTP status so callers can tell a missing plan from a rate limit. */
export class YnabRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "YnabRequestError";
  }
}

/**
 * The service's only way to reach YNAB. It can issue GET requests and nothing
 * else, so no code path in this version can change the plan. It also counts
 * requests against a per-run budget: YNAB stopped sending its rate-limit
 * header, so the service cannot ask how much of the hourly allowance is left.
 */
export class YnabReader {
  calls = 0;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxCalls: number = MAX_CALLS_PER_RUN,
  ) {}

  async get<T>(path: string): Promise<T> {
    if (this.calls >= this.maxCalls) {
      throw new YnabRequestError(0, `request budget of ${this.maxCalls} YNAB calls per run is spent`);
    }
    this.calls++;

    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    const body = await response.json().catch(() => null) as { data?: T; error?: { name?: string; detail?: string } } | null;
    if (!response.ok) {
      const detail = body?.error?.detail || body?.error?.name || `HTTP ${response.status}`;
      throw new YnabRequestError(response.status, `YNAB ${response.status}: ${detail}`);
    }
    return body?.data as T;
  }
}

export const planPath = (planId: string) => `/plans/${encodeURIComponent(planId)}`;

/**
 * Turns a 404 on the configured plan into an explanation naming the plans the
 * token can see. Returns null when the plan is visible (the 404 was something
 * else) or the plan list cannot be read.
 */
export async function explainMissingPlan(reader: YnabReader, planId: string): Promise<string | null> {
  try {
    const data = await reader.get<{ plans: Array<{ id: string; name: string }> }>("/plans");
    return describeMissingPlan(planId, data.plans);
  } catch {
    return null;
  }
}
