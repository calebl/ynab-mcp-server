import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_get_payee_location";
export const description = "Gets a single payee location (the GPS point YNAB's mobile app recorded for a payee) by ID.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  payeeLocationId: z.string().describe("The ID of the payee location to fetch (find it with ynab_list_payee_locations)"),
};

interface GetPayeeLocationInput {
  planId?: string;
  budgetId?: string;
  payeeLocationId: string;
}

export async function execute(input: GetPayeeLocationInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.payeeLocations.getPayeeLocationById(planId, input.payeeLocationId);
    const location = response.data.payee_location;

    const result = {
      payee_location: {
        id: location.id,
        payee_id: location.payee_id,
        latitude: location.latitude,
        longitude: location.longitude,
        deleted: location.deleted,
      },
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    console.error("Error getting payee location:", error);
    return toolError(getErrorMessage(error));
  }
}
