import { isReadOnly } from "../../registry.js";
import type { WorkerEnv } from "../env.js";

/**
 * Limits the write stages will enforce, in plain currency. This version has
 * no write stage, so the shadow decisions apply them exactly as a live run
 * would: what shadow mode reports is what a live run would do.
 */
export const CAPS = {
  /** Largest transaction (either sign) the service may categorize or approve. */
  perTransaction: 250,
  /** Most the service may assign in a day, before Ready to Assign and total underfunded cap it further. */
  dailyAssignCeiling: 5000,
  /** Most transactions one run may change. */
  rowsPerRun: 25,
  /** Most categories one run may assign to. */
  categoriesPerRun: 10,
} as const;

/** The flag color the write stages put on every transaction they change. */
export const MARKER_FLAG_COLOR = "purple";

/** Self-imposed YNAB request budget per run; the token's limit is 200 per hour, shared with every other client. */
export const MAX_CALLS_PER_RUN = 20;

/** How far back the first sync reads, which is also the payee-history window. */
export const HISTORY_MONTHS = 12;

export type RequestedMode = "off" | "shadow" | "live";

export interface AutobudgetConfig {
  requestedMode: RequestedMode;
  /** What actually runs. Never "live" in this version. */
  mode: "off" | "shadow";
  /** Why `mode` differs from what was asked for, if it does. */
  modeReason: string | null;
  readOnly: boolean;
  timeZone: string;
  digestHour: number;
  notifierConfigured: boolean;
}

function parseHour(value: string | undefined, fallback: number): number {
  const hour = Number(value);
  return value !== undefined && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback;
}

export function readConfig(env: WorkerEnv): AutobudgetConfig {
  const raw = (env.AUTOBUDGET_MODE ?? "off").trim().toLowerCase();
  const readOnly = isReadOnly(env.YNAB_READ_ONLY);
  const base = {
    readOnly,
    timeZone: env.AUTOBUDGET_TIMEZONE || env.NAG_TIMEZONE || "America/Los_Angeles",
    digestHour: parseHour(env.AUTOBUDGET_DIGEST_HOUR, 8),
    notifierConfigured: Boolean(env.PUSHOVER_APP_TOKEN && env.PUSHOVER_USER_KEY),
  };

  if (raw === "shadow") {
    return { ...base, requestedMode: "shadow", mode: "shadow", modeReason: null };
  }
  if (raw === "live") {
    // YNAB_READ_ONLY is a hard stop for every write path, this one included.
    const modeReason = readOnly
      ? "YNAB_READ_ONLY is set, so the service stays in shadow mode"
      : "this version has no write stages, so live runs as shadow";
    return { ...base, requestedMode: "live", mode: "shadow", modeReason };
  }
  const modeReason = raw === "off" ? null : `unrecognized AUTOBUDGET_MODE "${raw}", treated as off`;
  return { ...base, requestedMode: "off", mode: "off", modeReason };
}
