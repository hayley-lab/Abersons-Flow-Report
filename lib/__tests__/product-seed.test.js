import {
  filterRestoredSeasonPids,
  pidToSkuFromSources,
  restoredPidMatchesSeason,
} from "../product-seed";

describe("pidToSkuFromSources", () => {
  it("builds a pid SKU map from direct maps and inverted skuToPid maps", () => {
    const pidToSku = pidToSkuFromSources(
      { skuToPid: { "vendor/s2601": "p1", "vendor/f2601": "p2" } },
      { pidToSku: { p2: "vendor/s2602" } }
    );

    expect(pidToSku).toEqual({
      p1: "vendor/s2601",
      p2: "vendor/s2602",
    });
  });
});

describe("restored pid season gating", () => {
  it("keeps known matching pids and unknown-SKU pids", () => {
    const pidToSku = {
      pSpring: "vendor/s2601",
      pFall: "vendor/f2601",
    };

    expect(
      filterRestoredSeasonPids(["pSpring", "pFall", "pUnknown"], "spring26", pidToSku)
    ).toEqual(["pSpring", "pUnknown"]);
  });

  it("skips known restored pids whose SKU belongs to another season", () => {
    expect(restoredPidMatchesSeason("pFall", "prespring27", { pFall: "vendor/f2601" })).toBe(false);
  });
});
