export interface PlanIdInput { planId?: string; budgetId?: string; }

/** Resolve the canonical plan identifier with legacy compatibility. */
export function resolvePlanId(input: PlanIdInput = {}): string {
  const planId = input.planId || input.budgetId || process.env.YNAB_PLAN_ID || process.env.YNAB_BUDGET_ID || "";
  if (!planId) throw new Error("No plan ID provided. Please provide planId or set the YNAB_PLAN_ID environment variable.");
  return planId;
}

/** The configured default plan, as `resolvePlanId` falls back to it. */
export function configuredPlanId(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.YNAB_PLAN_ID || env.YNAB_BUDGET_ID || undefined;
}

/**
 * Explains a configured plan the token cannot see, or returns null when the
 * plan is among `plans`. A stale or mistyped YNAB_PLAN_ID otherwise surfaces
 * only as YNAB's bare "Resource not found" on every call that relies on it.
 */
export function describeMissingPlan(planId: string, plans: Array<{ id: string; name: string }>): string | null {
  if (plans.some((plan) => plan.id === planId)) return null;
  const visible = plans.length
    ? plans.map((plan) => `"${plan.name}" (${plan.id})`).join(", ")
    : "none";
  return `The configured plan ${planId} (YNAB_PLAN_ID) is not one of the plans this YNAB token can access. ` +
    `Plans it can access: ${visible}. Set YNAB_PLAN_ID to one of these, or pass planId.`;
}
