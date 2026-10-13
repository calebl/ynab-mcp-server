import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_get_user";
export const description = "Gets the authenticated YNAB user's ID.";
export const inputSchema = {};

export async function execute(_input: Record<string, unknown>, api: ynab.API) {
  try {
    const response = await api.user.getUser();

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id: response.data.user.id }, null, 2) }],
    };
  } catch (error) {
    console.error("Error getting user:", error);
    return toolError(getErrorMessage(error));
  }
}
