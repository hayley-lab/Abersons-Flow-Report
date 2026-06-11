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
    // Already rebuilding this season — continue without wiping progress.
    if (!idle && scanMode === "full") return { skip: false, restart: "0", mode: "full" };
    // Otherwise (idle, or mid an incremental scan) start the rebuild fresh.
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
