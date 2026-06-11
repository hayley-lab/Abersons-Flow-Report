import { catalogIsComplete, planSeasonWork, resolveLastFullTs } from "../scan-orchestrator";

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;
const NOW = 1_000_000_000;

function plan(overrides = {}) {
  return planSeasonWork({
    now: NOW,
    rescanIntervalMs: HOUR,
    fullRebuildIntervalMs: WEEK,
    ...overrides,
  });
}

describe("catalogIsComplete", () => {
  it("is true only when cacheComplete === true", () => {
    expect(catalogIsComplete({ cacheComplete: true })).toBe(true);
  });

  it("treats missing/failed/incomplete responses as not complete", () => {
    expect(catalogIsComplete(null)).toBe(false);
    expect(catalogIsComplete(undefined)).toBe(false);
    expect(catalogIsComplete({})).toBe(false);
    expect(catalogIsComplete({ cacheComplete: false })).toBe(false);
    expect(catalogIsComplete({ error: "boom" })).toBe(false);
    // A drained sync run that isn't cache-complete still doesn't count.
    expect(catalogIsComplete({ complete: true, cacheComplete: false })).toBe(false);
  });
});

describe("resolveLastFullTs", () => {
  it("uses the standalone scan:lastFull key when present", () => {
    expect(resolveLastFullTs(NOW - HOUR, null)).toBe(NOW - HOUR);
    // Standalone key wins even if the job also embeds a (stale) value.
    expect(resolveLastFullTs(NOW, { lastFull: NOW - WEEK })).toBe(NOW);
  });

  it("falls back to the value embedded in the done job record when the key lags", () => {
    expect(resolveLastFullTs(null, { phase: "done", lastFull: NOW - 60_000 })).toBe(NOW - 60_000);
    expect(resolveLastFullTs(0, { phase: "done", lastFull: NOW })).toBe(NOW);
    expect(resolveLastFullTs(undefined, { lastFull: NOW })).toBe(NOW);
  });

  it("returns null when neither source has a usable timestamp", () => {
    expect(resolveLastFullTs(null, null)).toBe(null);
    expect(resolveLastFullTs(0, {})).toBe(null);
    expect(resolveLastFullTs(undefined, { phase: "done" })).toBe(null);
  });
});

describe("done-race regression — just-finished full season is not restarted", () => {
  it("skips a done full season whose lastFull is only in the job record (key lagging)", () => {
    // Simulates the race: a season finished a full rebuild this cycle and embedded
    // lastFull in its done job record, but the standalone scan:lastFull key has not
    // propagated yet. The orchestrator must treat the rebuild as satisfied (skip),
    // never plan restart:"1".
    const job = { phase: "done", scanMode: "full", ts: NOW - 30_000, lastFull: NOW - 30_000 };
    const lastFullTs = resolveLastFullTs(null, job); // standalone key missing/stale
    const out = plan({
      phase: job.phase,
      scanMode: job.scanMode,
      msSinceScan: 30_000,
      lastFullTs,
      rebuildTs: NOW - 10 * 60_000,
    });
    expect(out).toEqual({ skip: true, restart: "0", mode: "full" });
  });
});

describe("planSeasonWork — explicit restartAll", () => {
  it("forces a fresh full scan regardless of recency", () => {
    expect(plan({ restartAll: true, phase: "done", msSinceScan: 1000 })).toEqual({
      skip: false,
      restart: "1",
      mode: "full",
    });
  });
});

describe("planSeasonWork — pending rebuild intent (survives catalog yields)", () => {
  it("forces a fresh full rebuild for an idle season not yet rebuilt", () => {
    // rebuild requested at NOW-5min; season last full rebuild was last week.
    const out = plan({
      phase: "done",
      msSinceScan: 60_000, // recent — would normally be skipped
      lastFullTs: NOW - WEEK,
      rebuildTs: NOW - 5 * 60_000,
    });
    expect(out).toEqual({ skip: false, restart: "1", mode: "full" });
  });

  it("continues an in-progress full rebuild started THIS cycle without wiping", () => {
    const out = plan({
      phase: "consignments",
      scanMode: "full",
      lastFullTs: NOW - WEEK,
      rebuildTs: NOW - 5 * 60_000,
      startedAt: NOW - 4 * 60_000, // began after the rebuild was requested
    });
    expect(out).toEqual({ skip: false, restart: "0", mode: "full" });
  });

  it("wipes a STALE full scan left over from a prior cycle", () => {
    // A season grinding on a full scan that began long before this rebuild
    // request must be restarted so it re-seeds from the freshly built shared
    // catalog buckets instead of continuing the slow per-season /search.
    const out = plan({
      phase: "products_seed",
      scanMode: "full",
      lastFullTs: NOW - WEEK,
      rebuildTs: NOW - 5 * 60_000,
      startedAt: NOW - 3 * HOUR, // predates the rebuild request → stale
    });
    expect(out).toEqual({ skip: false, restart: "1", mode: "full" });
  });

  it("wipes a mid-full season with no startedAt recorded (treat as stale)", () => {
    const out = plan({
      phase: "products_seed",
      scanMode: "full",
      lastFullTs: NOW - WEEK,
      rebuildTs: NOW - 5 * 60_000,
      startedAt: null,
    });
    expect(out).toEqual({ skip: false, restart: "1", mode: "full" });
  });

  it("restarts a mid-incremental season as a full rebuild when one is owed", () => {
    const out = plan({
      phase: "sales",
      scanMode: "incremental",
      lastFullTs: NOW - WEEK,
      rebuildTs: NOW - 5 * 60_000,
    });
    expect(out).toEqual({ skip: false, restart: "1", mode: "full" });
  });

  it("does not force a season that already rebuilt after the request", () => {
    // lastFullTs newer than rebuildTs → satisfied, falls through to normal rules.
    const out = plan({
      phase: "done",
      msSinceScan: 60_000,
      lastFullTs: NOW - 60_000,
      rebuildTs: NOW - 5 * 60_000,
    });
    expect(out).toEqual({ skip: true, restart: "0", mode: "incremental" });
  });
});

describe("planSeasonWork — normal scheduling", () => {
  it("skips an idle season scanned within the rescan interval", () => {
    expect(plan({ phase: "done", msSinceScan: 30 * 60_000, scanMode: "incremental" })).toEqual({
      skip: true,
      restart: "0",
      mode: "incremental",
    });
  });

  it("runs a full rebuild when the weekly interval has elapsed", () => {
    expect(
      plan({ phase: "done", msSinceScan: 2 * HOUR, lastFullTs: NOW - WEEK - 1, hasData: true })
    ).toEqual({ skip: false, restart: "1", mode: "full" });
  });

  it("runs incremental when due for a rescan but not for a full rebuild", () => {
    expect(
      plan({ phase: "done", msSinceScan: 2 * HOUR, lastFullTs: NOW - HOUR, hasData: true })
    ).toEqual({ skip: false, restart: "0", mode: "incremental" });
  });

  it("runs a full scan for an idle season that has no data yet", () => {
    expect(plan({ phase: null, msSinceScan: Infinity, hasData: false })).toEqual({
      skip: false,
      restart: "1",
      mode: "full",
    });
  });

  it("continues a mid-scan season in its current mode", () => {
    expect(plan({ phase: "consignments", scanMode: "incremental" })).toEqual({
      skip: false,
      restart: "0",
      mode: "incremental",
    });
  });
});
