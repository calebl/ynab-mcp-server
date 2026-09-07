import { describe, it, expect } from "vitest";
import * as ynab from "ynab";

import { mapSubtransactions } from "../tools/splits.js";

function sub(overrides: Partial<ynab.SubTransaction> = {}): ynab.SubTransaction {
  return {
    id: "sub-1",
    transaction_id: "txn-1",
    amount: -350000,
    deleted: false,
    ...overrides,
  } as ynab.SubTransaction;
}

describe("mapSubtransactions", () => {
  it("returns undefined for an ordinary transaction", () => {
    expect(mapSubtransactions(undefined)).toBeUndefined();
    expect(mapSubtransactions([])).toBeUndefined();
  });

  it("returns undefined when every leg is deleted", () => {
    expect(mapSubtransactions([sub({ deleted: true })])).toBeUndefined();
  });

  it("converts amounts to plain currency", () => {
    const result = mapSubtransactions([sub({ amount: -476080 })]);
    expect(result).toEqual([
      { amount: -476.08, category_name: undefined, payee_name: undefined, memo: undefined },
    ]);
  });

  it("carries the category of each leg", () => {
    const result = mapSubtransactions([
      sub({ amount: -350000, category_name: "Household", memo: "printer" }),
      sub({ id: "sub-2", amount: -476080, category_name: "Groceries" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result![0].category_name).toBe("Household");
    expect(result![0].memo).toBe("printer");
    expect(result![1].category_name).toBe("Groceries");
  });

  it("drops deleted legs but keeps the rest", () => {
    const result = mapSubtransactions([
      sub({ category_name: "Household" }),
      sub({ id: "sub-2", category_name: "Groceries", deleted: true }),
    ]);

    expect(result).toHaveLength(1);
    expect(result![0].category_name).toBe("Household");
  });
});
