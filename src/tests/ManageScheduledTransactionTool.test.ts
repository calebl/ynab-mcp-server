import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";
import type * as ynab from "ynab";
import * as ManageScheduledTransactionTool from "../tools/ManageScheduledTransactionTool";
import { registerAll, type ToolRegistrar } from "../registry.js";

const scheduled = {
  id: "st-1",
  date_first: "2026-01-05",
  date_next: "2026-12-05",
  frequency: "monthly",
  amount: -14950,
  memo: "Audible",
  flag_color: null,
  account_id: "acct-old",
  account_name: "Old Card",
  payee_id: "payee-audible",
  payee_name: "Audible",
  category_id: "cat-subs",
  category_name: "Subscriptions",
  deleted: false,
  subtransactions: [],
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("ManageScheduledTransactionTool", () => {
  let mockApi: {
    scheduledTransactions: {
      createScheduledTransaction: Mock;
      updateScheduledTransaction: Mock;
      deleteScheduledTransaction: Mock;
      getScheduledTransactionById: Mock;
    };
    accounts: { getAccounts: Mock };
    categories: { getCategories: Mock };
    plans: { getPlanSettingsById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    mockApi = {
      scheduledTransactions: {
        createScheduledTransaction: vi.fn().mockResolvedValue({ data: { scheduled_transaction: scheduled } }),
        updateScheduledTransaction: vi.fn().mockResolvedValue({ data: { scheduled_transaction: scheduled } }),
        deleteScheduledTransaction: vi.fn().mockResolvedValue({ data: { scheduled_transaction: { ...scheduled, deleted: true } } }),
        getScheduledTransactionById: vi.fn().mockResolvedValue({ data: { scheduled_transaction: scheduled } }),
      },
      accounts: {
        getAccounts: vi.fn().mockResolvedValue({
          data: {
            accounts: [
              { id: "acct-old", name: "Old Card", deleted: false, closed: false },
              { id: "acct-checking", name: "Ally Checking", deleted: false, closed: false },
              { id: "acct-closed", name: "Ally Savings", deleted: false, closed: true },
            ],
          },
        }),
      },
      categories: {
        getCategories: vi.fn().mockResolvedValue({
          data: {
            category_groups: [{
              deleted: false,
              hidden: false,
              categories: [{ id: "cat-subs", name: "Subscriptions", deleted: false, hidden: false }],
            }],
          },
        }),
      },
      plans: {
        getPlanSettingsById: vi.fn().mockRejectedValue(new Error("no settings in test")),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const run = (input: Record<string, unknown>) =>
    ManageScheduledTransactionTool.execute({ planId: "plan-1", ...input } as any, mockApi as any);

  describe("create", () => {
    it("creates a scheduled transaction with resolved names and milliunits", async () => {
      const result = parse(await run({
        action: "create",
        accountName: "ally checking",
        date: "2026-12-05",
        frequency: "monthly",
        amount: -14.95,
        payeeName: "Audible",
        categoryName: "subscriptions",
        memo: "Audible",
        flagColor: "",
      }));

      expect(mockApi.scheduledTransactions.createScheduledTransaction).toHaveBeenCalledWith("plan-1", {
        scheduled_transaction: {
          account_id: "acct-checking",
          date: "2026-12-05",
          frequency: "monthly",
          amount: -14950,
          payee_id: null,
          payee_name: "Audible",
          category_id: "cat-subs",
          memo: "Audible",
          flag_color: null,
        },
      });
      expect(result.success).toBe(true);
      expect(result.matchedAccount).toBe("Ally Checking");
      expect(result.matchedCategory).toBe("Subscriptions");
      expect(result.scheduledTransaction.amount).toBe(-14.95);
    });

    it("defaults frequency to never and skips name lookups when ids are given", async () => {
      await run({ action: "create", accountId: "acct-x", date: "2026-12-05", amount: 10, payeeId: "p-1" });

      expect(mockApi.accounts.getAccounts).not.toHaveBeenCalled();
      expect(mockApi.categories.getCategories).not.toHaveBeenCalled();
      expect(mockApi.scheduledTransactions.createScheduledTransaction).toHaveBeenCalledWith("plan-1", {
        scheduled_transaction: {
          account_id: "acct-x",
          date: "2026-12-05",
          frequency: "never",
          amount: 10000,
          payee_id: "p-1",
          payee_name: null,
        },
      });
    });

    it.each([
      [{ date: "2026-12-05", amount: 1 }, "accountId or accountName"],
      [{ accountId: "a", amount: 1 }, "date is required"],
      [{ accountId: "a", date: "2026-12-05" }, "amount is required"],
    ])("refuses a create missing a required field (%o)", async (input, message) => {
      const result = parse(await run({ action: "create", ...input }));
      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
      expect(mockApi.scheduledTransactions.createScheduledTransaction).not.toHaveBeenCalled();
    });

    it("refuses a closed or unknown account name", async () => {
      const result = parse(await run({ action: "create", accountName: "savings", date: "2026-12-05", amount: 1 }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No account matching "savings"');
    });

    it("reports a YNAB error", async () => {
      mockApi.scheduledTransactions.createScheduledTransaction.mockRejectedValue(new Error("date must be in the future"));
      const result = parse(await run({ action: "create", accountId: "a", date: "2020-01-01", amount: 1 }));
      expect(result).toEqual({ success: false, error: "date must be in the future" });
    });
  });

  describe("update", () => {
    it("moves a scheduled transaction to another account, keeping every other field", async () => {
      const result = parse(await run({ action: "update", scheduledTransactionId: "st-1", accountName: "Ally Checking" }));

      expect(mockApi.scheduledTransactions.getScheduledTransactionById).toHaveBeenCalledWith("plan-1", "st-1");
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).toHaveBeenCalledWith("plan-1", "st-1", {
        scheduled_transaction: {
          account_id: "acct-checking",
          date: "2026-12-05",
          amount: -14950,
          payee_id: "payee-audible",
          category_id: "cat-subs",
          memo: "Audible",
          flag_color: null,
          frequency: "monthly",
        },
      });
      expect(result.success).toBe(true);
      expect(result.matchedAccount).toBe("Ally Checking");
      expect(result.message).toBe("Scheduled transaction updated successfully");
    });

    it("refuses an overdue update without a new date", async () => {
      mockApi.scheduledTransactions.getScheduledTransactionById.mockResolvedValue({
        data: { scheduled_transaction: { ...scheduled, date_next: "2026-06-14" } },
      });

      const result = parse(await run({ action: "update", scheduledTransactionId: "st-1", memo: "new memo" }));

      expect(result).toEqual({
        success: false,
        error: "This scheduled transaction is overdue; provide a new future date to update it.",
      });
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });

    it("updates an overdue schedule when given a new future date", async () => {
      mockApi.scheduledTransactions.getScheduledTransactionById.mockResolvedValue({
        data: { scheduled_transaction: { ...scheduled, date_next: "2026-06-14" } },
      });

      const result = parse(await run({
        action: "update",
        scheduledTransactionId: "st-1",
        date: "2026-06-16",
        memo: "new memo",
      }));

      expect(result.success).toBe(true);
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).toHaveBeenCalledWith("plan-1", "st-1", {
        scheduled_transaction: expect.objectContaining({ date: "2026-06-16", memo: "new memo" }),
      });
    });

    it("preserves a payee name when the existing schedule has no payee id", async () => {
      mockApi.scheduledTransactions.getScheduledTransactionById.mockResolvedValue({
        data: { scheduled_transaction: { ...scheduled, payee_id: null, payee_name: "Audible" } },
      });

      await run({ action: "update", scheduledTransactionId: "st-1", accountId: "acct-checking" });

      const sent = mockApi.scheduledTransactions.updateScheduledTransaction.mock.calls[0][2].scheduled_transaction;
      expect(sent.payee_id).toBeNull();
      expect(sent.payee_name).toBe("Audible");
    });

    it("applies only the given fields", async () => {
      await run({
        action: "update",
        scheduledTransactionId: "st-1",
        date: "2027-01-10",
        frequency: "yearly",
        amount: -149.5,
        payeeName: "Audible Annual",
        memo: "",
        flagColor: "red",
      });

      const sent = mockApi.scheduledTransactions.updateScheduledTransaction.mock.calls[0][2].scheduled_transaction;
      expect(sent).toEqual({
        account_id: "acct-old",
        date: "2027-01-10",
        frequency: "yearly",
        amount: -149500,
        payee_id: null,
        payee_name: "Audible Annual",
        category_id: "cat-subs",
        memo: "",
        flag_color: "red",
      });
      expect(mockApi.accounts.getAccounts).not.toHaveBeenCalled();
    });

    it("requires an id and at least one change", async () => {
      let result = parse(await run({ action: "update", amount: 1 }));
      expect(result.error).toContain("scheduledTransactionId is required to update");

      result = parse(await run({ action: "update", scheduledTransactionId: "st-1" }));
      expect(result.error).toContain("at least one field");
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });

    it("refuses to edit a split scheduled transaction", async () => {
      mockApi.scheduledTransactions.getScheduledTransactionById.mockResolvedValue({
        data: { scheduled_transaction: { ...scheduled, subtransactions: [{ id: "s1", deleted: false }] } },
      });
      const result = parse(await run({ action: "update", scheduledTransactionId: "st-1", memo: "x" }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("split");
      expect(mockApi.scheduledTransactions.updateScheduledTransaction).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes by id", async () => {
      const result = parse(await run({ action: "delete", scheduledTransactionId: "st-1" }));
      expect(mockApi.scheduledTransactions.deleteScheduledTransaction).toHaveBeenCalledWith("plan-1", "st-1");
      expect(result).toEqual({
        success: true,
        scheduledTransactionId: "st-1",
        message: "Scheduled transaction deleted successfully",
      });
    });

    it("requires an id", async () => {
      const result = parse(await run({ action: "delete" }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("scheduledTransactionId is required to delete");
      expect(mockApi.scheduledTransactions.deleteScheduledTransaction).not.toHaveBeenCalled();
    });
  });

  describe("registration", () => {
    function registeredNames(readOnly: boolean) {
      const names = new Map<string, Record<string, any>>();
      const server: ToolRegistrar = {
        registerTool(name, config) {
          names.set(name, config);
        },
      };
      registerAll(server, {} as ynab.API, { readOnly });
      return names;
    }

    it("is a destructive write tool", () => {
      const config = registeredNames(false).get(ManageScheduledTransactionTool.name);
      expect(config?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    });

    it("is not available in read-only mode", () => {
      const names = registeredNames(true);
      expect(names.has(ManageScheduledTransactionTool.name)).toBe(false);
      expect(names.has("ynab_list_scheduled_transactions")).toBe(true);
    });
  });
});
