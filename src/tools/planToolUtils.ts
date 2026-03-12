import { readYnabConfig } from "../config.js";
import { getErrorMessage } from "./errorUtils.js";

let runtimePlanIdOverride: string | undefined;

export function getPlanId(inputPlanId?: string): string {
  const planId = inputPlanId?.trim() || readYnabConfig(process.env).planId || "";
  if (!planId) {
    throw new Error("No plan ID provided. Please provide a plan ID or set YNAB_PLAN_ID.");
  }
  return planId;
}

type PlanResolverApi = {
  plans: {
    getPlans: () => Promise<{
      data: {
        plans: Array<{ id: string }>;
        default_plan?: { id: string } | null;
      };
    }>;
  };
};

type ResolvePlanIdOptions = {
  excludePlanIds?: string[];
  ignoreConfiguredPlanId?: boolean;
  ignoreRuntimePlanIdOverride?: boolean;
};

function getConfiguredPlanId(inputPlanId: string | undefined, options: ResolvePlanIdOptions) {
  const explicitPlanId = inputPlanId?.trim();

  if (explicitPlanId) {
    return explicitPlanId;
  }

  if (!options.ignoreRuntimePlanIdOverride && runtimePlanIdOverride) {
    return runtimePlanIdOverride;
  }

  if (!options.ignoreConfiguredPlanId) {
    return readYnabConfig(process.env).planId || "";
  }

  return "";
}

function pickResolvedPlanId(
  plans: Array<{ id: string }>,
  defaultPlanId: string | undefined,
  excludedPlanIds: Set<string>,
) {
  if (defaultPlanId && !excludedPlanIds.has(defaultPlanId)) {
    return defaultPlanId;
  }

  const remainingPlans = plans.filter((plan) => !excludedPlanIds.has(plan.id));

  if (remainingPlans.length === 1) {
    return remainingPlans[0].id;
  }

  return undefined;
}

function rememberRuntimePlanId(planId: string, inputPlanId?: string) {
  if (!inputPlanId) {
    runtimePlanIdOverride = planId;
  }
}

function isMissingPlanError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("not found") || message.includes("no entity was found");
}

export function resetPlanResolutionState() {
  runtimePlanIdOverride = undefined;
}

export async function resolvePlanId(
  inputPlanId: string | undefined,
  api: PlanResolverApi,
  options: ResolvePlanIdOptions = {},
): Promise<string> {
  const excludedPlanIds = new Set(options.excludePlanIds ?? []);
  const configuredPlanId = getConfiguredPlanId(inputPlanId, options);

  if (configuredPlanId && !excludedPlanIds.has(configuredPlanId)) {
    return configuredPlanId;
  }

  const response = await api.plans.getPlans();
  const resolvedPlanId = pickResolvedPlanId(response.data.plans, response.data.default_plan?.id, excludedPlanIds);

  if (resolvedPlanId) {
    rememberRuntimePlanId(resolvedPlanId, inputPlanId);
    return resolvedPlanId;
  }

  throw new Error(
    "No plan ID provided. Please provide a plan ID, set YNAB_PLAN_ID, or configure a default YNAB plan.",
  );
}

export async function withResolvedPlan<T>(
  inputPlanId: string | undefined,
  api: PlanResolverApi,
  operation: (planId: string) => Promise<T>,
) {
  const planId = await resolvePlanId(inputPlanId, api);

  try {
    return await operation(planId);
  } catch (error) {
    if (inputPlanId || !isMissingPlanError(error)) {
      throw error;
    }

    const recoveredPlanId = await resolvePlanId(undefined, api, {
      excludePlanIds: [planId],
      ignoreConfiguredPlanId: true,
      ignoreRuntimePlanIdOverride: true,
    });

    rememberRuntimePlanId(recoveredPlanId);
    return operation(recoveredPlanId);
  }
}

export function toTextResult(payload: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

export function toErrorResult(error: unknown) {
  return toTextResult({
    success: false,
    error: getErrorMessage(error),
  });
}
