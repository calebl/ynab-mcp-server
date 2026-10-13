import * as ynab from "ynab";
import { toDollars } from "./money.js";

/** The category shape every category-returning tool emits, amounts in plain currency. */
export function formatCategory(category: ynab.Category) {
  return {
    id: category.id,
    name: category.name,
    category_group_id: category.category_group_id,
    category_group_name: category.category_group_name ?? null,
    hidden: category.hidden,
    deleted: category.deleted,
    note: category.note ?? null,
    budgeted: toDollars(category.budgeted),
    activity: toDollars(category.activity),
    balance: toDollars(category.balance),
    goal_type: category.goal_type ?? null,
    // Truthy test kept from the existing ynab_list_categories / ynab_plan_summary output (0 -> null).
    goal_target: category.goal_target ? toDollars(category.goal_target) : null,
    goal_target_date: category.goal_target_date ?? null,
    goal_needs_whole_amount: category.goal_needs_whole_amount ?? null,
    goal_cadence: category.goal_cadence ?? null,
    goal_percentage_complete: category.goal_percentage_complete ?? null,
    goal_under_funded: category.goal_under_funded == null ? null : toDollars(category.goal_under_funded),
  };
}
