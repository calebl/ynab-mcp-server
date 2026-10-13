import { resolvePlanId } from "./planId.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_get_account";
export const description = "Gets a single account by ID, with its balances, note and last reconciliation time.";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  accountId: z.string().describe("The ID of the account to fetch (find it with ynab_list_accounts)"),
};

interface GetAccountInput {
  planId?: string;
  budgetId?: string;
  accountId: string;
}

export async function execute(input: GetAccountInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const response = await api.accounts.getAccountById(planId, input.accountId);
    const account = response.data.account;

    const result = {
      account: {
        id: account.id,
        name: account.name,
        type: account.type,
        on_budget: account.on_budget,
        closed: account.closed,
        deleted: account.deleted,
        note: account.note ?? null,
        balance: toDollars(account.balance),
        cleared_balance: toDollars(account.cleared_balance),
        uncleared_balance: toDollars(account.uncleared_balance),
        transfer_payee_id: account.transfer_payee_id,
        direct_import_linked: account.direct_import_linked ?? null,
        direct_import_in_error: account.direct_import_in_error ?? null,
        last_reconciled_at: account.last_reconciled_at ?? null,
      },
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    console.error("Error getting account:", error);
    return toolError(getErrorMessage(error));
  }
}
