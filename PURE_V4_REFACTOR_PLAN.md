# Pure V4 Refactor Plan

Scope: remove backward-compatibility code and refactor the codebase to use the YNAB SDK v4 surface directly, with `plan` terminology throughout.

Assumption: remaining budget-era tool names, inputs, env vars, and internal helpers should be migrated to `plan` semantics rather than preserved.

## Tasks

1. Lock the new SDK contract and remove the compatibility target
- Add or update SDK contract specs so they assert only the native v4 surface.
- Remove expectations that `budgets`, `getBudgetMonth`, and `getBudgetMonths` exist anywhere in the code.
- Verify with the SDK contract spec.

2. Replace the compatibility wrapper with a pure v4 client module
- Refactor the shared client factory to expose only v4-native APIs.
- Remove all aliasing for budget-era methods and properties.
- Verify with a focused shared-client spec and a build.

3. Refactor server registration to expose only v4-native tools
- Keep the server registration aligned with the final read-only plan-based tool list.
- Ensure the server uses the pure v4 client factory.
- Verify with the server registration and HTTP tests.

4. Refactor plan listing, details, settings, and month tools to pure v4
- Keep `ListPlans`, `GetPlanDetails`, `GetPlanSettings`, and `GetPlanMonth` on native `plans` and `months` methods only.
- Remove any budget-era input names or fallback behavior.
- Verify with the plan-read specs.

5. Refactor category tools to pure v4
- Keep category list and drill-down tools on native v4 category methods.
- Rename any remaining `budgetId` inputs to `planId`.
- Verify with category-focused specs.

6. Refactor account and payee drill-down tools to pure v4
- Keep account and payee lookup tools on native v4 methods.
- Remove legacy naming and fallbacks.
- Verify with drill-down specs.

7. Refactor transaction tools to pure v4
- Move remaining transaction code to native v4 method names and types.
- Remove old budget-era transaction assumptions.
- Verify with transaction-focused specs and a build.

8. Refactor money movement tools to pure v4
- Use the native v4 money movement client shape only.
- Remove shim-based access patterns.
- Verify with money-movement specs.

9. Refactor legacy source files that still depend on old SDK naming
- Rename `budgetId` to `planId`, `ListBudgets` to `ListPlans`, and other budget-era concepts throughout `src/`.
- Update existing specs where needed to reflect the new API contract.
- Verify with targeted specs after each cluster of changes.

10. Remove deprecated files and dead code
- Delete compatibility code and any unused budget-era modules that are no longer part of the final surface.
- Keep the full suite green while pruning dead paths.
- Verify with `npm test` and `npm run build`.

11. Final consistency pass
- Update docs, comments, and env-var usage to `plan` terminology.
- Search for leftover old SDK references and remove them.
- Verify with repo-wide search plus final test/build runs.

## Expected Breaking Changes

- MCP tools and input fields may move from `budget` naming to `plan` naming.
- Legacy default-plan env naming may be removed in favor of `YNAB_PLAN_ID`.
- Any clients or prompts using the old budget-era surface will need updating.
