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

  // Regression: a Lightspeed SKU re-coded from "/f26" to "/ps27" (Frank & Eileen
  // PO 85626, Aug 2026) left the prior scan's pid maps carrying the OLD SKU, so
  // fall26 kept restoring the pid and counted the same PO in both seasons.
  it("retires a re-coded pid the catalog no longer lists for the season", () => {
    const priorPidToSku = { pRecoded: "neileen3/f26", pStillFall: "nperry/f261" };
    const fallCatalogPids = new Set(["pStillFall"]);

    expect(
      filterRestoredSeasonPids(["pRecoded", "pStillFall"], "fall26", priorPidToSku, {
        catalogPidSet: fallCatalogPids,
      })
    ).toEqual(["pStillFall"]);
  });

  it("keeps a re-coded pid in the season the catalog now lists it under", () => {
    expect(
      filterRestoredSeasonPids(
        ["pRecoded"],
        "prespring27",
        { pRecoded: "neileen3/ps27" },
        {
          catalogPidSet: new Set(["pRecoded"]),
        }
      )
    ).toEqual(["pRecoded"]);
  });

  it("drops unknown-SKU pids the catalog does not list, so a PO re-registers them", () => {
    expect(
      filterRestoredSeasonPids(["pUnknown"], "fall26", {}, { catalogPidSet: new Set() })
    ).toEqual([]);
  });

  it("keeps the SKU-only gate when no catalog bucket is available", () => {
    expect(
      filterRestoredSeasonPids(["pRecoded", "pUnknown"], "fall26", { pRecoded: "neileen3/f26" })
    ).toEqual(["pRecoded", "pUnknown"]);
  });
});
