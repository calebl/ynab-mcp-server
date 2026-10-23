import * as ynab from "ynab";
import { rankMatches } from "./match.js";
import { toMilliunits } from "./money.js";

/**
 * Resolves category groups and categories for the tools that create and edit
 * them. Writes here change the plan's structure, so resolution reports every
 * outcome - not found, ambiguous, or off-limits - rather than guessing, and the
 * caller decides what each one means.
 */

export const CREDIT_CARD_PAYMENTS_GROUP = "Credit Card Payments";

/** YNAB's limit for category group names (see `SaveCategoryGroup`). */
export const MAX_GROUP_NAME_LENGTH = 50;

export type Restriction = "internal" | "credit-card-payments" | "hidden";

export type Resolution<T> =
  | { kind: "found"; item: T }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "disallowed"; item: T; reason: Restriction };

export interface Lookup {
  id?: string;
  name?: string;
}

/** A category with the group it belongs to. */
export type GroupedCategory = ynab.Category & { group: ynab.CategoryGroupWithCategories };

/** Every non-deleted group with its non-deleted categories, hidden ones included. */
export async function loadGroups(planId: string, api: ynab.API): Promise<ynab.CategoryGroupWithCategories[]> {
  const response = await api.categories.getCategories(planId);
  return response.data.category_groups
    .filter((group) => !group.deleted)
    .map((group) => ({ ...group, categories: group.categories.filter((category) => !category.deleted) }));
}

/**
 * The key two names must share to count as the same name: case, spacing and
 * any leading emoji are ignored, but letters in every script are kept, unlike
 * the ASCII-only normalization used for fuzzy matching.
 */
export function exactKey(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** True when every letter is a-z, so fuzzy matching sees the whole name. */
function hasOnlyAsciiLetters(name: string): boolean {
  return !/[^\P{L}A-Za-z]/u.test(name);
}

function resolve<T extends { id: string; name: string }>(
  items: T[],
  lookup: Lookup,
  kind: string,
  restriction: (item: T, byId: boolean) => Restriction | null,
  fuzzy: boolean,
): Resolution<T> {
  if (lookup.id !== undefined) {
    const item = items.find((candidate) => candidate.id === lookup.id);
    if (!item) throw new Error(`No ${kind} with id "${lookup.id}"`);
    const reason = restriction(item, true);
    return reason ? { kind: "disallowed", item, reason } : { kind: "found", item };
  }

  const name = lookup.name ?? "";
  const key = exactKey(name);
  if (!key) throw new Error(`The ${kind} name must contain a letter or number`);

  const exact = items.filter((item) => exactKey(item.name) === key);
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  if (exact.length === 1) {
    const reason = restriction(exact[0], false);
    return reason ? { kind: "disallowed", item: exact[0], reason } : { kind: "found", item: exact[0] };
  }

  // Fuzzy scoring drops every letter outside a-z, so a non-Latin name on
  // either side could match on its leftovers ("fund" against "旅行 fund").
  if (!fuzzy || !hasOnlyAsciiLetters(name)) return { kind: "none" };
  const eligible = items.filter((item) => !restriction(item, false) && hasOnlyAsciiLetters(item.name));
  const ranked = rankMatches(name, eligible);
  if (ranked.length === 0) return { kind: "none" };
  const tied = ranked.filter((match) => match.score === ranked[0].score);
  return tied.length > 1
    ? { kind: "ambiguous", candidates: tied.map((match) => match.item) }
    : { kind: "found", item: ranked[0].item };
}

function groupRestriction(group: ynab.CategoryGroupWithCategories, byId: boolean): Restriction | null {
  if (group.internal) return "internal";
  if (group.name === CREDIT_CARD_PAYMENTS_GROUP) return "credit-card-payments";
  // A hidden group can be targeted deliberately by id, but a name that only
  // matches a hidden group is reported rather than treated as missing.
  if (group.hidden && !byId) return "hidden";
  return null;
}

/**
 * Resolves the group a category goes into. An id wins over a name; names match
 * exactly first and fall back to fuzzy matching only when `fuzzy` is set.
 */
export function resolveGroup(
  groups: ynab.CategoryGroupWithCategories[],
  lookup: Lookup,
  { fuzzy = true }: { fuzzy?: boolean } = {},
): Resolution<ynab.CategoryGroupWithCategories> {
  return resolve(groups, lookup, "category group", groupRestriction, fuzzy);
}

/** Resolves a category to edit. Hidden categories qualify; internal and credit card payment ones don't. */
export function resolveCategory(groups: ynab.CategoryGroupWithCategories[], lookup: Lookup): Resolution<GroupedCategory> {
  const categories = groups.flatMap((group) => group.categories.map((category) => ({ ...category, group })));
  return resolve(categories, lookup, "category", (category) => {
    if (category.internal || category.group.internal) return "internal";
    if (category.group.name === CREDIT_CARD_PAYMENTS_GROUP) return "credit-card-payments";
    return null;
  }, true);
}

const RESTRICTION_REASONS: Record<Restriction, string> = {
  internal: "is internal to YNAB",
  "credit-card-payments": "is managed by YNAB for credit card accounts",
  hidden: "is hidden; pass its id to use it anyway",
};

/** The error for any resolution other than `found`. */
export function describeResolution(resolution: Exclude<Resolution<{ name: string }>, { kind: "found" }>, kind: string, query: string): string {
  switch (resolution.kind) {
    case "none":
      return `No ${kind} matching "${query}"`;
    case "ambiguous":
      return `"${query}" matches several ${kind}s: ${resolution.candidates.map((item) => item.name).join(", ")}. Use the ${kind} id instead.`;
    case "disallowed":
      return `The ${kind} "${resolution.item.name}" ${RESTRICTION_REASONS[resolution.reason]}`;
  }
}

/** Validates the optional target fields shared by both tools, before any write. */
export function validateGoal(goalTarget: number | undefined, goalTargetDate: string | undefined) {
  if (goalTarget !== undefined && (!Number.isFinite(goalTarget) || goalTarget < 0 || !Number.isSafeInteger(toMilliunits(goalTarget)))) {
    throw new Error("goalTarget must be a finite amount of zero or more");
  }
  if (goalTargetDate !== undefined) {
    const [year, month, day] = goalTargetDate.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(goalTargetDate) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error(`goalTargetDate "${goalTargetDate}" is not a real calendar date (use YYYY-MM-DD)`);
    }
  }
}
