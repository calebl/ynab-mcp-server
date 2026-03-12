import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as ynab from "ynab";

import { readYnabConfig } from "./config.js";
import { getPackageInfo } from "./packageInfo.js";
import { createYnabApi as createSdkYnabApi } from "./ynabApi.js";
import * as GetAccountTool from "./tools/GetAccountTool.js";
import * as GetCategoryTool from "./tools/GetCategoryTool.js";
import * as GetMcpVersionTool from "./tools/GetMcpVersionTool.js";
import * as GetMoneyMovementGroupsTool from "./tools/GetMoneyMovementGroupsTool.js";
import * as GetMoneyMovementGroupsByMonthTool from "./tools/GetMoneyMovementGroupsByMonthTool.js";
import * as GetMoneyMovementsTool from "./tools/GetMoneyMovementsTool.js";
import * as GetMoneyMovementsByMonthTool from "./tools/GetMoneyMovementsByMonthTool.js";
import * as GetMonthCategoryTool from "./tools/GetMonthCategoryTool.js";
import * as GetPayeeLocationTool from "./tools/GetPayeeLocationTool.js";
import * as GetPayeeLocationsByPayeeTool from "./tools/GetPayeeLocationsByPayeeTool.js";
import * as GetPayeeTool from "./tools/GetPayeeTool.js";
import * as GetScheduledTransactionTool from "./tools/GetScheduledTransactionTool.js";
import * as GetPlanDetailsTool from "./tools/GetPlanDetailsTool.js";
import * as GetPlanMonthTool from "./tools/GetPlanMonthTool.js";
import * as GetPlanSettingsTool from "./tools/GetPlanSettingsTool.js";
import * as GetTransactionTool from "./tools/GetTransactionTool.js";
import * as GetTransactionsByAccountTool from "./tools/GetTransactionsByAccountTool.js";
import * as GetTransactionsByCategoryTool from "./tools/GetTransactionsByCategoryTool.js";
import * as GetTransactionsByMonthTool from "./tools/GetTransactionsByMonthTool.js";
import * as GetTransactionsByPayeeTool from "./tools/GetTransactionsByPayeeTool.js";
import * as GetUserTool from "./tools/GetUserTool.js";
import * as ListAccountsTool from "./tools/ListAccountsTool.js";
import * as ListPayeeLocationsTool from "./tools/ListPayeeLocationsTool.js";
import * as ListPlanMonthsTool from "./tools/ListPlanMonthsTool.js";
import * as ListPayeesTool from "./tools/ListPayeesTool.js";
import * as ListPlanCategoriesTool from "./tools/ListPlanCategoriesTool.js";
import * as ListPlansTool from "./tools/ListPlansTool.js";
import * as ListScheduledTransactionsTool from "./tools/ListScheduledTransactionsTool.js";
import * as ListTransactionsTool from "./tools/ListTransactionsTool.js";

const packageInfo = getPackageInfo();

export const SERVER_INFO = {
  name: packageInfo.name,
  version: packageInfo.version,
} as const;

type ToolModule = {
  name: string;
  description: string;
  inputSchema: any;
  execute: (input: any, api: ynab.API) => Promise<unknown>;
};

type ToolRegistration = {
  title: string;
  module: ToolModule;
};

type ToolConfig = {
  description: string;
  inputSchema: any;
  title: string;
};

type ToolHandler = (input: any) => Promise<any>;

type ToolRegistrar = {
  registerTool: (
    name: string,
    config: ToolConfig,
    handler: ToolHandler,
  ) => void;
};

export const toolRegistrations: ToolRegistration[] = [
  { title: "Get MCP Version", module: GetMcpVersionTool },
  { title: "Get User", module: GetUserTool },
  { title: "List Plans", module: ListPlansTool },
  { title: "Get Plan", module: GetPlanDetailsTool },
  { title: "Get Plan Settings", module: GetPlanSettingsTool },
  { title: "Get Plan Month", module: GetPlanMonthTool },
  { title: "List Plan Months", module: ListPlanMonthsTool },
  { title: "List Categories", module: ListPlanCategoriesTool },
  { title: "Get Category", module: GetCategoryTool },
  { title: "Get Month Category", module: GetMonthCategoryTool },
  { title: "List Transactions", module: ListTransactionsTool },
  { title: "Get Transactions By Month", module: GetTransactionsByMonthTool },
  { title: "Get Transaction", module: GetTransactionTool },
  { title: "Get Transactions By Account", module: GetTransactionsByAccountTool },
  { title: "Get Transactions By Category", module: GetTransactionsByCategoryTool },
  { title: "Get Transactions By Payee", module: GetTransactionsByPayeeTool },
  { title: "List Scheduled Transactions", module: ListScheduledTransactionsTool },
  { title: "Get Scheduled Transaction", module: GetScheduledTransactionTool },
  { title: "List Accounts", module: ListAccountsTool },
  { title: "Get Account", module: GetAccountTool },
  { title: "List Payees", module: ListPayeesTool },
  { title: "Get Payee", module: GetPayeeTool },
  { title: "List Payee Locations", module: ListPayeeLocationsTool },
  { title: "Get Payee Location", module: GetPayeeLocationTool },
  { title: "Get Payee Locations By Payee", module: GetPayeeLocationsByPayeeTool },
  { title: "Get Money Movements", module: GetMoneyMovementsTool },
  { title: "Get Money Movements By Month", module: GetMoneyMovementsByMonthTool },
  { title: "Get Money Movement Groups", module: GetMoneyMovementGroupsTool },
  { title: "Get Money Movement Groups By Month", module: GetMoneyMovementGroupsByMonthTool },
];

export function createYnabApi(token = readYnabConfig(process.env).apiToken) {
  return createSdkYnabApi(token);
}

export function registerServerTools(registrar: ToolRegistrar, api: ynab.API) {
  const registeredToolNames: string[] = [];

  for (const { title, module } of toolRegistrations) {
    registrar.registerTool(
      module.name,
      {
        title,
        description: module.description,
        inputSchema: module.inputSchema,
      },
      async (input: any) => module.execute(input, api) as any,
    );
    registeredToolNames.push(module.name);
  }

  return registeredToolNames;
}

export function createServer(api = createYnabApi()) {
  const server = new McpServer(SERVER_INFO);

  registerServerTools(server, api);

  return server;
}
