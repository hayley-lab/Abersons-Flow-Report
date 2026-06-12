// Unit tests for the pure Data Health helpers that drive the in-app drift
// surface. These never touch LS/KV — the badge logic is derived from canonical
// rows plus an optional /api/scan/validate report shape.
import {
  HEALTH_LEVEL,
  DEFAULT_CACHE_WARN_PCT,
  summarizeRowsHealth,
  deriveHealthBadge,
  derivedFlowStock,
  inventoryMismatchBreakdown,
  adjustedCount,
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
    expect(h.cacheCompletePct).toBeCloseTo(2 / 3, 5);
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
});

describe("adjustedCount", () => {
  it("counts only LS rows flagged inventoryMismatch", () => {
    expect(
      adjustedCount([
        lsRow({ pid: "p1", inventoryMismatch: true }),
        lsRow({ pid: "p2", inventoryMismatch: false }),
        lsRow({ pid: null, inventoryMismatch: true }), // datatail-only, ignored
      ])
    ).toBe(1);
  });
});
