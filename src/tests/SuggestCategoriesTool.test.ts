import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ynab from "ynab";

import * as Tool from "../tools/SuggestCategoriesTool.js";

function category(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category_group_id: "group-everyday",
    name,
    hidden: false,
    deleted: false,
    budgeted: 0,
    activity: 0,
    balance: 0,
    ...overrides,
  };
}

function group(id: string, name: string, categories: any[], overrides: Record<string, unknown> = {}) {
  return { id, name, hidden: false, deleted: false, categories, ...overrides };
}

function transaction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
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

function history(id: string, categoryId: string, overrides: Record<string, unknown> = {}) {
  return transaction(id, {
    date: "2026-08-01",
    category_id: categoryId,
    category_name: categoryId,
    ...overrides,
  });
}

function makeApi(options: {
  candidates?: any[];
  history?: any[];
  groups?: any[];
  payees?: any[];
  accounts?: any[];
} = {}) {
  const candidates = options.candidates ?? [transaction("txn-1")];
  const oldTransactions = options.history ?? [];
  return {
    transactions: {
      getTransactions: vi.fn()
        .mockResolvedValueOnce({ data: { transactions: candidates } })
        .mockResolvedValueOnce({ data: { transactions: oldTransactions } }),
      getTransactionById: vi.fn(),
    },
    categories: {
      getCategories: vi.fn().mockResolvedValue({
        data: { category_groups: options.groups ?? [group("group-everyday", "Everyday", [category("cat-grocery", "Groceries"), category("cat-dining", "Dining Out")])] },
      }),
    },
    payees: {
      getPayees: vi.fn().mockResolvedValue({
        data: { payees: options.payees ?? [{ id: "payee-uuid", name: "Market", transfer_account_id: null, deleted: false }] },
      }),
    },
    accounts: {
      getAccounts: vi.fn().mockResolvedValue({
        data: { accounts: options.accounts ?? [{ id: "account-uuid", name: "Checking", type: "checking", on_budget: true, deleted: false }] },
      }),
    },
  };
}

function choiceResponse(answers: Record<string, unknown>, usage = { input_tokens: 1000, output_tokens: 50 }) {
  return new Response(JSON.stringify({ model: Tool.PINNED_MODEL, answers, usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function answer(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { type: "choice", choice, confidence, probabilities };
}

async function result(input: any, api: any) {
  const response = await Tool.execute(input, api as ynab.API);
  return JSON.parse(response.content[0].text);
}

describe("SuggestCategoriesTool", () => {
  beforeEach(() => {
    process.env.YNAB_BUDGET_ID = "budget-id";
    process.env.YNAB_AI_CATEGORIZATION = "true";
    process.env.TYPESAFE_API_KEY = "typesafe-test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.YNAB_AI_CATEGORIZATION;
    delete process.env.TYPESAFE_API_KEY;
  });

  it("is disabled unless both the explicit flag and API key are present", async () => {
    delete process.env.YNAB_AI_CATEGORIZATION;
    const api = makeApi();

    const output = await result({}, api);

    expect(output).toMatchObject({
      success: false,
      error: expect.stringContaining("disabled"),
      requested_model: Tool.PINNED_MODEL,
      model: Tool.PINNED_MODEL,
      provider_calls: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        projected_cost_usd: 0,
      },
    });
    expect(api.transactions.getTransactions).not.toHaveBeenCalled();
  });

  it("filters real YNAB system-category shapes without hiding ordinary categories", () => {
    const eligible = Tool.getEligibleCategories([
      group("Internal Master Category", "Internal Master Category", [
        category("Immediate Income SubCategory", "Inflow: Ready to Assign"),
        category("Uncategorized", "Uncategorized"),
        category("Split", "Split"),
      ]),
      group("credit-card-payments", "Credit Card Payments", [category("payment-1", "Visa")]),
      group("Hidden Categories", "Hidden Categories", [category("legacy-hidden", "Legacy hidden")]),
      group("hidden", "Hidden", [category("hidden-cat", "Secret")], { hidden: true }),
      group("deleted", "Deleted", [category("deleted-cat", "Gone")], { deleted: true }),
      group("everyday", "Everyday", [
        category("cat-visible", "Groceries"),
        category("cat-hidden", "Hidden child", { hidden: true }),
        category("cat-deleted", "Deleted child", { deleted: true }),
      ]),
    ] as any);

    expect(eligible).toEqual([{
      id: "cat-visible",
      key: "c000",
      groupName: "Everyday",
      name: "Groceries",
    }]);
  });

  it("returns every deterministic skip reason and sends only eligible rows to TypeSafe", async () => {
    const candidates = [
      transaction("deleted", { deleted: true }),
      transaction("row-transfer", { transfer_account_id: "other-account" }),
      transaction("payee-transfer", { payee_id: "transfer-payee" }),
      transaction("deleted-payee-transfer", { payee_id: "deleted-transfer-payee" }),
      transaction("split-transfer", { subtransactions: [{ id: "sub-transfer", transaction_id: "split-transfer", amount: -1000, transfer_account_id: "account-2", deleted: false }] }),
      transaction("split", { subtransactions: [{ id: "sub", transaction_id: "split", amount: -1000, deleted: false }] }),
      transaction("categorized", { category_id: "cat-grocery" }),
      transaction("inflow", { amount: 25000 }),
      transaction("eligible"),
    ];
    const api = makeApi({
      candidates,
      history: [history("old-grocery", "cat-grocery")],
      payees: [
        { id: "payee-uuid", name: "Market", transfer_account_id: null, deleted: false },
        { id: "transfer-payee", name: "Transfer", transfer_account_id: "account-2", deleted: false },
        { id: "deleted-transfer-payee", name: "Old Transfer", transfer_account_id: "account-3", deleted: true },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue(choiceResponse({
      t00: answer("c001", 0.9, { c000: 0.08, c001: 0.9, leave_uncategorized: 0.02 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output.transactions.map((row: any) => [row.transaction_id, row.status])).toEqual([
      ["row-transfer", "skipped_transfer"],
      ["payee-transfer", "skipped_transfer"],
      ["deleted-payee-transfer", "skipped_transfer"],
      ["split-transfer", "skipped_transfer"],
      ["split", "skipped_split"],
      ["categorized", "skipped_already_categorized"],
      ["inflow", "skipped_inflow"],
      ["eligible", "suggested"],
    ]);
    expect(output.transactions.some((row: any) => row.transaction_id === "deleted")).toBe(false);
    expect(output.transactions.find((row: any) => row.transaction_id === "row-transfer").history).toMatchObject({
      sample_size: 1,
      dominant_category_id: "cat-grocery",
      agreement: "not_applicable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.state.transactions).toHaveLength(1);
    expect(request.state.transactions[0]).toMatchObject({
      payee_name: "Market",
      amount: -12.5,
      direction: "outflow",
      account: { name: "Checking", type: "checking", on_budget: true },
    });
  });

  it("uses an unanimous three-row exact-payee history rule without a model call", async () => {
    const api = makeApi({ history: [
      history("old-1", "cat-grocery"),
      history("old-2", "cat-grocery", { date: "2026-07-01" }),
      history("old-3", "cat-grocery", { date: "2026-06-01" }),
    ] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.transactions[0]).toMatchObject({
      transaction_id: "txn-1",
      status: "suggested",
      source: "history_rule",
      proposed_category: { id: "cat-grocery", group_name: "Everyday", name: "Groceries" },
      model_confidence: null,
      history: { sample_size: 3, dominant_category_id: "cat-grocery", conflict: false },
    });
    expect(output.provider_calls).toBe(0);
    expect(output.usage.input_tokens).toBe(0);
  });

  it("keeps history-rule suggestions when account loading fails", async () => {
    const api = makeApi({
      candidates: [
        transaction("history-rule"),
        transaction("model-bound", { payee_id: "other-payee" }),
      ],
      history: [
        history("old-1", "cat-grocery"),
        history("old-2", "cat-grocery", { date: "2026-07-01" }),
        history("old-3", "cat-grocery", { date: "2026-06-01" }),
      ],
    });
    api.accounts.getAccounts.mockRejectedValue(new Error("accounts unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output.transactions).toMatchObject([
      {
        transaction_id: "history-rule",
        status: "suggested",
        source: "history_rule",
        proposed_category: { id: "cat-grocery" },
      },
      {
        transaction_id: "model-bound",
        status: "failed",
        error: expect.stringContaining("accounts unavailable"),
      },
    ]);
    expect(output.provider_calls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces review when mixed exact-payee history disagrees with Jev", async () => {
    const api = makeApi({ history: [
      history("old-1", "cat-grocery"),
      history("old-2", "cat-grocery", { date: "2026-07-01" }),
      history("old-3", "cat-dining", { date: "2026-06-01" }),
    ] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(choiceResponse({
      t00: answer("c000", 0.98, { c000: 0.98, c001: 0.01, leave_uncategorized: 0.01 }),
    })));

    const output = await result({}, api);

    // Alphabetical category keys make Dining Out c000 and Groceries c001.
    expect(output.transactions[0]).toMatchObject({
      status: "needs_review",
      source: "jev",
      proposed_category: { id: "cat-dining" },
      model_confidence: 0.98,
      winning_probability: 0.98,
      history: { dominant_category_id: "cat-grocery", agrees_with_suggestion: false, conflict: true },
    });
  });

  it("returns a dry-run proposal, three alternatives, fingerprint, model, usage, and cost without leaking YNAB IDs to Jev", async () => {
    const categories = [
      category("cat-a", "Alpha"),
      category("cat-b", "Beta"),
      category("cat-c", "Gamma"),
      category("cat-d", "Delta"),
      category("cat-e", "Epsilon"),
    ];
    const api = makeApi({ groups: [group("group-everyday", "Everyday", categories)] });
    const fetchMock = vi.fn().mockResolvedValue(choiceResponse({
      t00: answer("c000", 0.75, {
        c000: 0.45,
        c001: 0.2,
        c002: 0.15,
        c003: 0.1,
        c004: 0.08,
        leave_uncategorized: 0.02,
      }),
    }, { input_tokens: 1234, output_tokens: 56 }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output).toMatchObject({
      success: true,
      dry_run: true,
      requested_model: "jev-1.13.0",
      model: "jev-1.13.0",
      provider_calls: 1,
      thresholds: { provisional: true, suggested_at_or_above: 0.8, needs_review_at_or_above: 0.5 },
      usage: { input_tokens: 1234, output_tokens: 56, projected_cost_usd: 0.000051828 },
    });
    expect(output.usage).not.toHaveProperty("input_cost_usd");
    expect(output.transactions[0]).toMatchObject({
      status: "needs_review",
      source: "jev",
      proposed_category: { id: "cat-a", name: "Alpha" },
      model_confidence: 0.75,
      winning_probability: 0.45,
    });
    expect(output.transactions[0].content_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.transactions[0].top_alternatives).toHaveLength(3);

    const [url, init] = fetchMock.mock.calls[0];
    const requestBody = String(init.body);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.authorization).toBe("Bearer typesafe-test-secret");
    expect(requestBody).not.toContain("account-uuid");
    expect(requestBody).not.toContain("payee-uuid");
    expect(requestBody).not.toContain("cat-a");
    expect(requestBody).not.toContain("typesafe-test-secret");
    expect(requestBody).not.toContain("balance");
    expect(requestBody).not.toContain("approved");
    expect(requestBody).toContain("MARKET #123");
  });

  it("rejects inconsistent Choice probability distributions per row", async () => {
    const api = makeApi({ candidates: [
      transaction("wrong-winner"),
      transaction("invalid-total", { payee_id: "other-payee" }),
    ] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(choiceResponse({
      t00: answer("c000", 0.9, { c000: 0.1, c001: 0.8, leave_uncategorized: 0.1 }),
      t01: answer("c001", 0.9, { c000: 0.1, c001: 0.4, leave_uncategorized: 0.1 }),
    })));

    const output = await result({}, api);

    expect(output.transactions).toMatchObject([
      {
        transaction_id: "wrong-winner",
        status: "failed",
        error: "TypeSafe returned a missing or malformed Choice answer",
      },
      {
        transaction_id: "invalid-total",
        status: "failed",
        error: "TypeSafe returned a missing or malformed Choice answer",
      },
    ]);
  });

  it("turns a provider failure into failed rows without throwing or writing to YNAB", async () => {
    const api = makeApi({ candidates: [transaction("txn-1"), transaction("txn-2", { payee_id: "other-payee" })] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("overloaded", { status: 529 })));

    const output = await result({}, api);

    expect(output.success).toBe(true);
    expect(output.transactions).toHaveLength(2);
    expect(output.transactions.every((row: any) => row.status === "failed")).toBe(true);
    expect(output.transactions[0].error).toBe("TypeSafe request failed with HTTP 529");
    expect(output.provider_calls).toBe(1);
    expect(api.transactions).not.toHaveProperty("updateTransaction");
  });

  it("refuses an oversized provider request during the token and cost preflight", async () => {
    const hugeName = "long category context ".repeat(12_000);
    const api = makeApi({ groups: [group("large-text", "Large", [category("cat-huge", hugeName)])] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output.success).toBe(true);
    expect(output.transactions[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("preflight refused"),
    });
    expect(output.provider_calls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses oversized Unicode context using its UTF-8 byte bound", async () => {
    const unicodeContext = "漢字😀".repeat(4_000);
    const api = makeApi({ candidates: [transaction("unicode", {
      payee_name: unicodeContext,
      memo: unicodeContext,
    })] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output.transactions[0]).toMatchObject({
      transaction_id: "unicode",
      status: "failed",
      error: expect.stringContaining("preflight refused"),
    });
    expect(output.usage.estimated_input_tokens_before_calls).toBeGreaterThan(Tool.MAX_ESTIMATED_REQUEST_TOKENS);
    expect(output.provider_calls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves deterministic skips and zero spend metadata when a YNAB prerequisite fails", async () => {
    const api = makeApi({ candidates: [
      transaction("transfer", { transfer_account_id: "other-account" }),
      transaction("eligible"),
    ] });
    api.categories.getCategories.mockRejectedValue(new Error("categories unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output).toMatchObject({
      success: true,
      requested_model: Tool.PINNED_MODEL,
      model: Tool.PINNED_MODEL,
      provider_calls: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        projected_cost_usd: 0,
      },
    });
    expect(output.transactions).toMatchObject([
      {
        transaction_id: "transfer",
        status: "skipped_transfer",
        history: { sample_size: 0, agreement: "not_applicable" },
      },
      {
        transaction_id: "eligible",
        status: "failed",
        history: { sample_size: 0, agreement: "not_applicable" },
        error: expect.stringContaining("categories unavailable"),
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves skipped rows when no eligible categories are available", async () => {
    const api = makeApi({
      candidates: [
        transaction("transfer", { transfer_account_id: "other-account" }),
        transaction("eligible"),
      ],
      groups: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output.success).toBe(true);
    expect(output.transactions).toMatchObject([
      { transaction_id: "transfer", status: "skipped_transfer" },
      {
        transaction_id: "eligible",
        status: "failed",
        error: "No visible writable categories are available in this budget.",
      },
    ]);
    expect(output.usage).toMatchObject({ input_tokens: 0, output_tokens: 0, projected_cost_usd: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves skipped rows when refusing more than 255 Choice options", async () => {
    const categories = Array.from({ length: 255 }, (_, index) => category(`cat-${index}`, `Category ${index}`));
    const api = makeApi({
      candidates: [
        transaction("transfer", { transfer_account_id: "other-account" }),
        transaction("eligible"),
      ],
      groups: [group("large", "Large", categories)],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result({}, api);

    expect(output.success).toBe(true);
    expect(output.transactions).toMatchObject([
      { transaction_id: "transfer", status: "skipped_transfer" },
      {
        transaction_id: "eligible",
        status: "failed",
        error: expect.stringContaining("255 eligible categories plus leave_uncategorized"),
      },
    ]);
    expect(output.transactions[1].error).toContain("No categories were truncated");
    expect(output).toMatchObject({
      requested_model: Tool.PINNED_MODEL,
      model: Tool.PINNED_MODEL,
      provider_calls: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        projected_cost_usd: 0,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an omitted transactionIds field", {}],
    ["a null transactionIds field", { transactionIds: null }],
    ["an empty transactionIds array", { transactionIds: [] }],
  ])("fetches uncategorized transactions for %s", async (_label, input) => {
    const api = makeApi({ candidates: [] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await result(input, api);

    expect(output.success).toBe(true);
    expect(api.transactions.getTransactions).toHaveBeenNthCalledWith(
      1,
      "budget-id",
      undefined,
      ynab.GetTransactionsTypeEnum.Uncategorized,
    );
    expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses explicit transaction IDs instead of the uncategorized fetch", async () => {
    const api = makeApi();
    api.transactions.getTransactionById
      .mockResolvedValueOnce({ data: { transaction: transaction("ok") } })
      .mockRejectedValueOnce(new Error("not found"));
    // In explicit-ID mode the only getTransactions call is history.
    api.transactions.getTransactions = vi.fn().mockResolvedValue({ data: { transactions: [] } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(choiceResponse({
      t00: answer("leave_uncategorized", 0.9, { c000: 0.05, c001: 0.05, leave_uncategorized: 0.9 }),
    })));

    const output = await result({ transactionIds: ["ok", "missing"] }, api);

    expect(output.transactions.map((row: any) => [row.transaction_id, row.status])).toEqual([
      ["ok", "left_uncategorized"],
      ["missing", "failed"],
    ]);
    expect(output.transactions[1].error).toContain("not found");
    expect(api.transactions.getTransactionById).toHaveBeenCalledTimes(2);
    expect(api.transactions.getTransactions.mock.calls).not.toContainEqual([
      "budget-id",
      undefined,
      ynab.GetTransactionsTypeEnum.Uncategorized,
    ]);
  });
});
