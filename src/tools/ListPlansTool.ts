import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_list_plans";
export const description = "Lists all available plans from YNAB API";
export const inputSchema = {};

export async function execute(_input: Record<string, unknown>, api: ynab.API) {
  try {
    if (!process.env.YNAB_API_TOKEN) {
      return toolError("YNAB API Token is not set");
    }

    console.error("Listing plans");
    const plansResponse = await api.plans.getPlans();
    console.error(`Found ${plansResponse.data.plans.length} plans`);

    const plans = plansResponse.data.plans.map((plan) => {
      const { id, name, last_modified_on, first_month, last_month, date_format, currency_format } = plan;
      // Optional metadata that YNAB leaves out (or returns as null) is omitted rather than emitted.
      const optional = { last_modified_on, first_month, last_month, date_format, currency_format };
      return {
        id,
        name,
        ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value != null)),
      };
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(plans, null, 2) }]
    };
  } catch (error: unknown) {
    console.error("Error listing plans:", error);
    return toolError(getErrorMessage(error));
  }
}