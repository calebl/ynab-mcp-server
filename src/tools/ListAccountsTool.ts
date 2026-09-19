import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_list_accounts";
export const description = "Lists all accounts in a budget. Useful for finding account IDs when creating transactions.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  includeClosedAccounts: z.boolean().optional().describe("Include closed accounts in the list (default: false)"),
};

interface ListAccountsInput {
  planId?: string;
  budgetId?: string;
  includeClosedAccounts?: boolean;
}


export async function execute(input: ListAccountsInput, api: ynab.API) {
  try {
    const budgetId = resolvePlanId(input);
    const includeClosedAccounts = input.includeClosedAccounts ?? false;

    console.error(`Listing accounts for budget ${budgetId}`);
    const response = await api.accounts.getAccounts(budgetId);

    // Filter and format accounts
    const accounts = response.data.accounts
      .filter((account) => !account.deleted && (includeClosedAccounts || !account.closed))
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        on_budget: account.on_budget,
        closed: account.closed,
        balance: toDollars(account.balance),
        cleared_balance: toDollars(account.cleared_balance),
        uncleared_balance: toDollars(account.uncleared_balance),
        transfer_payee_id: account.transfer_payee_id,
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          accounts,
          account_count: accounts.length,
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
