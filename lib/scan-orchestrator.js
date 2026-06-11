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
