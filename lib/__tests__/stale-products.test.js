import {
  candidateReasonFromMeta,
  candidateReasonFromProduct,
  isConsignmentSku,
  isSaleWithinWindow,
  recencyCutoffMs,
} from "../stale-products";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgoMs = (days) => NOW - days * DAY;
const CONSIGNMENT_CUTOFF = daysAgoMs(182);
const REGULAR_CUTOFF = daysAgoMs(365);

function context({ onHand = [], lastSale = [], open = [], season = [] } = {}) {
  return {
    onHand: new Map(onHand),
    lastSaleByPid: new Map(lastSale),
    regularCutoffMs: REGULAR_CUTOFF,
    consignmentCutoffMs: CONSIGNMENT_CUTOFF,
    openConsignmentPids: new Set(open),
    activeSeasonPids: new Set(season),
  };
}

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

function meta(overrides = {}) {
  return {
    sku: "sfoo/s2601",
    active: true,
    hasInventory: true,
    deletedAt: null,
    ...overrides,
  };
}

describe("stale product helpers", () => {
  it("identifies consignment SKUs case-insensitively", () => {
    expect(isConsignmentSku("cfoo/s2601")).toBe(true);
    expect(isConsignmentSku(" Cfoo/s2601")).toBe(true);
    expect(isConsignmentSku("sfoo/s2601")).toBe(false);
  });

  it("uses the consignment cutoff only for C SKUs", () => {
    const cutoffs = { regularCutoffMs: REGULAR_CUTOFF, consignmentCutoffMs: CONSIGNMENT_CUTOFF };
    expect(recencyCutoffMs("cfoo/s2601", cutoffs)).toBe(CONSIGNMENT_CUTOFF);
    expect(recencyCutoffMs("sfoo/s2601", cutoffs)).toBe(REGULAR_CUTOFF);
  });

  it("checks sale recency at the cutoff boundary", () => {
    expect(isSaleWithinWindow(CONSIGNMENT_CUTOFF, CONSIGNMENT_CUTOFF)).toBe(true);
    expect(isSaleWithinWindow(daysAgoMs(240), CONSIGNMENT_CUTOFF)).toBe(false);
    expect(isSaleWithinWindow(null, CONSIGNMENT_CUTOFF)).toBe(false);
  });
});

describe("candidateReasonFromProduct", () => {
  it("matches the last large inactivation: no stock, old sale, no open consignment", () => {
    expect(candidateReasonFromProduct(product(), context())).toBe("candidate");
  });

  it("guards stock, recent sales, open consignments, and active seasons", () => {
    expect(candidateReasonFromProduct(product(), context({ onHand: [["p1", 1]] }))).toBe("inStock");
    expect(candidateReasonFromProduct(product(), context({ lastSale: [["p1", daysAgoMs(10)]] }))).toBe(
      "recentSale"
    );
    expect(candidateReasonFromProduct(product(), context({ open: ["p1"] }))).toBe(
      "openConsignment"
    );
    expect(candidateReasonFromProduct(product(), context({ season: ["p1"] }))).toBe(
      "activeSeasonGuard"
    );
  });

  it("uses the shorter consignment window when supplied", () => {
    expect(
      candidateReasonFromProduct(product({ sku: "cfoo/s2601" }), context({ lastSale: [["p1", daysAgoMs(240)]] }))
    ).toBe("candidate");
    expect(
      candidateReasonFromProduct(product({ sku: "sfoo/s2601" }), context({ lastSale: [["p1", daysAgoMs(240)]] }))
    ).toBe("recentSale");
  });

  it("skips non-candidates before activity checks", () => {
    const ctx = context({ lastSale: [["p1", daysAgoMs(900)]] });
    expect(candidateReasonFromProduct(product({ active: false }), ctx)).toBe("inactive");
    expect(candidateReasonFromProduct(product({ deleted_at: "2026-01-01" }), ctx)).toBe("deleted");
    expect(candidateReasonFromProduct(product({ has_inventory: false }), ctx)).toBe("nonInventory");
  });
});

describe("candidateReasonFromMeta", () => {
  it("evaluates cached catalog metadata with the same guard order", () => {
    expect(candidateReasonFromMeta("p1", meta(), context())).toBe("candidate");
    expect(candidateReasonFromMeta("p1", meta({ active: false }), context())).toBe("inactive");
    expect(candidateReasonFromMeta("p1", meta({ deletedAt: "2026-01-01" }), context())).toBe("deleted");
    expect(candidateReasonFromMeta("p1", meta({ hasInventory: false }), context())).toBe(
      "nonInventory"
    );
  });

  it("supports the season guard being intentionally empty", () => {
    expect(candidateReasonFromMeta("p1", meta(), context({ season: [] }))).toBe("candidate");
  });
});
