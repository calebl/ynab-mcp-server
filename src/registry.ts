import * as ynab from "ynab";
import { z } from "zod";

// Import all tools
import * as ListPlansTool from "./tools/ListPlansTool.js";
import * as GetUnapprovedTransactionsTool from "./tools/GetUnapprovedTransactionsTool.js";
import * as PlanSummaryTool from "./tools/PlanSummaryTool.js";
import * as CreateTransactionTool from "./tools/CreateTransactionTool.js";
import * as ApproveTransactionTool from "./tools/ApproveTransactionTool.js";
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
import * as SuggestCategoriesTool from "./tools/SuggestCategoriesTool.js";
import { getErrorMessage, toolError } from "./tools/errorUtils.js";

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

const listBudgetsAlias = { ...ListPlansTool, name: "ynab_list_budgets", description: "Former name of ynab_list_plans." };
const budgetSummaryAlias = { ...PlanSummaryTool, name: "ynab_budget_summary", description: "Former name of ynab_plan_summary." };

export const tools: ToolEntry[] = [
  { title: "List Plans", module: ListPlansTool, writes: false },
  { title: "List Budgets (legacy)", module: listBudgetsAlias, writes: false },
  { title: "Get Unapproved Transactions", module: GetUnapprovedTransactionsTool, writes: false },
  { title: "Plan Summary", module: PlanSummaryTool, writes: false },
  { title: "Budget Summary (legacy)", module: budgetSummaryAlias, writes: false },
  { title: "Create Transaction", module: CreateTransactionTool, writes: true, refine: refineCreateTransaction },
  { title: "Approve Transaction", module: ApproveTransactionTool, writes: true, idempotent: true },
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
  { title: "Suggest Categories", module: SuggestCategoriesTool, writes: false, requiresAiCategorization: true },
];

/**
 * The minimal surface `registerAll` needs. Both the v1 SDK `McpServer` (stdio
 * entry) and the v2 `@modelcontextprotocol/server` `McpServer` (Worker entry)
 * satisfy this, so the two entries share one tool list.
 */
export interface ToolRegistrar {
  registerTool(name: string, config: Record<string, unknown>, cb: (input: any) => Promise<any>): unknown;
}

export interface RegisterOptions {
  /** Register only the read-only tools. */
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
    readOnlyHint: !tool.writes,
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

/** Runs a tool's execute, guaranteeing a failure - thrown or `{success: false}` - comes back as `isError: true`. */
async function executeTool(module: ToolModule, input: unknown, api: ynab.API) {
  try {
    const result = await module.execute(input, api);
    return isFailureResult(result) ? { ...result, isError: true } : result;
  } catch (error) {
    return toolError(getErrorMessage(error));
  }
}

/** Register every tool (or only the read-only ones) against a server instance. */
export function registerAll(server: ToolRegistrar, api: ynab.API, options: RegisterOptions = {}) {
  const selected = tools.filter((tool) =>
    (!options.readOnly || !tool.writes) &&
    (!tool.requiresAiCategorization || SuggestCategoriesTool.isCategorySuggestionEnabled())
  );

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
