import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";

export const name = "ynab_auto_assign";
export const description = "Distributes Ready to Assign across categories whose monthly goal is not yet fully funded, largest shortfall first, until the money runs out. Set dryRun to see the plan without changing anything.";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  month: z.string().regex(/^(current|\d{4}-\d{2}-\d{2})$/).optional().describe("The budget month in ISO format (e.g. 2024-01-01, must be the first of the month), or 'current'. Defaults to 'current'."),
  dryRun: z.boolean().optional().describe("Return the proposed assignments without writing them (default: false)"),
  maxTotal: z.number().positive().optional().describe("Only assign up to this many dollars, even if more is available in Ready to Assign"),
};

interface AutoAssignInput {
  budgetId?: string;
  month?: string;
  dryRun?: boolean;
  maxTotal?: number;
}

interface PlannedAssignment {
  categoryId: string;
  name: string;
  currentBudgeted: number;
  assign: number;
  newBudgeted: number;
  shortfallRemaining: number;
  /** Kept in milliunits so applying the plan never round-trips through dollars. */
  newBudgetedMilliunits: number;
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

/** Builds the assignment plan in milliunits, biggest shortfall first. */
function planAssignments(
  categories: ynab.Category[],
  availableMilliunits: number
): PlannedAssignment[] {
  const underfunded = categories
    .filter((category) => !category.deleted && !category.hidden)
    .filter((category) => (category.goal_under_funded ?? 0) > 0)
    .sort((a, b) => (b.goal_under_funded ?? 0) - (a.goal_under_funded ?? 0));

  const plan: PlannedAssignment[] = [];
  let remaining = availableMilliunits;

  for (const category of underfunded) {
    if (remaining <= 0) break;

    const shortfall = category.goal_under_funded ?? 0;
    const assign = Math.min(shortfall, remaining);
    remaining -= assign;

    plan.push({
      categoryId: category.id,
      name: category.name,
      currentBudgeted: toDollars(category.budgeted),
      assign: toDollars(assign),
      newBudgeted: toDollars(category.budgeted + assign),
      shortfallRemaining: toDollars(shortfall - assign),
      newBudgetedMilliunits: category.budgeted + assign,
    });
  }

  return plan;
}

/** Drops the internal milliunit field so responses stay in plain currency. */
function forOutput({ newBudgetedMilliunits, ...rest }: PlannedAssignment) {
  return rest;
}

export async function execute(input: AutoAssignInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);
    const month = input.month || "current";

    const monthResponse = await api.months.getBudgetMonth(budgetId, month);
    const readyToAssign = monthResponse.data.month.to_be_budgeted;

    if (readyToAssign <= 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            month,
            ready_to_assign: toDollars(readyToAssign),
            assignments: [],
            message: "Nothing to assign - Ready to Assign is not positive.",
          }, null, 2),
        }],
      };
    }

    const cap = input.maxTotal !== undefined
      ? Math.min(readyToAssign, toMilliunits(input.maxTotal))
      : readyToAssign;

    const plan = planAssignments(monthResponse.data.month.categories, cap);
    const totalPlanned = plan.reduce((sum, item) => sum + item.assign, 0);

    if (plan.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            month,
            ready_to_assign: toDollars(readyToAssign),
            assignments: [],
            message: "Nothing to assign - no category has an unmet monthly goal.",
          }, null, 2),
        }],
      };
    }

    if (input.dryRun) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dry_run: true,
            month,
            ready_to_assign: toDollars(readyToAssign),
            total_to_assign: totalPlanned,
            remaining_after: toDollars(readyToAssign) - totalPlanned,
            assignments: plan.map(forOutput),
            message: `Would assign $${totalPlanned.toFixed(2)} across ${plan.length} categor${plan.length === 1 ? "y" : "ies"}. Call again without dryRun to apply.`,
          }, null, 2),
        }],
      };
    }

    // Apply one category at a time so a failure part-way through can report
    // exactly what already landed.
    const applied: PlannedAssignment[] = [];
    for (const item of plan) {
      try {
        await api.categories.updateMonthCategory(budgetId, month, item.categoryId, {
          category: { budgeted: item.newBudgetedMilliunits },
        });
        applied.push(item);
      } catch (error) {
        console.error(`Error assigning to ${item.name}:`, error);
        const assignedSoFar = applied.reduce((sum, a) => sum + a.assign, 0);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              partial: true,
              month,
              error: getErrorMessage(error),
              assigned: applied.map(forOutput),
              total_assigned: assignedSoFar,
              not_assigned: plan.slice(applied.length).map(forOutput),
              message: `Assigned $${assignedSoFar.toFixed(2)} to ${applied.length} categor${applied.length === 1 ? "y" : "ies"} before failing on ${item.name}. The remaining categories were left untouched.`,
            }, null, 2),
          }],
        };
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          month,
          ready_to_assign_before: toDollars(readyToAssign),
          total_assigned: totalPlanned,
          remaining_after: toDollars(readyToAssign) - totalPlanned,
          assignments: applied.map(forOutput),
          message: `Assigned $${totalPlanned.toFixed(2)} across ${applied.length} categor${applied.length === 1 ? "y" : "ies"}.`,
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error auto-assigning funds:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }
}
