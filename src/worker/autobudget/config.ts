import { isReadOnly } from "../../registry.js";
import type { WorkerEnv } from "../env.js";

/**
 * Limits the write stages will enforce, in plain currency. This version has
 * no write stage, so shadow decisions show what a later write stage would do.
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

export type RequestedMode = "off" | "shadow";

export interface AutobudgetConfig {
  requestedMode: RequestedMode;
  mode: RequestedMode;
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
  const modeReason = raw === "off" ? null : `unrecognized AUTOBUDGET_MODE "${raw}", treated as off`;
  return { ...base, requestedMode: "off", mode: "off", modeReason };
}
