import { describe, expect, it } from "vitest";
import * as ynab from "ynab";

import { priorFeatures, trainPersonalPrior } from "../tools/personalPrior.js";

function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    date: "2026-08-01",
    amount: -12500,
    account_id: "account-a",
    payee_name: null,
    import_payee_name: null,
    import_payee_name_original: null,
    category_id: null,
    deleted: false,
    ...overrides,
  } as unknown as ynab.TransactionDetail;
}

describe("personalPrior", () => {
  it("builds name tokens without digits, short fragments, or stop tokens, plus account and amount features", () => {
    const features = priorFeatures(row({
      payee_name: "Lumen Pantry #42",
      import_payee_name: "POS LUMEN PANTRY 0042 KY",
      import_payee_name_original: "Lumen Pantry Uptown",
    }));

    expect(features.sort()).toEqual([
      "account:account-a",
      "amount:3",
      "name:lumen",
      "name:pantry",
      "name:uptown",
    ]);
  });

  it("returns a normalized, deterministic ranking that favours categories sharing name tokens", () => {
    const training = [
      row({ id: "a", payee_name: "Lumen Pantry", category_id: "cat-dining" }),
      row({ id: "b", payee_name: "Lumen Pantry Annex", category_id: "cat-dining" }),
      row({ id: "c", payee_name: "Zephyr Depot", category_id: "cat-grocery" }),
      row({ id: "d", payee_name: "Zephyr Depot North", category_id: "cat-grocery" }),
    ];
    const prior = trainPersonalPrior(training);

    const ranking = prior.rank(row({ payee_name: "Lumen Pantry West" }));

    expect(prior.trainingRows).toBe(4);
    expect(prior.categoryCount).toBe(2);
    expect(ranking.map((entry) => entry.categoryId)).toEqual(["cat-dining", "cat-grocery"]);
    expect(ranking.reduce((sum, entry) => sum + entry.probability, 0)).toBeCloseTo(1, 12);
    expect(prior.rank(row({ payee_name: "Lumen Pantry West" }))).toEqual(ranking);
  });

  it("ignores unseen name tokens instead of penalizing categories with more history", () => {
    const training = [
      ...Array.from({ length: 100 }, (_value, index) => row({ id: `z${index}`, payee_name: "Zephyr Depot", category_id: "cat-large" })),
      ...Array.from({ length: 5 }, (_value, index) => row({ id: `l${index}`, payee_name: "Lumen Pantry", category_id: "cat-small" })),
    ];
    const prior = trainPersonalPrior(training);
    const unrelated = row({ payee_name: "Unrelated Sportsgear" });

    const ranking = prior.rank(unrelated);

    // Only shared account and amount features remain, so the base rate decides.
    expect(ranking[0].categoryId).toBe("cat-large");
    expect(prior.knownNameTokens(unrelated)).toBe(0);
    expect(prior.knownNameTokens(row({ payee_name: "Lumen Pantry West" }))).toBe(2);
  });

  it("ranks nothing without training rows", () => {
    expect(trainPersonalPrior([]).rank(row({ payee_name: "Lumen Pantry" }))).toEqual([]);
  });
});
