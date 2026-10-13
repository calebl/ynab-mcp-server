import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_get_plan_settings";
export const description = "Gets a plan's settings: its date format and currency format (ISO code, symbol, decimal digits and separators).";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
};

interface GetPlanSettingsInput {
  planId?: string;
  budgetId?: string;
}

export async function execute(input: GetPlanSettingsInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.plans.getPlanSettingsById(planId);
    const settings = response.data.settings;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          date_format: settings.date_format,
          currency_format: settings.currency_format,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error getting plan settings:", error);
    return toolError(getErrorMessage(error));
  }
}
