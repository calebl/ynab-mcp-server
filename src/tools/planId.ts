export interface PlanIdInput { planId?: string; budgetId?: string; }

/** Resolve the canonical plan identifier with legacy compatibility. */
export function resolvePlanId(input: PlanIdInput = {}): string {
  const planId = input.planId || input.budgetId || process.env.YNAB_PLAN_ID || process.env.YNAB_BUDGET_ID || "";
  if (!planId) throw new Error("No plan ID provided. Please provide planId or set the YNAB_PLAN_ID environment variable.");
  return planId;
}
