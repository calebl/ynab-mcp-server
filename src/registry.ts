import * as ynab from "ynab";
import { z } from "zod";

// Import all tools
import * as ListPlansTool from "./tools/ListPlansTool.js";
import * as PlanSummaryTool from "./tools/PlanSummaryTool.js";
import * as CreateTransactionTool from "./tools/CreateTransactionTool.js";
import * as UpdateCategoryBudgetTool from "./tools/UpdateCategoryBudgetTool.js";
import * as UpdateTransactionTool from "./tools/UpdateTransactionTool.js";
import * as BulkApproveTransactionsTool from "./tools/BulkApproveTransactionsTool.js";
import * as ListPayeesTool from "./tools/ListPayeesTool.js";
import * as GetTransactionsTool from "./tools/GetTransactionsTool.js";
import * as DeleteTransactionTool from "./tools/DeleteTransactionTool.js";
import * as ListCategoriesTool from "./tools/ListCategoriesTool.js";
import * as ListAccountsTool from "./tools/ListAccountsTool.js";
import * as ListScheduledTransactionsTool from "./tools/ListScheduledTransactionsTool.js";
import * as ImportTransactionsTool from "./tools/ImportTransactionsTool.js";
import * as ListMonthsTool from "./tools/ListMonthsTool.js";
import * as MoveMoneyTool from "./tools/MoveMoneyTool.js";
import * as AutoAssignTool from "./tools/AutoAssignTool.js";
import * as SpendingByCategoryTool from "./tools/SpendingByCategoryTool.js";
import * as SpendingByPayeeTool from "./tools/SpendingByPayeeTool.js";
import * as CashFlowTool from "./tools/CashFlowTool.js";
import * as DetectRecurringTool from "./tools/DetectRecurringTool.js";
import * as SuggestCategoriesTool from "./tools/SuggestCategoriesTool.js";
import * as ApplyCategorySuggestionsTool from "./tools/ApplyCategorySuggestionsTool.js";
import { getErrorMessage, toolError } from "./tools/errorUtils.js";
import { configuredPlanId, describeMissingPlan } from "./tools/planId.js";

/** A tool module as exported by every file in src/tools. */
interface ToolModule {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: any, api: ynab.API) => Promise<any>;
}

export interface ToolEntry {
  title: string;
  module: ToolModule;
  /** True when the tool changes data in YNAB rather than only reading it. */
  writes: boolean;
  /**
   * True when the tool changes this server's own state but never YNAB data.
   * It is not advertised as read-only, yet stays available in read-only mode.
   */
  changesServerState?: boolean;
  /** True when the tool's effect cannot be undone. Defaults to false. */
  destructive?: boolean;
  /** True when repeating the call with the same arguments has no further effect. Defaults to false. */
  idempotent?: boolean;
  /** Tool is omitted unless the operator explicitly enables AI categorization. */
  requiresAiCategorization?: boolean;
  /** Cross-field validation applied to the wrapped input schema at registration. */
  refine?: (schema: z.ZodObject<z.ZodRawShape>) => z.ZodTypeAny;
}

const refineCreateTransaction = (schema: z.ZodObject<z.ZodRawShape>) =>
  schema
    .refine((data) => Boolean((data as { accountId?: unknown }).accountId || (data as { accountName?: unknown }).accountName), {
      message: "Either accountId or accountName must be provided",
      path: ["accountId"],
    })
    .refine((data) => Boolean((data as { payeeId?: unknown }).payeeId || (data as { payeeName?: unknown }).payeeName), {
      message: "Either payeeId or payeeName must be provided",
      path: ["payeeId"],
    });

const deprecatedAliasOf = (target: string) => `Deprecated alias of ${target}; use that instead`;

const listBudgetsAlias = { ...ListPlansTool, name: "ynab_list_budgets", description: deprecatedAliasOf(ListPlansTool.name) };
const budgetSummaryAlias = { ...PlanSummaryTool, name: "ynab_budget_summary", description: deprecatedAliasOf(PlanSummaryTool.name) };

// Former single-purpose tools whose inputs are mapped onto the tool that replaced them.
const getUnapprovedTransactionsAlias: ToolModule = {
  name: "ynab_get_unapproved_transactions",
  description: deprecatedAliasOf(GetTransactionsTool.name),
  inputSchema: {
    planId: GetTransactionsTool.inputSchema.planId,
    budgetId: GetTransactionsTool.inputSchema.budgetId,
    sinceDate: GetTransactionsTool.inputSchema.sinceDate,
  },
  // The former tool returned every unapproved transaction, so the alias lifts the row limit.
  execute: (input: { planId?: string; budgetId?: string; sinceDate?: string }, api) =>
    GetTransactionsTool.execute({ ...input, type: "unapproved", limit: Number.POSITIVE_INFINITY }, api),
};
const approveTransactionAlias: ToolModule = {
  name: "ynab_approve_transaction",
  description: deprecatedAliasOf(BulkApproveTransactionsTool.name),
  inputSchema: {
    planId: BulkApproveTransactionsTool.inputSchema.planId,
    budgetId: BulkApproveTransactionsTool.inputSchema.budgetId,
    transactionId: z.string().describe("The id of the transaction to approve"),
    approved: BulkApproveTransactionsTool.inputSchema.approved,
  },
  execute: ({ transactionId, ...input }: { planId?: string; budgetId?: string; transactionId: string; approved?: boolean }, api) =>
    BulkApproveTransactionsTool.execute({ ...input, transactionIds: [transactionId] }, api),
};

export const tools: ToolEntry[] = [
  { title: "List Plans", module: ListPlansTool, writes: false },
  { title: "List Budgets (legacy)", module: listBudgetsAlias, writes: false },
  { title: "Get Unapproved Transactions (legacy)", module: getUnapprovedTransactionsAlias, writes: false },
  { title: "Plan Summary", module: PlanSummaryTool, writes: false },
  { title: "Budget Summary (legacy)", module: budgetSummaryAlias, writes: false },
  { title: "Create Transaction", module: CreateTransactionTool, writes: true, refine: refineCreateTransaction },
  { title: "Approve Transaction (legacy)", module: approveTransactionAlias, writes: true, idempotent: true },
  { title: "Update Category Budget", module: UpdateCategoryBudgetTool, writes: true, idempotent: true },
  { title: "Update Transaction", module: UpdateTransactionTool, writes: true, idempotent: true },
  { title: "Bulk Approve Transactions", module: BulkApproveTransactionsTool, writes: true, idempotent: true },
  { title: "List Payees", module: ListPayeesTool, writes: false },
  { title: "Get Transactions", module: GetTransactionsTool, writes: false },
  { title: "Delete Transaction", module: DeleteTransactionTool, writes: true, destructive: true },
  { title: "List Categories", module: ListCategoriesTool, writes: false },
  { title: "List Accounts", module: ListAccountsTool, writes: false },
  { title: "List Scheduled Transactions", module: ListScheduledTransactionsTool, writes: false },
  { title: "Import Transactions", module: ImportTransactionsTool, writes: true },
  { title: "List Months", module: ListMonthsTool, writes: false },
  { title: "Move Money", module: MoveMoneyTool, writes: true },
  { title: "Auto Assign", module: AutoAssignTool, writes: true },
  { title: "Spending By Category", module: SpendingByCategoryTool, writes: false },
  { title: "Spending By Payee", module: SpendingByPayeeTool, writes: false },
  { title: "Cash Flow", module: CashFlowTool, writes: false },
  { title: "Detect Recurring", module: DetectRecurringTool, writes: false },
  { title: "Suggest Categories", module: SuggestCategoriesTool, writes: false, requiresAiCategorization: true },
  { title: "Apply Category Suggestions", module: ApplyCategorySuggestionsTool, writes: true, idempotent: true },
];

/**
 * The minimal surface `registerAll` needs. Both the v1 SDK `McpServer` (stdio
 * entry) and the v2 `@modelcontextprotocol/server` `McpServer` (Worker entry)
 * satisfy this, so the two entries share one tool list.
 */
export interface ToolRegistrar {
  registerTool(name: string, config: Record<string, unknown>, cb: (input: any) => Promise<any>): unknown;
}

/** True when a `YNAB_READ_ONLY` value asks for read-only mode: "true" in any case, surrounding whitespace ignored. */
export function isReadOnly(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export interface RegisterOptions {
  /** Omit tools that write to YNAB. */
  readOnly?: boolean;
}

interface InputSchema {
  safeParse(value: unknown): { success: boolean };
  nullable(): InputSchema;
  describe(description: string): InputSchema;
  description?: string;
}

function acceptsUndefined(schema: unknown): schema is InputSchema {
  return typeof schema === "object" && schema !== null &&
    "safeParse" in schema && typeof schema.safeParse === "function" &&
    "nullable" in schema && typeof schema.nullable === "function" &&
    schema.safeParse(undefined).success;
}

/**
 * `.nullable()` wraps the schema in an `anyOf`, which moves a `.describe()`d
 * property's description into the first `anyOf` branch instead of the
 * property itself - re-attach it so clients and model schema renderers still
 * see it.
 */
function nullCompatible(schema: InputSchema): InputSchema {
  const nullable = schema.nullable();
  return schema.description ? nullable.describe(schema.description) : nullable;
}

function nullCompatibleInputSchema(inputSchema: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(inputSchema).map(([key, schema]) => [
    key,
    acceptsUndefined(schema) ? nullCompatible(schema) : schema,
  ]));
}

/** Derives the MCP ToolAnnotations advertised for a tool from its registry entry. */
function buildAnnotations(tool: ToolEntry) {
  return {
    title: tool.title,
    readOnlyHint: !tool.writes && !tool.changesServerState,
    destructiveHint: Boolean(tool.destructive),
    idempotentHint: Boolean(tool.idempotent),
    openWorldHint: true,
  };
}

function omitNullOptionalInputs(input: Record<string, unknown>, inputSchema: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    value !== null || !acceptsUndefined(inputSchema[key])
  ));
}

/** A tool result that reports failure through the `{success: false}` text convention every tool follows. */
function isFailureResult(result: unknown): boolean {
  if ((result as { isError?: unknown } | undefined)?.isError === true) return true;
  const text = (result as { content?: Array<{ text?: unknown }> } | undefined)?.content?.[0]?.text;
  if (typeof text !== "string") return false;
  try {
    return JSON.parse(text)?.success === false;
  } catch {
    return false;
  }
}

function attachPlanExplanation(result: any, explanation: string) {
  const content = [...(result.content ?? [])];
  try {
    const detail = JSON.parse(content[0].text);
    content[0] = { ...content[0], text: JSON.stringify({ ...detail, plan_visibility_error: explanation }, null, 2) };
  } catch {
    content.push({ type: "text" as const, text: explanation });
  }
  return { ...result, content, isError: true };
}

/** In-flight plan-visibility checks, shared by concurrent failures. */
const planChecks = new WeakMap<ynab.API, Map<string, Promise<string | null>>>();

/**
 * When a call that fell back to the configured plan fails, checks whether the
 * token can see that plan at all and, if not, says so instead of the bare
 * "Resource not found". Returns null when the plan is fine or the check fails.
 */
async function explainDefaultPlanFailure(module: ToolModule, input: unknown, api: ynab.API): Promise<string | null> {
  const given = input as { planId?: unknown; budgetId?: unknown } | undefined;
  const planId = configuredPlanId();
  if (!("planId" in module.inputSchema) || given?.planId || given?.budgetId || !planId) return null;

  const checks = planChecks.get(api) ?? new Map<string, Promise<string | null>>();
  planChecks.set(api, checks);
  let check = checks.get(planId);
  if (!check) {
    check = (async () => describeMissingPlan(planId, (await api.plans.getPlans()).data.plans))();
    checks.set(planId, check);
  }
  try {
    return await check;
  } catch {
    return null;
  } finally {
    if (checks.get(planId) === check) checks.delete(planId);
  }
}

/** Runs a tool's execute, guaranteeing a failure - thrown or `{success: false}` - comes back as `isError: true`. */
async function executeTool(module: ToolModule, input: unknown, api: ynab.API) {
  try {
    const result = await module.execute(input, api);
    if (!isFailureResult(result)) return result;
    const explanation = await explainDefaultPlanFailure(module, input, api);
    return explanation ? attachPlanExplanation(result, explanation) : { ...result, isError: true };
  } catch (error) {
    return toolError((await explainDefaultPlanFailure(module, input, api)) ?? getErrorMessage(error));
  }
}

/** Register every tool, optionally omitting YNAB write tools, against a server instance. */
export function registerAll(server: ToolRegistrar, api: ynab.API, options: RegisterOptions = {}) {
  const selected = tools.filter((tool) =>
    !tool.requiresAiCategorization || SuggestCategoriesTool.isCategorySuggestionEnabled()
  );
  return registerTools(server, api, selected, options);
}

/**
 * Register the given entries, dropping YNAB write tools in read-only mode.
 * The Worker also uses this for the tools only it can serve.
 */
export function registerTools(server: ToolRegistrar, api: ynab.API, entries: ToolEntry[], options: RegisterOptions = {}) {
  const selected = entries.filter((tool) => !options.readOnly || !tool.writes);

  for (const tool of selected) {
    const { title, module } = tool;
    const wrapped = z.object(nullCompatibleInputSchema(module.inputSchema) as z.ZodRawShape);
    const inputSchema = tool.refine ? tool.refine(wrapped) : wrapped;

    server.registerTool(module.name, {
      title,
      description: module.description,
      inputSchema,
      annotations: buildAnnotations(tool),
    }, async (input: any) => executeTool(module, omitNullOptionalInputs(input, module.inputSchema), api));
  }

  return selected.length;
}
