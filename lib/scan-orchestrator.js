// Pure decision helpers for the cron scan orchestrator (pages/api/cron/scan.js).
//
// Kept side-effect free so the season scheduling rules — full-rebuild intent,
// rescan throttling, and the "don't step seasons until the shared catalog is
// built" gate — are unit-testable without KV or the network.

// Is the store-wide catalog cache fully built (so per-season buckets exist and
// every season can seed from them)? Treats a missing/failed catalog response as
// "not complete" so the orchestrator keeps driving the build instead of letting
// seasons fall back to the slow per-season scan.
export function catalogIsComplete(catalogResult) {
  return !!(catalogResult && catalogResult.cacheComplete === true);
}

// Per-call deadline for driving a shared cache (catalog / sales / consignment)
// one chunk at a time. BOTH the internally-looping Vercel cron path and the
// GitHub Actions driver path must get a real budget derived from the shared
// overall deadline so each call actually advances the cache.
//
// Regression this guards against (commit af1f28b): the driver path computed a
// zero-length budget (Date.now()), so hasBudgetFor refused every cache chunk,
// the drives returned null, and the orchestrator looped on {cacheBuilding:true}
// for the whole wall-clock budget without doing any LS work. Deriving the
// deadline from overallDeadline guarantees there is room for at least one chunk.
export function cacheDriveDeadline({ now = Date.now(), driveMs, overallDeadline }) {
  return Math.min(now + driveMs, overallDeadline);
}

// Decide whether the orchestrator must yield this invocation to a still-building
// shared cache (returning the {cacheBuilding:true} progress response) instead of
// stepping seasons.
//
// A cache counts as complete when EITHER the in-call drive result reports
// cacheComplete OR the persisted KV meta says complete. Consulting KV means a
// cache already finished in a prior call — e.g. the drive was skipped for budget
// this call, or a transient drive error returned null — is treated as done
// rather than re-entering the idle building loop.
export function shouldYieldForCache({ driveResult, kvComplete = false }) {
  return !catalogIsComplete(driveResult) && !kvComplete;
}

// Whether a shared-cache drive can be skipped this invocation because the cache
// is already fully built in KV. We only skip on the non-looping driver/UI path
// (loopInternally === false): that path's job is to STEP SEASONS, and re-paging
// already-complete caches every call burns the shared budget so the season-step
// gate never has enough headroom (the weekly-scan failure mode). The internally
// looping Vercel cron path keeps driving so the incremental top-up stays fresh.
// An explicit reset request (?catalog=1 / ?sales=1 / ?consign=1) always drives.
export function shouldSkipCompletedDrive({
  kvComplete = false,
  resetRequested = false,
  loopInternally = false,
}) {
  return !!kvComplete && !resetRequested && !loopInternally;
}

// True when every season has finished (stepped to "done" or skipped as already
// satisfied). Shared by both the internal-cron and driver response branches so
// the completion signal can never drift between them.
export function computeAllDone(seasonState) {
  return seasonState.every((s) => s.done);
}

// Assemble the season results array for the driver/UI response: the rich
// per-step results collected this pass, plus any season that was skipped (it
// never enters the step loop, so it must be appended for an accurate picture).
export function buildDriverResults(seasonState, stepResults) {
  const results = [...stepResults];
  for (const s of seasonState) {
    if (s.done && s.action === "skipped") {
      results.push({ season: s.season, action: "skipped" });
    }
  }
  return results;
}

// Resolve the last-full-rebuild timestamp from either the standalone scan:lastFull
// key or the value embedded in a done job record. The done job record embeds lastFull
// (written atomically with the done marker) so a single scan:job read is authoritative
// even when the standalone key lags — this prevents the orchestrator from re-restarting
// a season that just finished a full rebuild in this cycle.
export function resolveLastFullTs(lastFullKeyValue, job) {
  const fromKey = Number(lastFullKeyValue || 0) || null;
  if (fromKey) return fromKey;
  if (job && job.lastFull) return Number(job.lastFull) || null;
  return null;
}

// Decide what a single season should do this pass.
//   restart "1" → wipe state and start a fresh scan; "0" → continue.
//   mode "full" | "incremental".
//   skip true → nothing to do this pass (recently completed).
//
// A pending full rebuild (rebuildTs) takes priority over the rescan throttle so
// the weekly rebuild always re-runs every season once — even when the catalog
// build delayed season stepping past the point where the original ?restart=1
// request was seen. A season that has finished a full rebuild after rebuildTs
// (lastFullTs >= rebuildTs) is considered satisfied and no longer forced.
export function planSeasonWork({
  phase = null,
  scanMode = null,
  hasData = false,
  msSinceScan = Infinity,
  lastFullTs = null,
  startedAt = null,
  rebuildTs = null,
  restartAll = false,
  now = Date.now(),
  rescanIntervalMs,
  fullRebuildIntervalMs,
}) {
  const idle = !phase || phase === "done" || phase === "error";
  const defaultMode = scanMode || "incremental";

  if (restartAll) return { skip: false, restart: "1", mode: "full" };

  const seasonNeedsRebuild = !!rebuildTs && (!lastFullTs || lastFullTs < rebuildTs);
  if (seasonNeedsRebuild) {
    // A full scan that began as part of THIS rebuild cycle is legitimately in
    // progress — continue without wiping. A full scan left over from a PRIOR
    // cycle (started before this rebuild was requested) is stale: it predates
    // the freshly built shared catalog buckets, so it must be wiped and
    // re-seeded rather than allowed to grind on the slow per-season /search.
    const startedThisCycle = startedAt != null && startedAt >= rebuildTs;
    if (!idle && scanMode === "full" && startedThisCycle) {
      return { skip: false, restart: "0", mode: "full" };
    }
    // Otherwise (idle, mid an incremental scan, or a stale full scan) start fresh.
    return { skip: false, restart: "1", mode: "full" };
  }

  if (idle) {
    if (msSinceScan < rescanIntervalMs) return { skip: true, restart: "0", mode: defaultMode };
    const fullDue = !lastFullTs || now - lastFullTs >= fullRebuildIntervalMs;
    if (!hasData || fullDue) return { skip: false, restart: "1", mode: "full" };
    return { skip: false, restart: "0", mode: "incremental" };
  }

  // Mid-scan with no rebuild pending: keep going in its current mode.
  return { skip: false, restart: "0", mode: defaultMode };
}
