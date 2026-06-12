// Unit tests for the pure Data Health helpers that drive the in-app drift
// surface. These never touch LS/KV — the badge logic is derived from canonical
// rows plus an optional /api/scan/validate report shape.
import {
  HEALTH_LEVEL,
  DEFAULT_CACHE_WARN_PCT,
  MATERIAL_UNIT_DELTA,
  MATERIAL_DOLLAR_DELTA,
  summarizeRowsHealth,
  deriveHealthBadge,
  derivedFlowStock,
  inventoryMismatchBreakdown,
  adjustedCount,
  isMaterialMismatch,
  adjustedBadgeTooltip,
  uncategorizedRows,
} from "../health-status";

function lsRow(overrides = {}) {
  return {
    pid: "p1",
    sku: "s/s2601",
    receivedRaw: 5,
    sold: 1,
    onSale: 0,
    retQty: 0,
    liveOnHand: 4,
    price: 100,
    cost: 40,
    inventoryMismatch: false,
    ...overrides,
  };
}

describe("summarizeRowsHealth", () => {
  it("counts LS rows, datatail-only rows, mismatches, and cache coverage", () => {
    const h = summarizeRowsHealth([
      lsRow({ pid: "p1", liveOnHand: 4 }),
      lsRow({ pid: "p2", liveOnHand: null }), // uncached
      lsRow({ pid: "p3", liveOnHand: 9, inventoryMismatch: true }), // manual adj
      lsRow({ pid: null }), // datatail-only
    ]);
    expect(h.totalRows).toBe(4);
    expect(h.lsRows).toBe(3);
    expect(h.datatailOnly).toBe(1);
    expect(h.missingLiveOnHand).toBe(1);
    expect(h.liveOnHandRows).toBe(2);
    expect(h.inventoryMismatch).toBe(1);
    expect(h.orderedCostGaps).toBe(0);
    expect(h.zeroPriceGaps).toBe(0);
    expect(h.cacheCompletePct).toBeCloseTo(2 / 3, 5);
  });

  it("counts known cost and price data gaps", () => {
    const h = summarizeRowsHealth([
      lsRow({ pid: "p1", orderedQty: 2, cost: 0, price: 100 }),
      lsRow({ pid: "p2", orderedQty: 0, receivedRaw: 1, onHand: 1, price: 0, cost: 50 }),
    ]);
    expect(h.orderedCostGaps).toBe(1);
    expect(h.zeroPriceGaps).toBe(1);
  });

  it("treats a row set with no LS products as fully complete", () => {
    const h = summarizeRowsHealth([lsRow({ pid: null })]);
    expect(h.lsRows).toBe(0);
    expect(h.cacheCompletePct).toBe(1);
  });

  it("handles empty/nullish input", () => {
    expect(summarizeRowsHealth().totalRows).toBe(0);
    expect(summarizeRowsHealth([null]).totalRows).toBe(1);
  });
});

describe("deriveHealthBadge", () => {
  it("is ok when cache is complete and no validation has run", () => {
    const badge = deriveHealthBadge({
      rowsHealth: summarizeRowsHealth([lsRow()]),
    });
    expect(badge.level).toBe(HEALTH_LEVEL.OK);
    expect(badge.validated).toBe(false);
    expect(badge.tripped).toBe(false);
  });

  it("warns when store-cache completeness drops below the threshold", () => {
    const rows = [];
    for (let i = 0; i < 100; i++) {
      rows.push(lsRow({ pid: `p${i}`, liveOnHand: i < 98 ? 1 : null }));
    }
    const badge = deriveHealthBadge({ rowsHealth: summarizeRowsHealth(rows) });
    expect(badge.level).toBe(HEALTH_LEVEL.WARN);
    expect(badge.reasons.map((r) => r.code)).toContain("cache-incomplete");
  });

  it("does not warn for inventory mismatches alone (manual adjustments are expected)", () => {
    const badge = deriveHealthBadge({
      rowsHealth: summarizeRowsHealth([
        lsRow({ pid: "p1", inventoryMismatch: true, liveOnHand: 9 }),
      ]),
    });
    expect(badge.level).toBe(HEALTH_LEVEL.OK);
  });

  it("lights drift (over a warn) when a validation report trips the threshold", () => {
    const rows = [];
    for (let i = 0; i < 100; i++) {
      rows.push(lsRow({ pid: `p${i}`, liveOnHand: i < 98 ? 1 : null }));
    }
    const validation = {
      drift: {
        tripped: true,
        reasons: [{ code: "hard-qty-mismatch", detail: "2 hard quantity mismatch(es)" }],
      },
    };
    const badge = deriveHealthBadge({
      rowsHealth: summarizeRowsHealth(rows),
      validation,
    });
    expect(badge.level).toBe(HEALTH_LEVEL.DRIFT);
    expect(badge.validated).toBe(true);
    expect(badge.tripped).toBe(true);
    expect(badge.reasons.map((r) => r.code)).toContain("hard-qty-mismatch");
    // the cache warning is still reported alongside the drift reason
    expect(badge.reasons.map((r) => r.code)).toContain("cache-incomplete");
  });

  it("stays ok when a validation report shows no drift", () => {
    const badge = deriveHealthBadge({
      rowsHealth: summarizeRowsHealth([lsRow()]),
      validation: { drift: { tripped: false, reasons: [] } },
    });
    expect(badge.level).toBe(HEALTH_LEVEL.OK);
    expect(badge.validated).toBe(true);
  });

  it("warns when report totals are degraded", () => {
    const badge = deriveHealthBadge({
      rowsHealth: summarizeRowsHealth([lsRow()]),
      rollupDegraded: true,
    });
    expect(badge.level).toBe(HEALTH_LEVEL.WARN);
    expect(badge.reasons.map((r) => r.code)).toContain("rollup-degraded");
  });

  it("uses the documented default cache warn threshold", () => {
    expect(DEFAULT_CACHE_WARN_PCT).toBeCloseTo(0.995, 5);
  });
});

describe("derivedFlowStock & inventoryMismatchBreakdown", () => {
  it("floors derived stock at zero and computes the live-vs-derived delta", () => {
    const row = lsRow({ receivedRaw: 5, sold: 2, onSale: 1, retQty: 1, liveOnHand: 3 });
    expect(derivedFlowStock(row)).toBe(1); // 5 - 2 - 1 - 1
    const b = inventoryMismatchBreakdown(row);
    expect(b).toMatchObject({
      live: 3,
      derived: 1,
      delta: 2,
      received: 5,
      sold: 2,
      onSale: 1,
      returned: 1,
    });
  });

  it("reports a null live value when liveOnHand is missing", () => {
    const b = inventoryMismatchBreakdown(lsRow({ liveOnHand: null }));
    expect(b.live).toBeNull();
    expect(b.delta).toBeNull();
  });

  it("falls back to live on-hand for consignment/migrated no-PO products (Q1b)", () => {
    // receivedRaw 0 → no PO record; derived tracks live on-hand (net of any
    // vendor returns), so the product is NOT flagged as a mismatch.
    const row = lsRow({ receivedRaw: 0, sold: 3, onSale: 1, retQty: 0, liveOnHand: 5 });
    expect(derivedFlowStock(row)).toBe(5); // == live, not 0 - 3 - 1 - 0
    expect(inventoryMismatchBreakdown(row).delta).toBe(0);
  });
});

describe("adjustedCount — material gating (Q1a)", () => {
  it("exposes the documented material-delta thresholds", () => {
    expect(MATERIAL_UNIT_DELTA).toBe(2);
    expect(MATERIAL_DOLLAR_DELTA).toBe(25);
  });

  it("counts only LS rows whose live-vs-derived delta is material", () => {
    // Semantics changed in Q1a: a flagged row only counts when its delta is
    // material (≥2 units OR ≥$25). The mismatch row has live 9 vs derived 4.
    expect(
      adjustedCount([
        lsRow({ pid: "p1", inventoryMismatch: true, liveOnHand: 9, price: 100 }), // Δ5 units
        lsRow({ pid: "p2", inventoryMismatch: false }),
        lsRow({ pid: null, inventoryMismatch: true, liveOnHand: 9 }), // datatail-only, ignored
      ])
    ).toBe(1);
  });

  it("ignores sub-threshold deltas (off-by-one on a cheap item)", () => {
    // live 5 vs derived 4 → Δ1 unit, $10 at price 10 → below both thresholds.
    const row = lsRow({ pid: "p1", inventoryMismatch: true, liveOnHand: 5, price: 10 });
    expect(isMaterialMismatch(row)).toBe(false);
    expect(adjustedCount([row])).toBe(0);
  });

  it("counts a 1-unit delta when it crosses the dollar threshold", () => {
    // live 5 vs derived 4 → Δ1 unit but $300 at price 300 → material by dollars.
    const row = lsRow({ pid: "p1", inventoryMismatch: true, liveOnHand: 5, price: 300 });
    expect(isMaterialMismatch(row)).toBe(true);
    expect(adjustedCount([row])).toBe(1);
  });
});

describe("uncategorizedRows (Q4)", () => {
  it("returns only deptId __none__ rows with display fields", () => {
    const rows = [
      {
        pid: "p1",
        sku: "x/s2601",
        deptId: "__none__",
        vendorName: "Acme",
        orderedQty: 3,
        receivedRaw: 2,
        sold: 1,
      },
      { pid: "p2", sku: "y/s2601", deptId: "alley", vendorName: "Other Co" }, // categorized
      { pid: "p3", sku: "z/s2601", deptId: "__none__" }, // missing vendor → Unassigned
      null,
    ];
    const out = uncategorizedRows(rows, "spring26");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      pid: "p1",
      sku: "x/s2601",
      vendorName: "Acme",
      season: "spring26",
      ordered: 3,
      received: 2,
      sold: 1,
    });
    expect(out[1].vendorName).toBe("Unassigned");
    expect(out[1].season).toBe("spring26");
  });

  it("handles empty/nullish input", () => {
    expect(uncategorizedRows()).toEqual([]);
    expect(uncategorizedRows([])).toEqual([]);
  });
});

describe("adjustedBadgeTooltip", () => {
  it("includes the count and explains the manual-adjustment meaning", () => {
    const t = adjustedBadgeTooltip(33);
    expect(t).toContain("33 product(s)");
    expect(t).toContain("received − sold − on sale − returned");
    expect(t).toContain("manual inventory");
    expect(t).toContain("source of truth");
  });

  it("coerces a nullish count to 0", () => {
    expect(adjustedBadgeTooltip()).toContain("0 product(s)");
  });
});
