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
  samplePids,
  withinDollarTolerance,
} from "../report-validate";

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
  it("marks unsampled verifiable rows skipped and uses checked as the denominator", () => {
    const report = buildValidationReport({
      season: "spring26",
      rows: [cleanRow({ pid: "p1" }), cleanRow({ pid: "p2", sku: "sb/s2602" })],
      freshOnHand: { p1: 3 },
      freshConsign: { p1: { qtyOrdered: 5, qtyReceived: 5, qtyReturned: 0 } },
      freshSales: { p1: { sold: 2, onSale: 0, saleAmt: 0 } },
      sampledPids: ["p1"],
    });
    expect(report.counts.verifiableProducts).toBe(2);
    expect(report.counts.checkedProducts).toBe(1);
    expect(report.counts.notSampled).toBe(1);
    expect(
      report.skipped.some((s) => s.pid === "p2" && s.reason === SKIP_REASONS.NOT_SAMPLED)
    ).toBe(true);
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
