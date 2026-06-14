import {
  buildDriverResults,
  cacheDriveDeadline,
  catalogIsComplete,
  computeAllDone,
  planSeasonWork,
  resolveLastFullTs,
  shouldRetrySeasonStep,
  shouldSkipCompletedDrive,
  shouldYieldForCache,
} from "../scan-orchestrator";

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

describe("cacheDriveDeadline — driver path gets a real budget (af1f28b regression)", () => {
  const DRIVE_MS = 75 * 1000;
  const REQUEST_TIMEOUT_MS = 55 * 1000;
  const RESPONSE_OVERHEAD_MS = 5 * 1000;
  const OVERALL_MS = 120 * 1000;

  // Mirror of cron/scan.js hasBudgetFor for the gated (cron/driver) path.
  function hasBudgetFor(now, deadline, overallDeadline) {
    return now + REQUEST_TIMEOUT_MS + RESPONSE_OVERHEAD_MS < Math.min(deadline, overallDeadline);
  }

  it("leaves room for at least one cache chunk at the start of an invocation", () => {
    const now = NOW;
    const overallDeadline = now + OVERALL_MS;
    const deadline = cacheDriveDeadline({ now, driveMs: DRIVE_MS, overallDeadline });
    // The regression set the driver deadline to `now` (zero budget); the fix
    // derives it from overallDeadline so the first chunk passes the budget gate.
    expect(deadline).toBe(now + DRIVE_MS);
    expect(hasBudgetFor(now, deadline, overallDeadline)).toBe(true);
  });

  it("never exceeds the shared overall deadline", () => {
    const now = NOW;
    const overallDeadline = now + 30 * 1000; // overall budget tighter than DRIVE_MS
    const deadline = cacheDriveDeadline({ now, driveMs: DRIVE_MS, overallDeadline });
    expect(deadline).toBe(overallDeadline);
  });

  it("refuses a new chunk once the remaining budget is too small (bounds response time)", () => {
    const start = NOW;
    const overallDeadline = start + OVERALL_MS;
    const now = start + 70 * 1000; // only 50s left — less than timeout + overhead
    const deadline = cacheDriveDeadline({ now, driveMs: DRIVE_MS, overallDeadline });
    expect(hasBudgetFor(now, deadline, overallDeadline)).toBe(false);
  });

  it("regression contrast: a zero-length (Date.now()) deadline refuses every chunk", () => {
    const now = NOW;
    const overallDeadline = now + OVERALL_MS;
    // The buggy driver path used `Date.now()` as the deadline.
    expect(hasBudgetFor(now, now, overallDeadline)).toBe(false);
  });
});

describe("shouldYieldForCache — KV-complete cache is treated as complete", () => {
  it("does not yield when the in-call drive result reports cacheComplete", () => {
    expect(shouldYieldForCache({ driveResult: { cacheComplete: true }, kvComplete: false })).toBe(
      false
    );
  });

  it("does not yield when KV meta says complete, even if the drive returned null", () => {
    // Driver path: drive skipped for budget or hit a transient error → null,
    // but the cache was finished in a prior call. Must proceed, not idle-loop.
    expect(shouldYieldForCache({ driveResult: null, kvComplete: true })).toBe(false);
  });

  it("yields only when neither the drive nor KV reports completeness", () => {
    expect(shouldYieldForCache({ driveResult: null, kvComplete: false })).toBe(true);
    expect(shouldYieldForCache({ driveResult: { cacheComplete: false }, kvComplete: false })).toBe(
      true
    );
    expect(shouldYieldForCache({ driveResult: { error: "boom" }, kvComplete: false })).toBe(true);
  });

  it("defaults kvComplete to false when omitted", () => {
    expect(shouldYieldForCache({ driveResult: null })).toBe(true);
  });
});

describe("shouldSkipCompletedDrive — driver path skips already-built caches", () => {
  it("skips on the driver/UI path when the cache is complete in KV", () => {
    expect(
      shouldSkipCompletedDrive({ kvComplete: true, resetRequested: false, loopInternally: false })
    ).toBe(true);
  });

  it("never skips the internally-looping cron path (keeps incremental top-up fresh)", () => {
    expect(
      shouldSkipCompletedDrive({ kvComplete: true, resetRequested: false, loopInternally: true })
    ).toBe(false);
  });

  it("never skips when an explicit reset was requested, even if KV says complete", () => {
    expect(
      shouldSkipCompletedDrive({ kvComplete: true, resetRequested: true, loopInternally: false })
    ).toBe(false);
  });

  it("never skips when the cache is not yet complete in KV", () => {
    expect(
      shouldSkipCompletedDrive({ kvComplete: false, resetRequested: false, loopInternally: false })
    ).toBe(false);
  });

  it("defaults to not skipping when fields are omitted", () => {
    expect(shouldSkipCompletedDrive({})).toBe(false);
  });
});

describe("shouldRetrySeasonStep — transient driver failures don't fail the weekly", () => {
  it("driver path retries a transient failure until the attempt cap", () => {
    expect(
      shouldRetrySeasonStep({ loopInternally: false, transient: true, attempts: 1, maxAttempts: 3 })
    ).toBe(true);
    expect(
      shouldRetrySeasonStep({ loopInternally: false, transient: true, attempts: 2, maxAttempts: 3 })
    ).toBe(true);
    expect(
      shouldRetrySeasonStep({ loopInternally: false, transient: true, attempts: 3, maxAttempts: 3 })
    ).toBe(false);
  });

  it("driver path never retries a terminal failure (phase:error / 4xx)", () => {
    expect(
      shouldRetrySeasonStep({
        loopInternally: false,
        transient: false,
        attempts: 1,
        maxAttempts: 3,
      })
    ).toBe(false);
  });

  it("the internal cron path always keeps retrying (unchanged behavior)", () => {
    expect(
      shouldRetrySeasonStep({
        loopInternally: true,
        transient: false,
        attempts: 99,
        maxAttempts: 3,
      })
    ).toBe(true);
    expect(
      shouldRetrySeasonStep({ loopInternally: true, transient: true, attempts: 99, maxAttempts: 3 })
    ).toBe(true);
  });
});

describe("computeAllDone — completion signal shared by both response branches", () => {
  it("is true only when every season is done", () => {
    expect(computeAllDone([{ done: true }, { done: true }])).toBe(true);
    expect(computeAllDone([{ done: true }, { done: false }])).toBe(false);
  });

  it("treats all-skipped seasons (done:true) as complete", () => {
    expect(computeAllDone([{ done: true, action: "skipped" }])).toBe(true);
  });

  it("is true for an empty season set", () => {
    expect(computeAllDone([])).toBe(true);
  });
});

describe("buildDriverResults — driver response always includes stepped + skipped seasons", () => {
  it("appends skipped seasons after the rich step results", () => {
    const seasonState = [
      { season: "spring26", done: true, action: "advanced" },
      { season: "fall26", done: true, action: "skipped" },
    ];
    const stepResults = [{ season: "spring26", action: "advanced", phase: "done" }];
    expect(buildDriverResults(seasonState, stepResults)).toEqual([
      { season: "spring26", action: "advanced", phase: "done" },
      { season: "fall26", action: "skipped" },
    ]);
  });

  it("does not duplicate stepped (non-skipped) seasons", () => {
    const seasonState = [{ season: "spring26", done: true, action: "advanced" }];
    const stepResults = [{ season: "spring26", action: "advanced", phase: "done" }];
    expect(buildDriverResults(seasonState, stepResults)).toEqual(stepResults);
  });

  it("regression: a fully-done driver pass yields allDone:true with no missing field", () => {
    // The weekly-scan failure was the driver branch returning {ok,results} with
    // NO allDone, so the workflow (which exits 0 only on allDone:true) looped to
    // the wall clock. Both helpers together reconstruct a correct response.
    const seasonState = [
      { season: "spring26", done: true, action: "advanced" },
      { season: "fall26", done: true, action: "skipped" },
    ];
    const stepResults = [{ season: "spring26", action: "advanced", phase: "done" }];
    const response = {
      ok: true,
      allDone: computeAllDone(seasonState),
      results: buildDriverResults(seasonState, stepResults),
    };
    expect(response.allDone).toBe(true);
    expect(response).toHaveProperty("allDone");
    expect(response.results).toHaveLength(2);
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
