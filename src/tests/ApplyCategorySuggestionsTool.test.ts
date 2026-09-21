import { describe, expect, it, vi } from "vitest";
import * as ynab from "ynab";

import * as ApplyTool from "../tools/ApplyCategorySuggestionsTool.js";
import { contentFingerprint } from "../tools/SuggestCategoriesTool.js";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn-1",
    date: "2026-09-12",
    amount: -12500,
    memo: "weekly shop",
    cleared: "cleared",
    approved: false,
    account_id: "account-uuid",
    account_name: "Checking",
    payee_id: "payee-uuid",
    payee_name: "Market",
    category_id: null,
    category_name: null,
    transfer_account_id: null,
    import_payee_name: "MARKET 123",
    import_payee_name_original: "MARKET #123",
    subtransactions: [],
    deleted: false,
    ...overrides,
  };
}

function makeApi(currentTransaction: ReturnType<typeof transaction>) {
  return {
    transactions: {
      getTransactionById: vi.fn().mockResolvedValue({
        data: { transaction: currentTransaction },
      }),
      updateTransactions: vi.fn(),
    },
    categories: {
      getCategories: vi.fn().mockResolvedValue({
        data: {
          category_groups: [{
            id: "group-everyday",
            name: "Everyday",
            hidden: false,
            deleted: false,
            categories: [{
              id: "cat-grocery",
              category_group_id: "group-everyday",
              name: "Groceries",
              hidden: false,
              deleted: false,
              budgeted: 0,
              activity: 0,
              balance: 0,
            }],
          }],
        },
      }),
    },
  };
}

async function execute(currentTransaction: ReturnType<typeof transaction>, expectedFingerprint: string) {
  const api = makeApi(currentTransaction);
  const response = await ApplyTool.execute({
    planId: "plan-id",
    suggestions: [{
      transaction_id: "txn-1",
      category_id: "cat-grocery",
      expected_content_fingerprint: expectedFingerprint,
    }],
  }, api as unknown as ynab.API);

  return { api, output: JSON.parse(response.content[0].text) };
}

describe("ApplyCategorySuggestionsTool", () => {
  it("treats a retried successful suggestion as already applied", async () => {
    const expectedFingerprint = await contentFingerprint(transaction() as ynab.TransactionDetail);
    const { api, output } = await execute(
      transaction({ category_id: "cat-grocery", category_name: "Groceries" }),
      expectedFingerprint,
    );

    expect(output.rows).toEqual([expect.objectContaining({
      transaction_id: "txn-1",
      status: "already_applied",
    })]);
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });

  it.each([
    ["approved", { approved: true }, "approved"],
    ["reconciled", { cleared: "reconciled" }, "reconciled"],
    ["deleted", { deleted: true }, "deleted"],
  ])("rejects a %s transaction refetched before apply", async (_state, overrides, reason) => {
    const currentTransaction = transaction(overrides);
    const expectedFingerprint = await contentFingerprint(currentTransaction as ynab.TransactionDetail);
    const { api, output } = await execute(currentTransaction, expectedFingerprint);

    expect(output.rows).toEqual([expect.objectContaining({
      transaction_id: "txn-1",
      status: "rejected",
      reason,
    })]);
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });
});
