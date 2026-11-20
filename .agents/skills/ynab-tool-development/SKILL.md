---
name: ynab-tool-development
description: Use when adding or changing a YNAB MCP tool, YNAB API/SDK integration, transaction-listing call, or SDK version.
---

## Adding New Tools

### Before adding a tool
Check whether the behavior fits as an option on an existing tool (a new filter, date bound, or output mode) before creating a new one. Add a new tool only when no existing tool covers the same data and intent, and say in the PR which existing tools were considered and why they didn't fit. Overlapping tools make the model more likely to pick the wrong one.

1. Create `src/tools/MyTool.ts`:
```typescript
import { z } from "zod";
import * as ynab from "ynab";
import { resolvePlanId } from "./planId.js";

export const name = "my_tool";
export const description = "What this tool does";
export const inputSchema = {
  planId: z.string().optional().describe("The plan ID (optional, defaults to YNAB_PLAN_ID; budgetId is a deprecated alias)"),
  budgetId: z.string().optional().describe("Deprecated alias of planId (still accepted)"),
  requiredParam: z.string().describe("Description of required param"),
};

interface MyToolInput {
  planId?: string;
  budgetId?: string;
  requiredParam: string;
}

export async function execute(input: MyToolInput, api: ynab.API) {
  try {
    const planId = resolvePlanId(input);
    const result = await api.someMethod(planId, input.requiredParam);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }]
    };
  }
}
```

2. Register in `src/registry.ts` — import the module and add it to the `tools`
   array. Both entry points build from this one list, so registering here serves
   the tool from the stdio server and the Cloudflare Worker alike.

```typescript
import * as MyTool from "./tools/MyTool.js";

export const tools: ToolEntry[] = [
  // ...
  { title: "My Tool", module: MyTool, writes: false },
];
```

   Set `writes: true` for any tool that changes data in YNAB. `YNAB_READ_ONLY`
   filters on that flag, so a mislabelled tool would be exposed in a deployment
   meant to be read-only.

3. Add test in `src/tests/MyTool.test.ts`

## YNAB API Reference
- YNAB SDK types: `node_modules/ynab/dist/index.d.ts`
- OpenAPI spec: https://api.ynab.com/papi/open_api_spec.yaml
- The API works in milliunits; tools expose plain currency amounts instead. Convert with `toDollars`/`toMilliunits` from `src/tools/money.ts` rather than open-coding `* 1000`.

## YNAB API and SDK behavior

See https://api.ynab.com/ for the API reference and https://github.com/ynab/ynab-sdk-js for the SDK source and 4.x release notes.

- Transaction listing endpoints filter server-side only by a since date, an until date, and a single `type` of either `uncategorized` or `unapproved` (see `GetTransactionsTypeEnum` in `node_modules/ynab/dist/apis/TransactionsApi.d.ts`). Approval state, cleared state, and payee are never filterable server-side; filter those in code.
- YNAB's built-in payees "Starting Balance", "Manual Balance Adjustment", and "Reconciliation Balance Adjustment" carry no distinguishing field on the `Payee` model — match on exact name.
- SDK 4.x renamed budget to plan internally (`planId` parameters, `PlansApi`, response fields `data.plan`, `data.plans`, `default_plan`). This server uses `planId` as the canonical tool input; `src/tools/planId.ts` owns compatibility and precedence for the legacy aliases.
- SDK 4.x inserted `untilDate` before `type` in every transaction-listing method signature, so a positional call that only wants a `type` filter must pass an explicit `undefined` for `untilDate`.
- `internal: true` on a category group does not mean a system group: YNAB also sets it on the starter groups a new plan comes with (Bills, Needs, Wants), which take categories like any other group. Identify system groups by name (`Internal Master Category`, `Hidden Categories`, plus `Credit Card Payments`). On categories, `internal` is reliable (Inflow: Ready to Assign, Uncategorized).
- The SDK can `createCategoryGroup`, `createCategory` and `updateCategory` (name, note, group, `goal_target`, `goal_target_date`), but has no `hidden` field and no delete, so anything a tool creates must be removed by hand in the app. Setting `goal_target` creates a NEED goal.
- `updateCategory` with an empty `category` object fails with "param is missing or the value is empty or invalid: category"; skip the request when there is nothing to change. Its patch type (`ExistingCategory`) types `note` as `string`, so clear a note with `""`, not `null`.
- Mocked SDK tests can't catch these. Before shipping a new write tool, run it once against a real plan in a throwaway group.
