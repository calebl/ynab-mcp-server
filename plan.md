# YNAB MCP Server Improvement Plan

## Overview
Comprehensive improvements to bring the YNAB MCP Server into full compliance with MCP best practices and improve code quality.

## Issues Identified

### 🔴 HIGH PRIORITY

#### 1. Tool Naming Convention Violation
**Issue**: Tools don't follow MCP naming conventions
- **Current**: `list_budgets`, `create_transaction`, `analyze_spending_patterns`
- **Required**: `ynab_list_budgets`, `ynab_create_transaction`, `ynab_analyze_spending_patterns`
- **Why**: MCP best practices require service prefix to prevent conflicts when multiple MCP servers are used together
- **Impact**: Users with multiple MCP servers will have tool name conflicts
- **Affected**: All 17 tools

#### 2. Missing Tool Annotations
**Issue**: None of the 17 tools include MCP tool annotations
- **Missing**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
- **Why**: Annotations help clients understand tool behavior and present appropriate UIs
- **Affected**: All 17 tools

#### 3. Type Safety Issues in index.ts
**Issue**: 17 uses of `as any` casting lose all type safety
- **Risk**: Runtime errors possible despite TypeScript compilation
- **Fix**: Create proper type unions or type guards per tool

#### 4. Incomplete Test Coverage
**Issue**: Only 5/17 tools have tests (29% coverage)
- **Missing tests for critical data-modifying tools**:
  - HandleOverspendingTool
  - AutoDistributeFundsTool
  - MoveFundsBetweenCategoriesTool
  - SetCategoryGoalsTool
  - ReconcileAccountTool
  - BudgetFromHistoryTool
  - NetWorthAnalysisTool
  - AnalyzeSpendingPatternsTool
  - GoalProgressReportTool
  - CashFlowForecastTool
  - CategoryPerformanceReviewTool
  - BulkApproveTransactionsTool

### 🟡 MEDIUM PRIORITY

#### 5. Missing Response Format Options
**Issue**: Tools only return Markdown format
- **Required**: Support both `json` and `markdown` response formats per MCP best practices
- **Affected**: All 17 tools

#### 6. Pagination Not Implemented
**Issue**: Tools that return lists don't support pagination
- **Missing**: `limit`, `offset`, `has_more`, `next_offset` parameters
- **Tools affected**:
  - GetUnapprovedTransactionsTool
  - BulkApproveTransactionsTool
  - AnalyzeSpendingPatternsTool
  - GoalProgressReportTool
  - CashFlowForecastTool
  - CategoryPerformanceReviewTool

#### 7. Character Limits Not Enforced
**Issue**: No CHARACTER_LIMIT constant or truncation logic
- **Required**: 25,000 character limit per MCP best practices
- **Risk**: Overwhelming responses with too much data
- **Affected**: All tools

#### 8. Unused Error Handler Utility
**Issue**: `apiErrorHandler.ts` exists but is never used
- Contains sophisticated error handling logic
- Tools use inconsistent inline error handling instead
- **Fix**: Integrate `analyzeAPIError()` and `handleAPIError()` into all tools

#### 9. Code Duplication
**Issue**: Multiple patterns duplicated across tools
- Month conversion logic (5+ tools)
- Amount conversion from milliUnits (6+ tools)
- Budget ID fallback logic (all tools)
- **Fix**: Extract to utility functions

### 🟢 LOW PRIORITY

#### 10. Missing Error Handling Standards
**Issue**: Not using MCP `isError` flag in responses
- **Current**: Returns error in content text only
- **Required**: Set `isError: true` in result object

#### 11. Environment Validation
**Issue**: No validation of `YNAB_API_TOKEN` at server startup
- **Current**: Validation deferred to tool execution time
- **Better**: Validate on startup and fail fast

#### 12. Logging Standards
**Issue**: Ensure no logging to stdout (only stderr for stdio transport)

## Action Plan

### Phase 1: Core MCP Compliance (HIGH PRIORITY)
1. ✅ Rename all tools with `ynab_` prefix
2. ✅ Add tool annotations to all 17 tools
3. ✅ Fix type safety in index.ts
4. ✅ Add comprehensive test coverage

### Phase 2: Response & Data Handling (MEDIUM PRIORITY)
5. ✅ Add response_format parameter (json/markdown)
6. ✅ Implement pagination for list tools
7. ✅ Add character limit enforcement
8. ✅ Integrate apiErrorHandler utility
9. ✅ Extract utility functions for common patterns

### Phase 3: Polish & Quality (LOW PRIORITY)
10. ✅ Implement isError flag in responses
11. ✅ Add environment validation at startup
12. ✅ Verify logging standards compliance

### Phase 4: Validation
13. ✅ Run full test suite
14. ✅ Build and verify compilation
15. ✅ Update documentation

## Summary Statistics

| Category | Issues Found | Priority |
|----------|-------------|----------|
| **Naming Conventions** | 17 tools | HIGH |
| **Tool Annotations** | 17 tools missing | HIGH |
| **Type Safety** | 17 cast issues | HIGH |
| **Test Coverage** | 12 tools uncovered | HIGH |
| **Response Formats** | 17 tools affected | MEDIUM |
| **Pagination** | 8+ tools affected | MEDIUM |
| **Character Limits** | All tools | MEDIUM |
| **Code Quality** | Multiple issues | MEDIUM-LOW |

## Expected Outcomes

After implementation:
- ✅ Full MCP best practices compliance
- ✅ 100% type safety
- ✅ 100% test coverage
- ✅ Consistent error handling
- ✅ Proper pagination support
- ✅ Character limit enforcement
- ✅ Reduced code duplication
- ✅ Better user experience with response format options
