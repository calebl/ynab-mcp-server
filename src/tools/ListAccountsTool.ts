import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { getDecimalDigits, toDollars } from "./money.js";

export const name = "ynab_list_accounts";
export const description = "Lists all accounts in a plan. Useful for finding account IDs when creating transactions. Pass lastKnowledgeOfServer (the server_knowledge from an earlier call) to get only rows changed since; deleted rows then come back with deleted: true. In this mode includeClosedAccounts is ignored and closed accounts are returned.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  includeClosedAccounts: z.boolean().optional().describe("Include closed accounts in the list (default: false)"),
  lastKnowledgeOfServer: z.number().int().nonnegative().optional().describe("Delta sync: the server_knowledge value from an earlier response of this tool. Only rows changed since then are returned, deleted rows included with deleted: true."),
};

interface ListAccountsInput {
  planId?: string;
  budgetId?: string;
  includeClosedAccounts?: boolean;
  lastKnowledgeOfServer?: number;
}


export async function execute(input: ListAccountsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const includeClosedAccounts = input.includeClosedAccounts ?? false;

    console.error(`Listing accounts for budget ${budgetId}`);
    const [response, decimalDigits] = await Promise.all([
      api.accounts.getAccounts(budgetId, input.lastKnowledgeOfServer),
      getDecimalDigits(api, budgetId),
    ]);

    // Delta mode keeps deleted and closed rows so callers can apply the change
    const delta = input.lastKnowledgeOfServer !== undefined;
    // Filter and format accounts
    const accounts = response.data.accounts
      .filter((account) => delta || (!account.deleted && (includeClosedAccounts || !account.closed)))
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        on_budget: account.on_budget,
        closed: account.closed,
        balance: toDollars(account.balance, decimalDigits),
        cleared_balance: toDollars(account.cleared_balance, decimalDigits),
        uncleared_balance: toDollars(account.uncleared_balance, decimalDigits),
        transfer_payee_id: account.transfer_payee_id,
        deleted: account.deleted,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          accounts,
          account_count: accounts.length,
          server_knowledge: response.data.server_knowledge,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error listing accounts:", error);
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
