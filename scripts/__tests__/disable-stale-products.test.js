// Unit tests for the pure helpers behind scripts/disable-stale-products.mjs.
// These never touch LS or KV (the script only reaches the network inside main(),
// which is guarded so importing the module is side-effect free).
import {
  isConsignmentSku,
  recencyCutoffMs,
  isSaleWithinWindow,
  candidateReason,
  earlierIsoDate,
  parseArgs,
} from "../disable-stale-products.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgoMs = (days) => NOW - days * DAY;

// 6-month consignment window, 12-month regular window.
const CONSIGNMENT_CUTOFF = daysAgoMs(182);
const REGULAR_CUTOFF = daysAgoMs(365);

function product(overrides = {}) {
  return {
    id: "p1",
    sku: "sfoo/s2601",
    active: true,
    is_active: true,
    has_inventory: true,
    deleted_at: null,
    ...overrides,
  };
}

function splitContext({ onHand = [], lastSale = [], open = [], season = [] } = {}) {
  return {
    onHand: new Map(onHand),
    lastSaleByPid: new Map(lastSale),
    regularCutoffMs: REGULAR_CUTOFF,
    consignmentCutoffMs: CONSIGNMENT_CUTOFF,
    openConsignmentPids: new Set(open),
    activeSeasonPids: new Set(season),
  };
}

describe("isConsignmentSku", () => {
  it("matches item codes starting with C (case-insensitive, trimmed)", () => {
    expect(isConsignmentSku("cfoo/s2601")).toBe(true);
    expect(isConsignmentSku("Cfoo/s2601")).toBe(true);
    expect(isConsignmentSku("  cbar/f26")).toBe(true);
  });

  it("rejects non-C and empty SKUs", () => {
    expect(isConsignmentSku("sphoenix/rs260101")).toBe(false);
    expect(isConsignmentSku("s980621/s260108")).toBe(false);
    expect(isConsignmentSku("")).toBe(false);
    expect(isConsignmentSku(null)).toBe(false);
    expect(isConsignmentSku(undefined)).toBe(false);
  });
});

describe("recencyCutoffMs", () => {
  const cutoffs = { regularCutoffMs: REGULAR_CUTOFF, consignmentCutoffMs: CONSIGNMENT_CUTOFF };

  it("uses the consignment cutoff for C SKUs", () => {
    expect(recencyCutoffMs("cfoo/s26", cutoffs)).toBe(CONSIGNMENT_CUTOFF);
  });

  it("uses the regular cutoff for everything else", () => {
    expect(recencyCutoffMs("sfoo/s26", cutoffs)).toBe(REGULAR_CUTOFF);
  });
});

describe("isSaleWithinWindow", () => {
  it("is true when the sale is at or after the cutoff", () => {
    expect(isSaleWithinWindow(daysAgoMs(10), CONSIGNMENT_CUTOFF)).toBe(true);
    expect(isSaleWithinWindow(CONSIGNMENT_CUTOFF, CONSIGNMENT_CUTOFF)).toBe(true);
  });

  it("is false when the sale predates the cutoff or is missing", () => {
    expect(isSaleWithinWindow(daysAgoMs(200), CONSIGNMENT_CUTOFF)).toBe(false);
    expect(isSaleWithinWindow(null, CONSIGNMENT_CUTOFF)).toBe(false);
    expect(isSaleWithinWindow(undefined, CONSIGNMENT_CUTOFF)).toBe(false);
    expect(isSaleWithinWindow(NaN, CONSIGNMENT_CUTOFF)).toBe(false);
  });
});

describe("earlierIsoDate", () => {
  it("returns the earlier of two ISO dates", () => {
    expect(earlierIsoDate("2025-12-01", "2026-06-01")).toBe("2025-12-01");
    expect(earlierIsoDate("2026-06-01", "2025-12-01")).toBe("2025-12-01");
  });
});

describe("parseArgs", () => {
  it("parses --no-season-guard without forcing live sales", () => {
    const args = parseArgs(["--since", "2025-06-16", "--no-season-guard", "--write"]);

    expect(args.noSeasonGuard).toBe(true);
    expect(args.since).toBe("2025-06-16");
    expect(args.write).toBe(true);
    expect(args.freshSales).toBe(false);
  });
});

describe("candidateReason — split consignment windows", () => {
  it("guards a consignment SKU sold within 6 months", () => {
    const ctx = splitContext({ lastSale: [["p1", daysAgoMs(120)]] });
    expect(candidateReason(product({ sku: "cfoo/s26" }), ctx)).toBe("recentSale");
  });

  it("retires a consignment SKU whose last sale is 8 months ago (>6mo)", () => {
    // Sold 240 days ago: inside the 12-month regular window but outside the 6-month
    // consignment window, so a C SKU becomes a candidate.
    const ctx = splitContext({ lastSale: [["p1", daysAgoMs(240)]] });
    expect(candidateReason(product({ sku: "cfoo/s26" }), ctx)).toBe("candidate");
  });

  it("keeps a regular SKU sold 8 months ago (within 12mo)", () => {
    const ctx = splitContext({ lastSale: [["p1", daysAgoMs(240)]] });
    expect(candidateReason(product({ sku: "sfoo/s26" }), ctx)).toBe("recentSale");
  });

  it("retires a regular SKU with no sale in the lookback window", () => {
    const ctx = splitContext({ lastSale: [] });
    expect(candidateReason(product({ sku: "sfoo/s26" }), ctx)).toBe("candidate");
  });

  it("allows an otherwise stale report-season product when the season guard is empty", () => {
    const ctx = splitContext({ lastSale: [], season: [] });
    expect(candidateReason(product({ sku: "sfoo/s26" }), ctx)).toBe("candidate");
  });

  it("still respects stock, open-consignment, and active-season guards", () => {
    expect(
      candidateReason(product({ sku: "cfoo/s26" }), splitContext({ onHand: [["p1", 3]] }))
    ).toBe("inStock");
    expect(
      candidateReason(product({ sku: "cfoo/s26" }), splitContext({ open: ["p1"] }))
    ).toBe("openConsignment");
    expect(
      candidateReason(product({ sku: "cfoo/s26" }), splitContext({ season: ["p1"] }))
    ).toBe("activeSeasonGuard");
  });

  it("skips inactive, deleted, and non-inventory products before windows apply", () => {
    const ctx = splitContext();
    expect(candidateReason(product({ active: false }), ctx)).toBe("inactive");
    expect(candidateReason(product({ deleted_at: "2026-01-01" }), ctx)).toBe("deleted");
    expect(candidateReason(product({ has_inventory: false }), ctx)).toBe("nonInventory");
  });
});

describe("candidateReason — legacy single-window mode", () => {
  function legacyContext({ onHand = [], sold = [], open = [], season = [] } = {}) {
    return {
      onHand: new Map(onHand),
      recentSalePids: new Set(sold),
      openConsignmentPids: new Set(open),
      activeSeasonPids: new Set(season),
    };
  }

  it("guards any product in the ever-sold set", () => {
    expect(candidateReason(product({ sku: "cfoo/s26" }), legacyContext({ sold: ["p1"] }))).toBe(
      "recentSale"
    );
  });

  it("flags an unsold, zero-stock product as a candidate", () => {
    expect(candidateReason(product(), legacyContext())).toBe("candidate");
  });
});

describe("candidateReason — consignment-only mode", () => {
  function consignmentOnlyContext({ onHand = [], sold = [], open = [], season = [] } = {}) {
    return {
      consignmentOnly: true,
      onHand: new Map(onHand),
      recentSalePids: new Set(sold),
      openConsignmentPids: new Set(open),
      activeSeasonPids: new Set(season),
    };
  }

  it("skips non-consignment SKUs entirely", () => {
    expect(candidateReason(product({ sku: "sfoo/s26" }), consignmentOnlyContext())).toBe(
      "nonConsignment"
    );
  });

  it("flags an unsold, zero-stock consignment SKU as a candidate", () => {
    expect(candidateReason(product({ sku: "cfoo/s26" }), consignmentOnlyContext())).toBe(
      "candidate"
    );
  });

  it("still guards a recently sold consignment SKU", () => {
    expect(
      candidateReason(product({ sku: "cfoo/s26" }), consignmentOnlyContext({ sold: ["p1"] }))
    ).toBe("recentSale");
  });
});
