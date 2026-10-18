import type * as ynab from "ynab";

/** Synthetic test data and a fake YNAB API. Nothing here comes from a real plan. */

export const PLAN_ID = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT_ID = "acc-checking";

let sequence = 0;

export function txn(overrides: Partial<ynab.TransactionDetail> = {}): ynab.TransactionDetail {
  sequence++;
  return {
    id: `t${sequence}`,
    date: "2026-10-10",
    amount: -12_500,
    cleared: "cleared" as ynab.TransactionClearedStatus,
    approved: false,
    account_id: ACCOUNT_ID,
    account_name: "Checking",
    payee_id: "p-coffee",
    payee_name: "Corner Coffee",
    category_id: null,
    deleted: false,
    subtransactions: [],
    ...overrides,
  } as ynab.TransactionDetail;
}

export function category(overrides: Partial<ynab.Category> = {}): ynab.Category {
  sequence++;
  return {
    id: `c${sequence}`,
    category_group_id: "g-everyday",
    category_group_name: "Everyday",
    name: `Category ${sequence}`,
    hidden: false,
    internal: false,
    budgeted: 100_000,
    activity: 0,
    balance: 100_000,
    deleted: false,
    ...overrides,
  } as ynab.Category;
}

export function month(overrides: Partial<ynab.MonthDetail> = {}): ynab.MonthDetail {
  return {
    month: "2026-10-01",
    income: 0,
    budgeted: 0,
    activity: 0,
    to_be_budgeted: 0,
    deleted: false,
    categories: [],
    ...overrides,
  } as ynab.MonthDetail;
}

export function account(overrides: Partial<ynab.Account> = {}): ynab.Account {
  return {
    id: ACCOUNT_ID,
    name: "Checking",
    type: "checking" as ynab.AccountType,
    on_budget: true,
    closed: false,
    balance: 0,
    cleared_balance: 0,
    uncleared_balance: 0,
    transfer_payee_id: "p-transfer-checking",
    direct_import_linked: true,
    direct_import_in_error: false,
    deleted: false,
    ...overrides,
  } as ynab.Account;
}

export function scheduled(overrides: Partial<ynab.ScheduledTransactionDetail> = {}): ynab.ScheduledTransactionDetail {
  sequence++;
  return {
    id: `s${sequence}`,
    date_first: "2026-01-20",
    date_next: "2026-10-20",
    frequency: "monthly" as ynab.ScheduledTransactionFrequency,
    amount: -80_000,
    account_id: ACCOUNT_ID,
    account_name: "Checking",
    payee_name: "Power Company",
    deleted: false,
    subtransactions: [],
    ...overrides,
  } as ynab.ScheduledTransactionDetail;
}

/** Groups categories the way GET /categories returns them, under one visible group. */
export function groups(categories: ynab.Category[]): ynab.CategoryGroupWithCategories[] {
  return [{ id: "g-everyday", name: "Everyday", hidden: false, deleted: false, categories }];
}

export interface FakeYnabState {
  plans: Array<{ id: string; name: string }>;
  /** Served for a full (since_date) read. */
  transactions: ynab.TransactionDetail[];
  /** Served for a delta (last_knowledge_of_server) read. */
  delta: ynab.TransactionDetail[];
  serverKnowledge: number;
  accounts: ynab.Account[];
  categoryGroups: ynab.CategoryGroupWithCategories[];
  month: ynab.MonthDetail;
  nextMonth: ynab.MonthDetail;
  scheduled: ynab.ScheduledTransactionDetail[];
  /** Forces an HTTP status for any path containing the key. */
  failures: Record<string, number>;
  pushoverStatus: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: string | null;
}

/** A fetch that serves YNAB and Pushover from `state` and records every request. */
export function fakeApis(overrides: Partial<FakeYnabState> = {}) {
  const state: FakeYnabState = {
    plans: [{ id: PLAN_ID, name: "Household" }],
    transactions: [],
    delta: [],
    serverKnowledge: 100,
    accounts: [account()],
    categoryGroups: groups([]),
    month: month(),
    nextMonth: month({ month: "2026-11-01" }),
    scheduled: [],
    failures: {},
    pushoverStatus: 200,
    ...overrides,
  };
  const requests: RecordedRequest[] = [];

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(status < 400 ? { data } : { error: { id: String(status), name: "error", detail: data } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", url: url.toString(), body: init?.body ? String(init.body) : null });

    if (url.hostname === "api.pushover.net") {
      return json({ status: 1 }, state.pushoverStatus);
    }

    const path = url.pathname.replace(/^\/v1/, "");
    for (const [fragment, status] of Object.entries(state.failures)) {
      if (path.includes(fragment)) {
        return json(status === 404 ? "Resource not found" : status === 429 ? "Too many requests" : "failure", status);
      }
    }
    if (path === "/plans") return json({ plans: state.plans });

    const prefix = `/plans/${PLAN_ID}`;
    if (!path.startsWith(prefix)) return json("Resource not found", 404);
    const rest = path.slice(prefix.length);

    if (rest === "/transactions") {
      const delta = url.searchParams.has("last_knowledge_of_server");
      return json({ transactions: delta ? state.delta : state.transactions, server_knowledge: state.serverKnowledge });
    }
    if (rest === "/accounts") return json({ accounts: state.accounts, server_knowledge: state.serverKnowledge });
    if (rest === "/settings") {
      return json({ settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } });
    }
    if (rest === "/categories") return json({ category_groups: state.categoryGroups, server_knowledge: state.serverKnowledge });
    if (rest === "/months/current") return json({ month: state.month });
    if (rest === `/months/${state.nextMonth.month}`) return json({ month: state.nextMonth });
    if (rest === "/scheduled_transactions") {
      return json({ scheduled_transactions: state.scheduled, server_knowledge: state.serverKnowledge });
    }
    return json("Resource not found", 404);
  };

  return { state, requests, fetch: fetchImpl as typeof fetch };
}
