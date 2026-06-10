import {
  pidsMissingSku,
  recoverSkuMetadata,
  selectCostBackfillPids,
} from "../product-metadata";

describe("recoverSkuMetadata", () => {
  it("fills pidToSku and a name fallback from skuToPid without clobbering existing values", () => {
    const pidToSku = { p1: "real/s261" };
    const pidToName = { p1: "Real Product Name" };
    const skuToPid = {
      "real/s261": "p1",
      "mgoodwood/pf26": "p2",
      "mgrantham/pf26": "p3",
    };

    const recovered = recoverSkuMetadata({ skuToPid, pidToSku, pidToName });

    expect(recovered).toBe(2); // p2, p3 — p1 already had a SKU
    expect(pidToSku).toEqual({
      p1: "real/s261",
      p2: "mgoodwood/pf26",
      p3: "mgrantham/pf26",
    });
    // Existing real name preserved; missing names fall back to SKU
    expect(pidToName.p1).toBe("Real Product Name");
    expect(pidToName.p2).toBe("mgoodwood/pf26");
    expect(pidToName.p3).toBe("mgrantham/pf26");
  });

  it("ignores empty sku or pid entries and tolerates missing maps", () => {
    const skuToPid = { "": "p9", validsku: "", good: "p10" };
    const pidToSku = {};
    const pidToName = {};
    const recovered = recoverSkuMetadata({ skuToPid, pidToSku, pidToName });
    expect(recovered).toBe(1);
    expect(pidToSku).toEqual({ p10: "good" });
    expect(() => recoverSkuMetadata()).not.toThrow();
  });
});

describe("pidsMissingSku", () => {
  it("returns only pids without a recovered SKU", () => {
    const seasonPids = ["p1", "p2", "p3"];
    const pidToSku = { p1: "a/s261", p3: "c/s261" };
    expect(pidsMissingSku(seasonPids, pidToSku)).toEqual(["p2"]);
  });
});

describe("selectCostBackfillPids", () => {
  const seasonPids = ["p1", "p2", "p3", "p4", "p5"];
  const pidToPrice = { p1: 100, p2: 0, p3: 200, p4: 50, p5: 75 };

  it("selects priced pids that have not been attempted yet", () => {
    const costDone = { p1: 1 };
    expect(selectCostBackfillPids(seasonPids, { pidToPrice, costDone }, 10)).toEqual([
      "p3",
      "p4",
      "p5",
    ]);
  });

  it("skips unpriced pids so we never burn lookups on $0-price rows", () => {
    expect(selectCostBackfillPids(seasonPids, { pidToPrice, costDone: {} }, 10)).not.toContain("p2");
  });

  it("respects the per-scan limit so the scan can still finalize", () => {
    const result = selectCostBackfillPids(seasonPids, { pidToPrice, costDone: {} }, 2);
    expect(result).toEqual(["p1", "p3"]);
  });

  it("returns nothing once every priced pid is marked done (converges across scans)", () => {
    const costDone = { p1: 1, p3: 1, p4: 1, p5: 1 };
    expect(selectCostBackfillPids(seasonPids, { pidToPrice, costDone }, 10)).toEqual([]);
  });
});
