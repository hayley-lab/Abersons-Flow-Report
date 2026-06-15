// Unit tests for the pure old-report reconciliation diff. The API route that
// consumes this is responsible for KV reads; these tests never hit live KV/LS.
import { buildReconciliationReport } from "../report-reconcile";

function row(overrides = {}) {
  return {
    pid: "p1",
    sku: "vendor/s2601",
    vendorName: "Vendor",
    deptId: "7",
    deptName: "Shoes",
    price: 100,
    cost: 40,
    orderedQty: 5,
    lsOrderedQty: 5,
    receivedRaw: 5,
    onHand: 2,
    sold: 2,
    onSale: 1,
    retQty: 0,
    ...overrides,
  };
}

function overrideVendor(overrides = {}) {
  return {
    stores: {},
    vendors: {
      "7__439": {
        vendorId: "439",
        vendorName: "Vendor",
        deptId: "7",
        deptName: "Shoes",
        ordered: 500,
        received: 500,
        sold: 200,
        products: [
          {
            style: "vendor/s2601",
            price: 100,
            cost: 40,
            qtyOrdered: 5,
            qtyStock: 2,
            qtySold: 2,
            qtySale: 1,
            qtyReturned: 0,
          },
        ],
        ...overrides,
      },
    },
  };
}

function rollupResult(overrides = {}) {
  return {
    deptVendors: {
      7: [
        {
          id: "439",
          name: "Vendor",
          ordered: 500,
          received: 500,
          sold: 200,
          ...overrides,
        },
      ],
    },
    summaryRows: [],
  };
}

describe("buildReconciliationReport", () => {
  it("reports a clean match when old-product tallies and vendor dollars agree", () => {
    const report = buildReconciliationReport({
      season: "spring26",
      rows: [row()],
      override: overrideVendor(),
      rollupResult: rollupResult(),
      checkedAt: 1,
    });

    expect(report.ok).toBe(true);
    expect(report.counts.matchedProducts).toBe(1);
    expect(report.counts.matchedVendors).toBe(1);
    expect(report.mismatches).toEqual([]);
    expect(report.oldOnly).toEqual([]);
  });

  it("flags exact quantity drift by SKU", () => {
    const report = buildReconciliationReport({
      season: "spring26",
      rows: [row({ sold: 1, onSale: 2 })],
      override: overrideVendor(),
      rollupResult: rollupResult(),
    });

    expect(report.ok).toBe(false);
    expect(report.counts.qtyMismatches).toBe(2);
    expect(report.mismatches.map((m) => m.field).sort()).toEqual(["qtySale", "qtySold"]);
  });

  it("uses dollar tolerance for vendor-level old-vs-new totals", () => {
    const within = buildReconciliationReport({
      season: "spring26",
      rows: [row()],
      override: overrideVendor({ ordered: 1000 }),
      rollupResult: rollupResult({ ordered: 1004 }),
    });
    expect(within.counts.dollarMismatches).toBe(0);

    const beyond = buildReconciliationReport({
      season: "spring26",
      rows: [row()],
      override: overrideVendor({ ordered: 1000 }),
      rollupResult: rollupResult({ ordered: 1010 }),
    });
    expect(beyond.counts.dollarMismatches).toBe(1);
    expect(beyond.vendorMismatches[0]).toMatchObject({
      field: "ordered",
      expected: 1000,
      actual: 1010,
      delta: 10,
    });
  });

  it("classifies old-only and new-only SKUs", () => {
    const report = buildReconciliationReport({
      season: "spring26",
      rows: [row({ sku: "vendor/s2602", pid: "p2" })],
      override: overrideVendor(),
      rollupResult: rollupResult(),
    });

    expect(report.counts.oldOnlyProducts).toBe(1);
    expect(report.counts.newOnlyProducts).toBe(1);
    expect(report.oldOnly[0].sku).toBe("vendor/s2601");
    expect(report.newOnly[0].sku).toBe("vendor/s2602");
  });

  it("excludes wrong-season old products from the reconciliation", () => {
    const report = buildReconciliationReport({
      season: "spring26",
      rows: [],
      override: overrideVendor({
        products: [
          {
            style: "vendor/f2601",
            price: 100,
            cost: 40,
            qtyOrdered: 5,
            qtyStock: 2,
            qtySold: 2,
            qtySale: 1,
            qtyReturned: 0,
          },
        ],
      }),
      rollupResult: rollupResult(),
    });

    expect(report.counts.oldProducts).toBe(0);
    expect(report.counts.wrongSeasonOldProducts).toBe(1);
    expect(report.oldOnly).toEqual([]);
  });
});
