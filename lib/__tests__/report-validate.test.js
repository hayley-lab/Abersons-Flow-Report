// Unit tests for the pure validation diff/threshold logic. The endpoint that
// consumes this (pages/api/scan/validate.js) is the only place that touches LS
// or KV; this module is intentionally pure so these tests never hit live LS/KV.
import {
  DEFAULT_THRESHOLDS,
  SKIP_REASONS,
  buildValidationReport,
  dollarTolerance,
  evaluateDrift,
  isVerifiableRow,
  pidToSkuFromRows,
  samplePids,
  withinDollarTolerance,
} from "../report-validate";
import { seasonConsignmentBuckets } from "../consignment-store";
import { seasonScanDateRange } from "../flow-math";

// A verifiable LS row whose fresh-LS values all agree with the report.
function cleanRow(overrides = {}) {
  return {
    pid: "p1",
    sku: "sclean/s2601",
    price: 100,
    cost: 40,
    lsOrderedQty: 5,
    receivedRaw: 5,
    retQty: 0,
    sold: 2,
    onSale: 0,
    saleAmt: 0,
    liveOnHand: 3,
    onHand: 3,
    inventoryMismatch: false,
    ...overrides,
  };
}

describe("dollar tolerance", () => {
  it("allows the larger of 0.5% of expected or $0.01 per unit", () => {
    // 0.5% of $1000 = $5 (dominates the per-unit term here)
    expect(dollarTolerance(1000, 1)).toBeCloseTo(5, 5);
    // 50 units * $0.01 = $0.50 dominates 0.5% of $10 ($0.05)
    expect(dollarTolerance(10, 50)).toBeCloseTo(0.5, 5);
    // floor is $0.01 even when expected and qty are zero
    expect(dollarTolerance(0, 0)).toBeCloseTo(0.01, 5);
  });

  it("treats within-tolerance dollar drift as a match", () => {
    expect(withinDollarTolerance(1000, 1004, 1)).toBe(true); // within $5
    expect(withinDollarTolerance(1000, 1006, 1)).toBe(false); // beyond $5
  });
});

describe("samplePids", () => {
  it("returns the full list when under the cap", () => {
    expect(samplePids(["a", "b", "c"], 10)).toEqual(["a", "b", "c"]);
    expect(samplePids(["a", "b"], 0)).toEqual(["a", "b"]);
  });

  it("returns a deterministic, evenly-spaced, bounded subset", () => {
    const pids = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const a = samplePids(pids, 10);
    const b = samplePids(pids, 10);
    expect(a).toHaveLength(10);
    expect(a).toEqual(b); // deterministic
    expect(a[0]).toBe("p0");
    expect(new Set(a).size).toBe(10); // no duplicates (spread across the list)
  });
});

describe("isVerifiableRow", () => {
  it("excludes datatail-only and manual-adjustment rows", () => {
    expect(isVerifiableRow(cleanRow())).toBe(true);
    expect(isVerifiableRow(cleanRow({ pid: null }))).toBe(false);
    expect(isVerifiableRow(cleanRow({ inventoryMismatch: true }))).toBe(false);
  });
});

describe("validation consignment SKU gate", () => {
  it("uses canonical row SKUs to avoid wrong-season consignment mismatches", () => {
    const rows = [
      cleanRow({
        pid: "pFall",
        sku: "vendor/f2601",
        lsOrderedQty: 0,
        receivedRaw: 0,
        retQty: 0,
      }),
    ];
    const pidToSku = pidToSkuFromRows(rows);
    const buckets = seasonConsignmentBuckets(
      {
        c1: {
          id: "c1",
          type: "SUPPLIER",
          date: "2026-05-01",
          perPid: { pFall: { qtyOrdered: 6, qtyReceived: 6, qtyReturned: 0 } },
        },
      },
      {
        seasons: ["prespring27"],
        seasonPidSets: { prespring27: new Set(["pFall"]) },
        scanRanges: { prespring27: seasonScanDateRange("prespring27") },
        pidToSku,
      }
    );
    const report = buildValidationReport({
      season: "prespring27",
      rows,
      freshOnHand: { pFall: 3 },
      freshConsign: {},
      freshSales: { pFall: { sold: 2, onSale: 0, saleAmt: 0 } },
    });

    expect(buckets.prespring27.pidToQtyOrdered).toEqual({});
    expect(report.mismatches.filter((m) => m.source === "consignment")).toEqual([]);
  });
});

describe("buildValidationReport — clean season", () => {
  const rows = [cleanRow()];
  const report = buildValidationReport({
    season: "spring26",
    rows,
    freshOnHand: { p1: 3 },
    freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
    freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
  });

  it("reports no mismatches and does not trip drift", () => {
    expect(report.mismatches).toHaveLength(0);
    expect(report.counts.verifiableProducts).toBe(1);
    expect(report.counts.checkedProducts).toBe(1);
    expect(report.counts.driftedProducts).toBe(0);
    expect(report.drift.tripped).toBe(false);
  });
});

describe("buildValidationReport — hard quantity mismatches", () => {
  it("flags a fresh-LS on-hand mismatch as a hard trip", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow()],
      freshOnHand: { p1: 1 }, // report says 3
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    const m = report.mismatches.find((x) => x.field === "onHand");
    expect(m).toMatchObject({ pid: "p1", source: "inventory", expected: 3, actual: 1, delta: -2 });
    expect(report.counts.hardQtyMismatches).toBe(1);
    expect(report.drift.tripped).toBe(true);
    expect(report.drift.reasons.map((r) => r.code)).toContain("hard-qty-mismatch");
  });

  it("flags PO ordered/received and vendor-return re-sum mismatches", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ lsOrderedQty: 5, receivedRaw: 5, retQty: 1 })],
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 7, qtyReceived: 4, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    const fields = report.mismatches.map((m) => m.field).sort();
    expect(fields).toEqual(["qtyOrdered", "qtyReceived", "retQty"]);
    expect(report.mismatches.every((m) => m.source === "consignment")).toBe(true);
    expect(report.counts.hardQtyMismatches).toBe(3);
    expect(report.drift.tripped).toBe(true);
  });
});

describe("buildValidationReport — sales drift", () => {
  it("counts sold/onSale qty drift as drifted but not a hard trip", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ sold: 2, onSale: 1, saleAmt: 50 })],
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 3, onSale: 0, saleAmt: 50 } },
    });
    expect(report.counts.hardQtyMismatches).toBe(0);
    expect(report.counts.driftedProducts).toBe(1);
    expect(report.mismatches.map((m) => m.field).sort()).toEqual(["onSale", "sold"]);
    // single drifted product out of one checked = 100% > 0.5% threshold
    expect(report.drift.tripped).toBe(true);
    expect(report.drift.reasons.map((r) => r.code)).toContain("drifted-products");
  });

  it("respects the dollar tolerance for saleAmt", () => {
    const withinTol = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ onSale: 1, saleAmt: 1000 })],
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 1, saleAmt: 1004 } }, // within $5
    });
    expect(withinTol.mismatches.find((m) => m.field === "saleAmt")).toBeUndefined();

    const beyondTol = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ onSale: 1, saleAmt: 1000 })],
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 1, saleAmt: 1010 } }, // beyond $5
    });
    expect(beyondTol.mismatches.find((m) => m.field === "saleAmt")).toMatchObject({
      source: "sales",
      delta: 10,
    });
  });
});

describe("buildValidationReport — un-verifiable buckets are skipped, not failed", () => {
  it("labels datatail-only and manual-adjustment rows as skipped", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [
        cleanRow({ pid: null, sku: "sdatatail/s2601" }), // datatail-only
        cleanRow({ pid: "p2", inventoryMismatch: true, liveOnHand: 9 }), // manual adj
        cleanRow(), // verifiable & clean
      ],
      freshOnHand: { p1: 3, p2: 1 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    expect(report.counts.datatailOnly).toBe(1);
    expect(report.counts.manualAdjustment).toBe(1);
    expect(report.counts.verifiableProducts).toBe(1);
    expect(report.mismatches).toHaveLength(0); // p2's on-hand drift is NOT a failure
    expect(report.drift.tripped).toBe(false);
    const reasons = report.skipped.map((s) => s.reason);
    expect(reasons).toContain(SKIP_REASONS.DATATAIL_ONLY);
    expect(reasons).toContain(SKIP_REASONS.MANUAL_ADJUSTMENT);
  });
});

describe("buildValidationReport — sampling", () => {
  it("samples only live on-hand while cache checks still cover all verifiable rows", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ pid: "p1" }), cleanRow({ pid: "p2", sku: "sb/s2602" })],
      freshOnHand: { p1: 3 },
      freshConsign: {
        p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 },
        p2: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 },
      },
      freshSales: {
        p1: { sold: 2, onSale: 0, saleAmt: 0 },
        p2: { sold: 2, onSale: 0, saleAmt: 0 },
      },
      sampledPids: ["p1"],
    });
    expect(report.counts.verifiableProducts).toBe(2);
    expect(report.counts.checkedProducts).toBe(2);
    expect(report.counts.onHandCheckedProducts).toBe(1);
    expect(report.counts.notSampled).toBe(1);
    expect(
      report.skipped.some(
        (s) => s.pid === "p2" && s.field === "onHand" && s.reason === SKIP_REASONS.NOT_SAMPLED
      )
    ).toBe(true);
  });

  it("still flags cache-derived consignment drift on an unsampled on-hand row", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ pid: "p1" }), cleanRow({ pid: "p2", sku: "sb/s2602" })],
      freshOnHand: { p1: 3 },
      freshConsign: {
        p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 },
        p2: { qtyOrdered: 4, qtyReceived: 5, qtyReturned: 0 },
      },
      freshSales: {
        p1: { sold: 2, onSale: 0, saleAmt: 0 },
        p2: { sold: 2, onSale: 0, saleAmt: 0 },
      },
      sampledPids: ["p1"],
    });
    expect(report.mismatches.find((m) => m.pid === "p2" && m.field === "qtyOrdered")).toMatchObject(
      {
        source: "consignment",
        expected: 5,
        actual: 4,
      }
    );
  });

  it("marks a sampled row with no fresh on-hand as no-fresh-data (not a failure)", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow()],
      freshOnHand: {}, // budget exhausted before this pid
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    expect(report.mismatches.find((m) => m.field === "onHand")).toBeUndefined();
    expect(
      report.skipped.some((s) => s.field === "onHand" && s.reason === SKIP_REASONS.NO_FRESH_DATA)
    ).toBe(true);
  });
});

describe("buildValidationReport — rollup and data-gap checks", () => {
  it("flags vendor/header dollar invariant mismatches", () => {
    const rows = [cleanRow({ pid: "p1", vendorName: "Vendor", sup: { id: "V", name: "Vendor" } })];
    const rollupResult = {
      deptVendors: {
        undefined: [
          {
            id: "V",
            name: "Vendor",
            ordered: 500,
            orderedCost: 200,
            received: 999,
            cost: 200,
            returned: 0,
            returnedCost: 0,
            sold: 200,
          },
        ],
      },
      summaryRows: [
        {
          id: "undefined",
          name: "Dept",
          ordered: 500,
          orderedCost: 200,
          received: 999,
          cost: 200,
          returned: 0,
          returnedCost: 0,
          sold: 200,
        },
      ],
    };
    const report = buildValidationReport({
      season: "fall26",
      rows,
      rollupResult,
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    expect(report.counts.rollupMismatches).toBeGreaterThan(0);
    expect(report.mismatches.find((m) => m.source === "rollup")).toMatchObject({
      field: "rollupReceived",
    });
    expect(report.drift.reasons.map((r) => r.code)).toContain("rollup-dollar-mismatch");
  });

  it("does not cross-contaminate shared-supplier-id vendor buckets", () => {
    const rows = [
      cleanRow({
        pid: "levi",
        sku: "levi/s2601",
        deptId: "alley",
        vendorName: "Levi's",
        sup: { id: "shared", name: "Levi&#039;s" },
        price: 100,
        cost: 40,
        lsOrderedQty: 1,
        receivedRaw: 1,
        sold: 0,
        liveOnHand: 1,
      }),
      cleanRow({
        pid: "other",
        sku: "other/s2601",
        deptId: "alley",
        vendorName: "Other Brand",
        sup: { id: "shared", name: "Other Brand" },
        price: 50,
        cost: 20,
        lsOrderedQty: 2,
        receivedRaw: 2,
        sold: 0,
        liveOnHand: 2,
      }),
    ];
    const rollupResult = {
      deptVendors: {
        alley: [
          {
            id: "shared",
            name: "Levi's",
            ordered: 100,
            orderedCost: 40,
            received: 100,
            cost: 40,
            returned: 0,
            returnedCost: 0,
            sold: 0,
          },
          {
            id: "shared",
            name: "Other Brand",
            ordered: 100,
            orderedCost: 40,
            received: 100,
            cost: 40,
            returned: 0,
            returnedCost: 0,
            sold: 0,
          },
        ],
      },
      summaryRows: [
        {
          id: "alley",
          name: "Alley",
          ordered: 200,
          orderedCost: 80,
          received: 200,
          cost: 80,
          returned: 0,
          returnedCost: 0,
          sold: 0,
        },
      ],
    };
    const report = buildValidationReport({
      season: "spring26",
      rows,
      rollupResult,
      freshOnHand: { levi: 1, other: 2 },
      freshConsign: {
        levi: { qtyOrdered: 1, qtyReceived: 1, qtyReturned: 0 },
        other: { qtyOrdered: 2, qtyReceived: 2, qtyReturned: 0 },
      },
      freshSales: {
        levi: { sold: 0, onSale: 0, saleAmt: 0 },
        other: { sold: 0, onSale: 0, saleAmt: 0 },
      },
    });

    expect(report.counts.rollupMismatches).toBe(0);
  });

  it("matches the Unassigned vendor bucket to its unresolved-supplier rows", () => {
    // Regression: rows key by vendorBucketKey(sup) -> "__unassigned__", but the
    // vendor row id is "__unassigned__" whose name normalizes to "unassigned".
    // The lookup must use vendorMatchKey so the rowSum is not falsely empty.
    const rows = [
      cleanRow({
        pid: "u1",
        sku: "u/s2601",
        deptId: "alley",
        vendorName: "Unassigned",
        sup: { i: "__none__" },
        price: 100,
        cost: 40,
        lsOrderedQty: 1,
        receivedRaw: 1,
        sold: 0,
        liveOnHand: 1,
      }),
    ];
    const rollupResult = {
      deptVendors: {
        alley: [
          {
            id: "__unassigned__",
            name: "Unassigned",
            ordered: 100,
            orderedCost: 40,
            received: 100,
            cost: 40,
            returned: 0,
            returnedCost: 0,
            sold: 0,
          },
        ],
      },
      summaryRows: [
        {
          id: "alley",
          name: "Alley",
          ordered: 100,
          orderedCost: 40,
          received: 100,
          cost: 40,
          returned: 0,
          returnedCost: 0,
          sold: 0,
        },
      ],
    };
    const report = buildValidationReport({
      season: "spring26",
      rows,
      rollupResult,
      freshOnHand: { u1: 1 },
      freshConsign: { u1: { qtyOrdered: 1, qtyReceived: 1, qtyReturned: 0 } },
      freshSales: { u1: { sold: 0, onSale: 0, saleAmt: 0 } },
    });

    expect(report.counts.rollupMismatches).toBe(0);
  });

  it("does not compare datatail-folded orderedCost to the LS-only row sum", () => {
    const rows = [
      cleanRow({
        pid: "dt",
        deptId: "alley",
        vendorName: "Datatail Vendor",
        sup: { id: "D", name: "Datatail Vendor" },
        price: 100,
        cost: 40,
        lsOrderedQty: 1,
        receivedRaw: 1,
        sold: 0,
        liveOnHand: 1,
      }),
    ];
    const rollupResult = {
      deptVendors: {
        alley: [
          {
            id: "D",
            name: "Datatail Vendor",
            ordered: 100,
            orderedCost: 114,
            received: 100,
            cost: 40,
            returned: 0,
            returnedCost: 0,
            sold: 0,
          },
        ],
      },
      summaryRows: [
        {
          id: "alley",
          name: "Alley",
          ordered: 100,
          orderedCost: 114,
          received: 100,
          cost: 40,
          returned: 0,
          returnedCost: 0,
          sold: 0,
        },
      ],
    };
    const report = buildValidationReport({
      season: "spring26",
      rows,
      rollupResult,
      freshOnHand: { dt: 1 },
      freshConsign: { dt: { qtyOrdered: 1, qtyReceived: 1, qtyReturned: 0 } },
      freshSales: { dt: { sold: 0, onSale: 0, saleAmt: 0 } },
    });

    expect(report.mismatches.find((m) => m.field === "rollupOrderedCost")).toBeUndefined();
    expect(report.counts.rollupMismatches).toBe(0);
  });

  it("reports coverage percentages and known data gaps", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [
        cleanRow({ pid: null, sku: "dt/s2601" }),
        cleanRow({ pid: "p2", inventoryMismatch: true }),
        cleanRow({ pid: "p3", cost: 0, price: 0, onHand: 1 }),
      ],
      freshOnHand: { p3: 3 },
      freshConsign: { p3: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p3: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    expect(report.counts.datatailOnlyPct).toBeCloseTo(1 / 3, 5);
    expect(report.counts.manualAdjustmentPct).toBeCloseTo(1 / 3, 5);
    expect(report.counts.cacheCheckedPct).toBe(1);
    expect(report.counts.retailVerifiablePct).toBe(0);
    expect(report.counts.dataGaps.orderedCostGap).toBe(1);
    expect(report.counts.dataGaps.zeroPriceGap).toBe(1);
    expect(report.dataGaps.map((g) => g.code)).toContain("staud-spring26-checklist");
  });
});

describe("evaluateDrift — season retail-$ threshold", () => {
  it("trips when season retail drift exceeds 0.5% even without a hard mismatch", () => {
    // Many verifiable products so the drifted-products ratio stays under 0.5%,
    // isolating the season-dollar trigger.
    const rows = [];
    for (let i = 0; i < 500; i++) {
      rows.push(cleanRow({ pid: `p${i}`, sku: `s${i}/s26`, liveOnHand: 10, sold: 0, price: 100 }));
    }
    const freshOnHand = {};
    const freshConsign = {};
    const freshSales = {};
    rows.forEach((r) => {
      freshOnHand[r.pid] = r.pid === "p0" ? 0 : 10; // one product fully drifted
      freshConsign[r.pid] = { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 };
      freshSales[r.pid] = { sold: 0, onSale: 0, saleAmt: 0 };
    });
    const report = buildValidationReport({
      season: "spring26",
      rows,
      freshOnHand,
      freshConsign,
      freshSales,
    });
    // one on-hand mismatch -> hard trip regardless; assert the season ratio is computed
    expect(report.counts.seasonReportedRetail).toBeGreaterThan(0);
    expect(report.counts.seasonRetailDrift).toBeCloseTo(1000, 5); // 10 units * $100
    const drift = evaluateDrift(report, { ...DEFAULT_THRESHOLDS });
    expect(drift.tripped).toBe(true);
  });

  it("stays dormant when everything is within threshold", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow()],
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
    });
    expect(evaluateDrift(report).tripped).toBe(false);
  });
});
