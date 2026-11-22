import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_list_payee_locations";
export const description = "Lists payee locations (GPS points recorded by YNAB's mobile app). Pass payeeId to list only that payee's locations.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  payeeId: z.string().optional().describe("Only list locations for this payee (optional; omit for every payee)"),
};

interface ListPayeeLocationsInput {
  planId?: string;
  budgetId?: string;
  payeeId?: string;
}

export async function execute(input: ListPayeeLocationsInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = input.payeeId
      ? await api.payeeLocations.getPayeeLocationsByPayee(planId, input.payeeId)
      : await api.payeeLocations.getPayeeLocations(planId);

    const payeeLocations = response.data.payee_locations
      .filter((location) => !location.deleted)
      .map((location) => ({
        id: location.id,
        payee_id: location.payee_id,
        latitude: location.latitude,
        longitude: location.longitude,
      }));

    const result = {
      payee_locations: payeeLocations,
      payee_location_count: payeeLocations.length,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    console.error("Error listing payee locations:", error);
    return toolError(getErrorMessage(error));
  }
}
