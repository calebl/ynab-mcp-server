import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const name = "ynab_list_payees";
export const description = "Lists all payees in a plan. Useful for finding payee IDs when creating transactions. Pass lastKnowledgeOfServer (the server_knowledge from an earlier call) to get only rows changed since; deleted rows then come back with deleted: true.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  lastKnowledgeOfServer: z.number().int().nonnegative().optional().describe("Delta sync: the server_knowledge value from an earlier response of this tool. Only rows changed since then are returned, deleted rows included with deleted: true."),
};

interface ListPayeesInput {
  planId?: string;
  budgetId?: string;
  lastKnowledgeOfServer?: number;
}


export async function execute(input: ListPayeesInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);

    console.error(`Listing payees for budget ${budgetId}`);
    const response = await api.payees.getPayees(budgetId, input.lastKnowledgeOfServer);

    // Delta mode keeps deleted rows so callers can apply the removal
    const delta = input.lastKnowledgeOfServer !== undefined;
    // Filter out deleted payees and format the response
    const payees = response.data.payees
      .filter((payee) => delta || !payee.deleted)
      .map((payee) => ({
        id: payee.id,
        name: payee.name,
        transfer_account_id: payee.transfer_account_id,
        deleted: payee.deleted,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          payees,
          payee_count: payees.length,
          server_knowledge: response.data.server_knowledge,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error listing payees:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }
}
