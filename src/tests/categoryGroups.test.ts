import { describe, expect, it } from "vitest";
import type * as ynab from "ynab";
import { exactKey, resolveCategory, resolveGroup, validateGoal } from "../tools/categoryGroups";

function category(id: string, name: string, extra: Partial<ynab.Category> = {}): ynab.Category {
  return { id, name, hidden: false, deleted: false, internal: false, category_group_id: "", ...extra } as ynab.Category;
}

function group(id: string, name: string, categories: ynab.Category[] = [], extra: Partial<ynab.CategoryGroupWithCategories> = {}) {
  return {
    id, name, hidden: false, deleted: false, internal: false,
    categories: categories.map((c) => ({ ...c, category_group_id: id })),
    ...extra,
  } as ynab.CategoryGroupWithCategories;
}

const internal = group("g-internal", "Internal Master Category", [category("c-rta", "Inflow: Ready to Assign", { internal: true })], { internal: true });
const cards = group("g-cards", "Credit Card Payments", [category("c-visa", "Visa")]);
// YNAB flags its starter groups as internal too; they are ordinary groups.
const needs = group("g-needs", "Needs", [category("c-groceries", "🛒 Groceries"), category("c-old", "Old stuff", { hidden: true })], { internal: true });
const savings = group("g-savings", "😌 Savings", [category("c-ef", "Emergency fund")]);
const hiddenGroup = group("g-hidden", "Archive", [category("c-archived", "Archived thing")], { hidden: true });
const groups = [internal, cards, needs, savings, hiddenGroup];

describe("exactKey", () => {
  it("ignores case, spacing and leading emoji but keeps every script", () => {
    expect(exactKey("  😌 Savings ")).toBe("savings");
    expect(exactKey("Big  Trip")).toBe("big trip");
    expect(exactKey("旅行 fund")).not.toBe(exactKey("教育 fund"));
    expect(exactKey("🎁")).toBe("");
  });
});

describe("resolveGroup", () => {
  it("prefers the id over the name", () => {
    expect(resolveGroup(groups, { id: "g-needs", name: "Savings" })).toMatchObject({ kind: "found", item: { id: "g-needs" } });
  });

  it("throws for an unknown id instead of reporting it as missing", () => {
    expect(() => resolveGroup(groups, { id: "nope" })).toThrow('No category group with id "nope"');
  });

  it("rejects internal and credit card payment groups, by id or by name", () => {
    expect(resolveGroup(groups, { id: "g-internal" })).toMatchObject({ kind: "disallowed", reason: "internal" });
    expect(resolveGroup(groups, { id: "g-cards" })).toMatchObject({ kind: "disallowed", reason: "credit-card-payments" });
    expect(resolveGroup(groups, { name: "credit card payments" })).toMatchObject({ kind: "disallowed", reason: "credit-card-payments" });
  });

  it("treats starter groups YNAB flags as internal as ordinary groups", () => {
    expect(resolveGroup(groups, { name: "Needs" })).toMatchObject({ kind: "found", item: { id: "g-needs" } });
    expect(resolveCategory(groups, { name: "groceries" })).toMatchObject({ kind: "found", item: { id: "c-groceries" } });
  });

  it("allows a hidden group by id but reports a name that only matches it", () => {
    expect(resolveGroup(groups, { id: "g-hidden" })).toMatchObject({ kind: "found" });
    expect(resolveGroup(groups, { name: "archive" })).toMatchObject({ kind: "disallowed", reason: "hidden" });
  });

  it("matches exactly, ignoring emoji, before matching loosely", () => {
    const withLookalike = [...groups, group("g-sav2", "Savings goals")];
    expect(resolveGroup(withLookalike, { name: "savings" })).toMatchObject({ kind: "found", item: { id: "g-savings" } });
  });

  it("reports two groups with the same exact name as ambiguous", () => {
    const twins = [...groups, group("g-twin", "Savings")];
    const result = resolveGroup(twins, { name: "Savings" });
    expect(result.kind).toBe("ambiguous");
  });

  it("falls back to fuzzy matching for ASCII names, emoji-prefixed ones included", () => {
    expect(resolveGroup(groups, { name: "sav" })).toMatchObject({ kind: "found", item: { id: "g-savings" } });
  });

  it("reports no match without fuzzy matching when told not to", () => {
    expect(resolveGroup(groups, { name: "sav" }, { fuzzy: false })).toEqual({ kind: "none" });
  });

  it("never fuzzy-matches names with letters outside a-z", () => {
    const scripts = [group("g-edu", "教育 fund")];
    expect(resolveGroup(scripts, { name: "旅行 fund" })).toEqual({ kind: "none" });
    expect(resolveGroup([group("g-trip", "旅行 fund")], { name: "fund" })).toEqual({ kind: "none" });
    expect(resolveGroup(scripts, { name: "教育 FUND" })).toMatchObject({ kind: "found", item: { id: "g-edu" } });
  });

  it("rejects a name with no letters or numbers", () => {
    expect(() => resolveGroup(groups, { name: "🎁" })).toThrow("must contain a letter or number");
  });
});

describe("resolveCategory", () => {
  it("finds hidden categories and categories in hidden groups", () => {
    expect(resolveCategory(groups, { name: "old stuff" })).toMatchObject({ kind: "found", item: { id: "c-old" } });
    expect(resolveCategory(groups, { name: "Archived thing" })).toMatchObject({ kind: "found", item: { id: "c-archived", group: { id: "g-hidden" } } });
  });

  it("refuses internal and credit card payment categories", () => {
    expect(resolveCategory(groups, { id: "c-rta" })).toMatchObject({ kind: "disallowed", reason: "internal" });
    expect(resolveCategory(groups, { name: "Visa" })).toMatchObject({ kind: "disallowed", reason: "credit-card-payments" });
  });

  it("reports an ambiguous name", () => {
    const dupes = [...groups, group("g-wants", "Wants", [category("c-g2", "Groceries")])];
    expect(resolveCategory(dupes, { name: "groceries" }).kind).toBe("ambiguous");
  });
});

describe("validateGoal", () => {
  it("accepts zero and real dates", () => {
    expect(() => validateGoal(0, "2028-02-29")).not.toThrow();
  });

  it("rejects negative, NaN and non-calendar input", () => {
    expect(() => validateGoal(-1, undefined)).toThrow("goalTarget");
    expect(() => validateGoal(Number.NaN, undefined)).toThrow("goalTarget");
    expect(() => validateGoal(undefined, "2027-02-30")).toThrow("not a real calendar date");
  });
});
