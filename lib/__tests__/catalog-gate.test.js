import { shouldFullCatalogScan } from "../catalog-gate";

describe("shouldFullCatalogScan", () => {
  it("never runs when /search is disabled", () => {
    expect(
      shouldFullCatalogScan({ searchEnabled: false, fullRebuild: true, priorPidCount: 0 })
    ).toBe(false);
    expect(
      shouldFullCatalogScan({
        searchEnabled: false,
        fullRebuild: true,
        priorPidCount: 0,
        force: true,
      })
    ).toBe(false);
  });

  it("skips the per-season scan when the season already has pids", () => {
    expect(
      shouldFullCatalogScan({ searchEnabled: true, fullRebuild: true, priorPidCount: 5 })
    ).toBe(false);
  });

  it("runs as a cold fallback when there are no prior/bucketed pids", () => {
    expect(
      shouldFullCatalogScan({ searchEnabled: true, fullRebuild: true, priorPidCount: 0 })
    ).toBe(true);
  });

  it("does not run a heavy catalog scan on an incremental run with no pids", () => {
    expect(
      shouldFullCatalogScan({ searchEnabled: true, fullRebuild: false, priorPidCount: 0 })
    ).toBe(false);
  });

  it("force overrides even when pids exist", () => {
    expect(
      shouldFullCatalogScan({
        searchEnabled: true,
        fullRebuild: false,
        priorPidCount: 100,
        force: true,
      })
    ).toBe(true);
  });

  it("defaults to false with no args", () => {
    expect(shouldFullCatalogScan()).toBe(false);
  });
});
