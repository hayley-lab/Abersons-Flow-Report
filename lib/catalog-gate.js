// Gate for the legacy per-season full-catalog /search scan in step.js.
//
// With the shared catalog cache in place, the per-season catalog scan is only a
// fallback: it should run when there is no cached/prior product set to seed from
// (a true cold edge case) or when explicitly forced. When the season already has
// pids from the shared catalog bucket or a prior scan, the per-season scan is
// skipped entirely.
export function shouldFullCatalogScan({
  searchEnabled = false,
  fullRebuild = false,
  priorPidCount = 0,
  catalogSeeded = false,
  force = false,
} = {}) {
  if (!searchEnabled) return false;
  if (force) return true;
  // The shared catalog cache already paged the whole store and bucketed this
  // season — its result is authoritative even when the bucket is empty (e.g. a
  // future season with no products yet). Never re-page the catalog per season.
  if (catalogSeeded) return false;
  if (priorPidCount > 0) return false;
  return !!fullRebuild;
}
