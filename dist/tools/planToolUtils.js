import { readYnabConfig } from "../config.js";
import { getErrorMessage } from "./errorUtils.js";
let runtimePlanIdOverride;
export function getPlanId(inputPlanId) {
    const planId = inputPlanId?.trim() || readYnabConfig(process.env).planId || "";
    if (!planId) {
        throw new Error("No plan ID provided. Please provide a plan ID or set YNAB_PLAN_ID.");
    }
    return planId;
}
function getConfiguredPlanId(inputPlanId, options) {
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
function pickResolvedPlanId(plans, defaultPlanId, excludedPlanIds) {
    if (defaultPlanId && !excludedPlanIds.has(defaultPlanId)) {
        return defaultPlanId;
    }
    const remainingPlans = plans.filter((plan) => !excludedPlanIds.has(plan.id));
    if (remainingPlans.length === 1) {
        return remainingPlans[0].id;
    }
    return undefined;
}
function rememberRuntimePlanId(planId, inputPlanId) {
    if (!inputPlanId) {
        runtimePlanIdOverride = planId;
    }
}
function isMissingPlanError(error) {
    const message = getErrorMessage(error).toLowerCase();
    return message.includes("not found") || message.includes("no entity was found");
}
export function resetPlanResolutionState() {
    runtimePlanIdOverride = undefined;
}
export async function resolvePlanId(inputPlanId, api, options = {}) {
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
    throw new Error("No plan ID provided. Please provide a plan ID, set YNAB_PLAN_ID, or configure a default YNAB plan.");
}
export async function withResolvedPlan(inputPlanId, api, operation) {
    const planId = await resolvePlanId(inputPlanId, api);
    try {
        return await operation(planId);
    }
    catch (error) {
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
export function toTextResult(payload) {
    return {
        content: [{
                type: "text",
                text: JSON.stringify(payload, null, 2),
            }],
    };
}
export function toErrorResult(error) {
    return toTextResult({
        success: false,
        error: getErrorMessage(error),
    });
}
