import { z } from "zod";
import * as ynab from "ynab";

import { getErrorMessage } from "./errorUtils.js";
import { toDollars } from "./money.js";

export const name = "ynab_suggest_categories";
export const description = "Previews category suggestions for uncategorized outflows, using a history rule only when at least three retained exact-payee rows unanimously use one eligible category and TypeSafe Jev otherwise. Never writes to YNAB.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The budget ID (defaults to YNAB_BUDGET_ID)"),
  transactionIds: z.array(z.string()).min(1).max(100).optional().describe("Specific transaction IDs to inspect instead of fetching uncategorized transactions"),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum rows to inspect when transactionIds is omitted (default: 20, maximum: 100)"),
};

interface SuggestCategoriesInput {
  budgetId?: string;
  transactionIds?: string[];
  limit?: number;
}

export const PINNED_MODEL = "jev-1.13.0";
export const PUBLISHED_INPUT_PRICE_PER_MILLION_USD = 0.042;
export const PROVISIONAL_SUGGEST_CONFIDENCE = 0.80;
export const PROVISIONAL_REVIEW_CONFIDENCE = 0.50;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_BATCH_SIZE = 10;
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_ESTIMATED_REQUEST_TOKENS = 60_000;
export const MAX_ESTIMATED_STATE_AND_QUESTION_TOKENS = 30_000;
export const MAX_PROJECTED_COST_PER_CALL_USD = 0.01;
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_TIMEOUT_MS = 10_000;
const HISTORY_MAX_ROWS = 50;

export interface EligibleCategory {
  id: string;
  key: string;
  groupName: string;
  name: string;
}

interface AccountContext {
  name: string;
  type: string;
  onBudget: boolean;
}

interface CategoryCount {
  categoryId: string;
  groupName: string;
  categoryName: string;
  count: number;
}

interface HistorySummary {
  sampleSize: number;
  counts: CategoryCount[];
  lastUsedCategoryId: string | null;
  unanimousCategoryId: string | null;
  dominantCategoryId: string | null;
}

function emptyHistorySummary(): HistorySummary {
  return {
    sampleSize: 0,
    counts: [],
    lastUsedCategoryId: null,
    unanimousCategoryId: null,
    dominantCategoryId: null,
  };
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface TypeSafeResponse {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface CandidateLoad {
  transactions: ynab.TransactionDetail[];
  failures: Array<{ transactionId: string; error: string }>;
}

interface Preflight {
  estimatedInputTokens: number;
  estimatedStateAndLongestQuestionTokens: number;
  projectedCostUsd: number;
  allowed: boolean;
  error?: string;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set YNAB_BUDGET_ID.");
  }
  return budgetId;
}

export function isCategorySuggestionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.YNAB_AI_CATEGORIZATION === "true" && Boolean(env.TYPESAFE_API_KEY);
}

function normalizeSystemName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const EXCLUDED_GROUP_NAMES = new Set([
  "internal master category",
  "credit card payment",
  "credit card payments",
  "hidden categories",
]);
const EXCLUDED_CATEGORY_IDS = new Set([
  "split",
  "uncategorized",
  "immediate income subcategory",
  "deferred income subcategory",
]);

/** Selects only categories YNAB accepts on an ordinary categorized transaction. */
export function getEligibleCategories(
  groups: ynab.CategoryGroupWithCategories[],
): EligibleCategory[] {
  const categories: Omit<EligibleCategory, "key">[] = [];

  for (const group of groups) {
    const normalizedGroupId = normalizeSystemName(group.id);
    const normalizedGroupName = normalizeSystemName(group.name);
    if (
      group.deleted ||
      group.hidden ||
      EXCLUDED_GROUP_NAMES.has(normalizedGroupId) ||
      EXCLUDED_GROUP_NAMES.has(normalizedGroupName)
    ) {
      continue;
    }

    for (const category of group.categories) {
      if (
        category.deleted ||
        category.hidden ||
        EXCLUDED_CATEGORY_IDS.has(normalizeSystemName(category.id))
      ) {
        continue;
      }
      categories.push({
        id: category.id,
        groupName: group.name,
        name: category.name,
      });
    }
  }

  categories.sort((a, b) =>
    a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  return categories.map((category, index) => ({
    ...category,
    key: `c${String(index).padStart(3, "0")}`,
  }));
}

function activeSubtransactions(transaction: ynab.TransactionDetail): ynab.SubTransaction[] {
  return (transaction.subtransactions ?? []).filter((sub) => !sub.deleted);
}

function isTransfer(
  transaction: ynab.TransactionDetail,
  payeesById: Map<string, ynab.Payee>,
): boolean {
  if (transaction.transfer_account_id) return true;
  if (transaction.payee_id && payeesById.get(transaction.payee_id)?.transfer_account_id) return true;
  return activeSubtransactions(transaction).some((sub) => Boolean(sub.transfer_account_id));
}

function skippedStatus(
  transaction: ynab.TransactionDetail,
  payeesById: Map<string, ynab.Payee>,
): string | null {
  if (isTransfer(transaction, payeesById)) return "skipped_transfer";
  if (activeSubtransactions(transaction).length > 0) return "skipped_split";
  if (transaction.category_id) return "skipped_already_categorized";
  if (transaction.amount >= 0) return "skipped_inflow";
  return null;
}

function displayFields(transaction: ynab.TransactionDetail) {
  return {
    date: transaction.date,
    payee: transaction.payee_name ?? transaction.import_payee_name ?? transaction.import_payee_name_original ?? null,
    amount: toDollars(transaction.amount),
    account: transaction.account_name,
  };
}

function stableFingerprintPayload(transaction: ynab.TransactionDetail): string {
  return JSON.stringify({
    date: transaction.date,
    amount: transaction.amount,
    memo: transaction.memo ?? null,
    account_id: transaction.account_id,
    payee_id: transaction.payee_id ?? null,
    category_id: transaction.category_id ?? null,
    transfer_account_id: transaction.transfer_account_id ?? null,
    import_payee_name: transaction.import_payee_name ?? null,
    import_payee_name_original: transaction.import_payee_name_original ?? null,
    subtransactions: activeSubtransactions(transaction).map((sub) => ({
      id: sub.id,
      amount: sub.amount,
      payee_id: sub.payee_id ?? null,
      category_id: sub.category_id ?? null,
      transfer_account_id: sub.transfer_account_id ?? null,
    })),
  });
}

async function contentFingerprint(transaction: ynab.TransactionDetail): Promise<string> {
  const bytes = new TextEncoder().encode(stableFingerprintPayload(transaction));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function twelveMonthsAgo(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, now.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

async function loadCandidates(
  input: SuggestCategoriesInput,
  budgetId: string,
  api: ynab.API,
): Promise<CandidateLoad> {
  if (!input.transactionIds) {
    const response = await api.transactions.getTransactions(
      budgetId,
      undefined,
      ynab.GetTransactionsTypeEnum.Uncategorized,
    );
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return {
      transactions: response.data.transactions.filter((transaction) => !transaction.deleted).slice(0, limit),
      failures: [],
    };
  }

  const ids = [...new Set(input.transactionIds)];
  if (ids.length === 0 || ids.length > MAX_LIMIT) {
    throw new Error(`transactionIds must contain between 1 and ${MAX_LIMIT} unique IDs`);
  }
  const settled = await Promise.allSettled(
    ids.map((transactionId) => api.transactions.getTransactionById(budgetId, transactionId)),
  );
  const transactions: ynab.TransactionDetail[] = [];
  const failures: CandidateLoad["failures"] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (!result.value.data.transaction.deleted) transactions.push(result.value.data.transaction);
    } else {
      failures.push({ transactionId: ids[index], error: getErrorMessage(result.reason) });
    }
  });
  return { transactions, failures };
}

function buildHistorySummary(
  transaction: ynab.TransactionDetail,
  history: ynab.TransactionDetail[],
  payeesById: Map<string, ynab.Payee>,
  categoriesById: Map<string, EligibleCategory>,
): HistorySummary {
  if (!transaction.payee_id) {
    return emptyHistorySummary();
  }

  const rows = history
    .filter((row) =>
      row.id !== transaction.id &&
      row.payee_id === transaction.payee_id &&
      !row.deleted &&
      Boolean(row.category_id) &&
      categoriesById.has(row.category_id ?? "") &&
      !isTransfer(row, payeesById) &&
      activeSubtransactions(row).length === 0
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, HISTORY_MAX_ROWS);

  const countsById = new Map<string, number>();
  for (const row of rows) {
    const categoryId = row.category_id as string;
    countsById.set(categoryId, (countsById.get(categoryId) ?? 0) + 1);
  }
  const counts = [...countsById.entries()]
    .map(([categoryId, count]) => {
      const category = categoriesById.get(categoryId) as EligibleCategory;
      return { categoryId, groupName: category.groupName, categoryName: category.name, count };
    })
    .sort((a, b) => b.count - a.count || a.categoryName.localeCompare(b.categoryName));
  const unanimousCategoryId = rows.length >= 3 && counts.length === 1 ? counts[0].categoryId : null;
  const dominantCategoryId = counts.length > 0 && (counts.length === 1 || counts[0].count > counts[1].count)
    ? counts[0].categoryId
    : null;

  return {
    sampleSize: rows.length,
    counts,
    lastUsedCategoryId: rows[0]?.category_id ?? null,
    unanimousCategoryId,
    dominantCategoryId,
  };
}

function historyForOutput(summary: HistorySummary, suggestedCategoryId: string | null | undefined) {
  const agrees = summary.dominantCategoryId && suggestedCategoryId !== undefined
    ? summary.dominantCategoryId === suggestedCategoryId
    : null;
  return {
    sample_size: summary.sampleSize,
    counts: summary.counts.map((count) => ({
      category_id: count.categoryId,
      group_name: count.groupName,
      category_name: count.categoryName,
      count: count.count,
    })),
    last_used_category_id: summary.lastUsedCategoryId,
    dominant_category_id: summary.dominantCategoryId,
    agrees_with_suggestion: agrees,
    agreement: suggestedCategoryId === undefined ? "not_applicable" : agrees === null ? "insufficient" : agrees ? "agrees" : "conflicts",
    conflict: agrees === false,
  };
}

function modelState(
  transactions: ynab.TransactionDetail[],
  accountsById: Map<string, AccountContext>,
  categories: EligibleCategory[],
) {
  return {
    eligible_categories: categories.map((category) => ({
      key: category.key,
      group: category.groupName,
      name: category.name,
    })),
    transactions: transactions.map((transaction) => {
      const account = accountsById.get(transaction.account_id);
      return {
        payee_name: transaction.payee_name ?? null,
        import_payee_name: transaction.import_payee_name ?? null,
        import_payee_name_original: transaction.import_payee_name_original ?? null,
        memo: transaction.memo ?? null,
        amount: toDollars(transaction.amount),
        direction: "outflow",
        date: transaction.date,
        account: {
          name: account?.name ?? transaction.account_name,
          type: account?.type ?? "unknown",
          on_budget: account?.onBudget ?? null,
        },
      };
    }),
  };
}

function buildTypeSafeRequest(
  transactions: ynab.TransactionDetail[],
  accountsById: Map<string, AccountContext>,
  categories: EligibleCategory[],
) {
  const criteria: Record<string, string | null> = Object.fromEntries([
    ...categories.map((category) => [category.key, null]),
    ["leave_uncategorized", "No eligible category is a sufficiently supported fit"],
  ]);
  const questions = Object.fromEntries(transactions.map((_transaction, index) => [
    `t${String(index).padStart(2, "0")}`,
    {
      type: "choice",
      instructions: {
        question: `Which eligible budget category best fits state.transactions[${index}]?`,
        rules: [
          "Choose one category key represented in state.eligible_categories.",
          "Use the payee fields, memo, amount direction, account context, and date.",
          "Choose leave_uncategorized when the evidence is insufficient or no listed category fits.",
          "Do not invent a category.",
        ],
      },
      criteria,
    },
  ]));
  return { state: modelState(transactions, accountsById, categories), model: PINNED_MODEL, questions };
}

/** A conservative character-based guard; TypeSafe returns authoritative usage after the call. */
export function preflightTypeSafeRequest(body: ReturnType<typeof buildTypeSafeRequest>): Preflight {
  const estimatedInputTokens = Math.ceil(JSON.stringify(body).length / 3);
  const questionValues = Object.values(body.questions);
  const longestQuestion = questionValues.reduce((longest, question) =>
    JSON.stringify(question).length > JSON.stringify(longest).length ? question : longest,
  questionValues[0]);
  const estimatedStateAndLongestQuestionTokens = Math.ceil(
    (JSON.stringify(body.state).length + JSON.stringify(longestQuestion).length) / 3,
  );
  const projectedCostUsd = Number((estimatedInputTokens * PUBLISHED_INPUT_PRICE_PER_MILLION_USD / 1_000_000).toFixed(12));
  const reasons: string[] = [];
  if (estimatedInputTokens > MAX_ESTIMATED_REQUEST_TOKENS) reasons.push("estimated total input exceeds the 60,000-token preflight ceiling");
  if (estimatedStateAndLongestQuestionTokens > MAX_ESTIMATED_STATE_AND_QUESTION_TOKENS) reasons.push("estimated state plus longest question exceeds the 30,000-token preflight ceiling");
  if (projectedCostUsd > MAX_PROJECTED_COST_PER_CALL_USD) reasons.push("projected call cost exceeds the $0.01 preflight ceiling");
  return {
    estimatedInputTokens,
    estimatedStateAndLongestQuestionTokens,
    projectedCostUsd,
    allowed: reasons.length === 0,
    error: reasons.length > 0 ? `TypeSafe preflight refused the batch: ${reasons.join("; ")}` : undefined,
  };
}

function isChoiceAnswer(value: unknown, validKeys: Set<string>): value is ChoiceAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<ChoiceAnswer>;
  if (
    answer.type !== "choice" ||
    typeof answer.choice !== "string" ||
    !validKeys.has(answer.choice) ||
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1 ||
    !answer.probabilities ||
    typeof answer.probabilities !== "object"
  ) return false;
  const entries = Object.entries(answer.probabilities);
  if (entries.length !== validKeys.size) return false;
  return entries.every(([key, probability]) =>
    validKeys.has(key) && typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
  ) && [...validKeys].every((key) => typeof answer.probabilities?.[key] === "number");
}

async function callTypeSafe(body: ReturnType<typeof buildTypeSafeRequest>, apiKey: string): Promise<TypeSafeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TYPESAFE_TIMEOUT_MS);
  try {
    const response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`TypeSafe request failed with HTTP ${response.status}`);
    }
    const parsed = await response.json() as Partial<TypeSafeResponse>;
    if (
      typeof parsed.model !== "string" ||
      !parsed.answers ||
      typeof parsed.answers !== "object" ||
      !parsed.usage ||
      !Number.isFinite(parsed.usage.input_tokens) ||
      !Number.isFinite(parsed.usage.output_tokens)
    ) {
      throw new Error("TypeSafe returned a malformed response");
    }
    return parsed as TypeSafeResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function categoryOutput(category: EligibleCategory | null) {
  return category ? {
    id: category.id,
    group_name: category.groupName,
    name: category.name,
  } : null;
}

function failedRow(
  transactionId: string,
  error: string,
  transaction?: ynab.TransactionDetail,
  fingerprint?: string,
  history?: HistorySummary,
) {
  return {
    transaction_id: transactionId,
    ...(transaction ? { transaction: displayFields(transaction), content_fingerprint: fingerprint } : {}),
    status: "failed",
    source: null,
    proposed_category: null,
    model_confidence: null,
    winning_probability: null,
    top_alternatives: [],
    history: historyForOutput(history ?? emptyHistorySummary(), undefined),
    error,
  };
}

function usageCost(inputTokens: number): number {
  return Number((inputTokens * PUBLISHED_INPUT_PRICE_PER_MILLION_USD / 1_000_000).toFixed(12));
}

interface ToolResponseOptions {
  success: boolean;
  transactions?: any[];
  transactionOrder?: string[];
  error?: string;
  eligibleCategoryCount?: number;
  providerCalls?: number;
  responseModels?: Set<string>;
  estimatedInputTokens?: number;
  estimatedCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function toolResponse(options: ToolResponseOptions) {
  const transactions = [...(options.transactions ?? [])];
  if (options.transactionOrder) {
    const originalOrder = new Map<string, number>(
      options.transactionOrder.map((transactionId, index): [string, number] => [transactionId, index]),
    );
    transactions.sort((a, b) => (originalOrder.get(a.transaction_id) ?? Number.MAX_SAFE_INTEGER) - (originalOrder.get(b.transaction_id) ?? Number.MAX_SAFE_INTEGER));
  }
  const responseModels = options.responseModels ?? new Set<string>();
  const inputTokens = options.inputTokens ?? 0;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: options.success,
        dry_run: true,
        transactions,
        transaction_count: transactions.length,
        ...(options.error ? { error: options.error } : {}),
        ...(options.eligibleCategoryCount === undefined ? {} : { eligible_category_count: options.eligibleCategoryCount }),
        requested_model: PINNED_MODEL,
        model: responseModels.size === 1 ? [...responseModels][0] : responseModels.size > 1 ? [...responseModels] : PINNED_MODEL,
        provider_calls: options.providerCalls ?? 0,
        thresholds: {
          provisional: true,
          suggested_at_or_above: PROVISIONAL_SUGGEST_CONFIDENCE,
          needs_review_at_or_above: PROVISIONAL_REVIEW_CONFIDENCE,
        },
        usage: {
          estimated_input_tokens_before_calls: options.estimatedInputTokens ?? 0,
          estimated_cost_usd_before_calls: Number((options.estimatedCostUsd ?? 0).toFixed(12)),
          input_tokens: inputTokens,
          output_tokens: options.outputTokens ?? 0,
          projected_cost_usd: usageCost(inputTokens),
          published_input_price_per_million_usd: PUBLISHED_INPUT_PRICE_PER_MILLION_USD,
        },
      }, null, 2),
    }],
  };
}

export async function execute(input: SuggestCategoriesInput, api: ynab.API) {
  try {
    if (!isCategorySuggestionEnabled()) {
      return toolResponse({
        success: false,
        error: "Category suggestions are disabled. Set TYPESAFE_API_KEY and YNAB_AI_CATEGORIZATION=true to opt in.",
      });
    }
    const apiKey = process.env.TYPESAFE_API_KEY as string;
    const budgetId = getBudgetId(input.budgetId);
    const candidates = await loadCandidates(input, budgetId, api);

    const prerequisites = await Promise.allSettled([
      api.categories.getCategories(budgetId),
      api.payees.getPayees(budgetId),
      api.accounts.getAccounts(budgetId),
      api.transactions.getTransactions(budgetId, twelveMonthsAgo()),
    ]);
    const prerequisiteNames = ["categories", "payees", "accounts", "history"];
    const prerequisiteFailures = prerequisites.flatMap((result, index) =>
      result.status === "rejected" ? [`${prerequisiteNames[index]}: ${getErrorMessage(result.reason)}`] : []
    );
    const categoriesResponse = prerequisites[0].status === "fulfilled" ? prerequisites[0].value : null;
    const payeesResponse = prerequisites[1].status === "fulfilled" ? prerequisites[1].value : null;
    const accountsResponse = prerequisites[2].status === "fulfilled" ? prerequisites[2].value : null;
    const historyResponse = prerequisites[3].status === "fulfilled" ? prerequisites[3].value : null;
    const categories = categoriesResponse ? getEligibleCategories(categoriesResponse.data.category_groups) : [];
    const categoriesById = new Map(categories.map((category) => [category.id, category]));
    const payeesById = new Map((payeesResponse?.data.payees ?? []).map((payee) => [payee.id, payee]));
    const fingerprints = new Map<string, string>();
    const outputRows: any[] = candidates.failures.map((failure) =>
      failedRow(failure.transactionId, `YNAB transaction request failed: ${failure.error}`)
    );
    const remainingTransactions: ynab.TransactionDetail[] = [];

    for (const transaction of candidates.transactions) {
      const fingerprint = await contentFingerprint(transaction);
      fingerprints.set(transaction.id, fingerprint);
      const skip = skippedStatus(transaction, payeesById);
      if (!skip) {
        remainingTransactions.push(transaction);
        continue;
      }
      const history = categoriesResponse && payeesResponse && historyResponse
        ? buildHistorySummary(transaction, historyResponse.data.transactions, payeesById, categoriesById)
        : emptyHistorySummary();
      outputRows.push({
        transaction_id: transaction.id,
        transaction: displayFields(transaction),
        content_fingerprint: fingerprint,
        status: skip,
        source: null,
        proposed_category: null,
        model_confidence: null,
        winning_probability: null,
        top_alternatives: [],
        history: historyForOutput(history, undefined),
      });
    }

    if (prerequisiteFailures.length > 0) {
      const error = `YNAB prerequisite request failed (${prerequisiteFailures.join("; ")})`;
      outputRows.push(...remainingTransactions.map((transaction) =>
        failedRow(transaction.id, error, transaction, fingerprints.get(transaction.id))
      ));
      return toolResponse({
        success: true,
        transactions: outputRows,
        transactionOrder: input.transactionIds
          ? [...new Set(input.transactionIds)]
          : candidates.transactions.map((transaction) => transaction.id),
      });
    }

    const categoryRefusal = categories.length === 0
      ? "No visible writable categories are available in this budget."
      : categories.length + 1 > MAX_CHOICE_OPTIONS
        ? `TypeSafe Choice supports at most ${MAX_CHOICE_OPTIONS} options; this budget has ${categories.length} eligible categories plus leave_uncategorized. No categories were truncated.`
        : null;
    if (categoryRefusal) {
      outputRows.push(...remainingTransactions.map((transaction) =>
        failedRow(transaction.id, categoryRefusal, transaction, fingerprints.get(transaction.id))
      ));
      return toolResponse({
        success: true,
        transactions: outputRows,
        transactionOrder: input.transactionIds
          ? [...new Set(input.transactionIds)]
          : candidates.transactions.map((transaction) => transaction.id),
        eligibleCategoryCount: categories.length,
      });
    }

    const categoriesByKey = new Map(categories.map((category) => [category.key, category]));
    const accountsById = new Map((accountsResponse?.data.accounts ?? []).filter((account) => !account.deleted).map((account) => [account.id, {
      name: account.name,
      type: account.type,
      onBudget: account.on_budget,
    }]));
    const modelTransactions: ynab.TransactionDetail[] = [];
    const historyByTransactionId = new Map<string, HistorySummary>();

    for (const transaction of remainingTransactions) {
      const fingerprint = fingerprints.get(transaction.id) as string;
      if (!accountsById.has(transaction.account_id)) {
        outputRows.push(failedRow(
          transaction.id,
          "YNAB account context is unavailable for this transaction",
          transaction,
          fingerprint,
        ));
        continue;
      }

      const history = buildHistorySummary(
        transaction,
        historyResponse!.data.transactions,
        payeesById,
        categoriesById,
      );
      historyByTransactionId.set(transaction.id, history);
      if (history.unanimousCategoryId) {
        const category = categoriesById.get(history.unanimousCategoryId) as EligibleCategory;
        outputRows.push({
          transaction_id: transaction.id,
          transaction: displayFields(transaction),
          content_fingerprint: fingerprint,
          status: "suggested",
          source: "history_rule",
          proposed_category: categoryOutput(category),
          model_confidence: null,
          winning_probability: null,
          top_alternatives: [],
          history: historyForOutput(history, category.id),
        });
      } else {
        modelTransactions.push(transaction);
      }
    }

    let providerCalls = 0;
    let estimatedInputTokens = 0;
    let estimatedCostUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const responseModels = new Set<string>();
    const validKeys = new Set([...categories.map((category) => category.key), "leave_uncategorized"]);

    for (let start = 0; start < modelTransactions.length; start += DEFAULT_BATCH_SIZE) {
      const batch = modelTransactions.slice(start, start + DEFAULT_BATCH_SIZE);
      const body = buildTypeSafeRequest(batch, accountsById, categories);
      const preflight = preflightTypeSafeRequest(body);
      estimatedInputTokens += preflight.estimatedInputTokens;
      estimatedCostUsd += preflight.projectedCostUsd;
      if (!preflight.allowed) {
        for (const transaction of batch) {
          outputRows.push(failedRow(
            transaction.id,
            preflight.error as string,
            transaction,
            fingerprints.get(transaction.id),
            historyByTransactionId.get(transaction.id),
          ));
        }
        continue;
      }

      let response: TypeSafeResponse;
      try {
        providerCalls += 1;
        response = await callTypeSafe(body, apiKey);
      } catch (error) {
        const message = getErrorMessage(error);
        for (const transaction of batch) {
          outputRows.push(failedRow(
            transaction.id,
            message,
            transaction,
            fingerprints.get(transaction.id),
            historyByTransactionId.get(transaction.id),
          ));
        }
        continue;
      }
      responseModels.add(response.model);
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      batch.forEach((transaction, index) => {
        const answer = response.answers[`t${String(index).padStart(2, "0")}`];
        if (!isChoiceAnswer(answer, validKeys)) {
          outputRows.push(failedRow(
            transaction.id,
            "TypeSafe returned a missing or malformed Choice answer",
            transaction,
            fingerprints.get(transaction.id),
            historyByTransactionId.get(transaction.id),
          ));
          return;
        }
        const history = historyByTransactionId.get(transaction.id) as HistorySummary;
        const selectedCategory = answer.choice === "leave_uncategorized"
          ? null
          : categoriesByKey.get(answer.choice) ?? null;
        if (answer.choice !== "leave_uncategorized" && !selectedCategory) {
          outputRows.push(failedRow(
            transaction.id,
            "TypeSafe returned an unknown category key",
            transaction,
            fingerprints.get(transaction.id),
            historyByTransactionId.get(transaction.id),
          ));
          return;
        }
        const conflict = Boolean(
          history.dominantCategoryId && history.dominantCategoryId !== selectedCategory?.id
        );
        let status: string;
        if (conflict) status = "needs_review";
        else if (answer.choice === "leave_uncategorized") status = "left_uncategorized";
        else if (answer.confidence >= PROVISIONAL_SUGGEST_CONFIDENCE) status = "suggested";
        else if (answer.confidence >= PROVISIONAL_REVIEW_CONFIDENCE) status = "needs_review";
        else status = "uncertain";

        const alternatives = Object.entries(answer.probabilities)
          .filter(([key]) => key !== "leave_uncategorized" && key !== answer.choice && categoriesByKey.has(key))
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([key, probability]) => ({
            category: categoryOutput(categoriesByKey.get(key) as EligibleCategory),
            probability,
          }));
        outputRows.push({
          transaction_id: transaction.id,
          transaction: displayFields(transaction),
          content_fingerprint: fingerprints.get(transaction.id),
          status,
          source: "jev",
          proposed_category: categoryOutput(selectedCategory),
          model_confidence: answer.confidence,
          winning_probability: answer.probabilities[answer.choice],
          top_alternatives: alternatives,
          history: historyForOutput(history, selectedCategory?.id ?? null),
        });
      });
    }

    return toolResponse({
      success: true,
      transactions: outputRows,
      transactionOrder: input.transactionIds
        ? [...new Set(input.transactionIds)]
        : candidates.transactions.map((transaction) => transaction.id),
      eligibleCategoryCount: categories.length,
      providerCalls,
      responseModels,
      estimatedInputTokens,
      estimatedCostUsd,
      inputTokens,
      outputTokens,
    });
  } catch (error) {
    return toolResponse({ success: false, error: getErrorMessage(error) });
  }
}
