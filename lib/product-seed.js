import { skuMatchesSeason } from "./flow-math";

export function pidToSkuFromSources(...sources) {
  const pidToSku = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [sku, pid] of Object.entries(source.skuToPid || {})) {
      if (!sku || pid == null) continue;
      if (!pidToSku[String(pid)]) pidToSku[String(pid)] = sku;
    }
    for (const [pid, sku] of Object.entries(source.pidToSku || {})) {
      if (!sku) continue;
      pidToSku[String(pid)] = sku;
    }
  }
  return pidToSku;
}

export function restoredPidMatchesSeason(pid, season, pidToSku = {}) {
  const sku = pidToSku[String(pid)];
  return !sku || skuMatchesSeason(sku, season);
}

// Restore this season's pids from a prior scan.
//
// `catalogPidSet` is the shared catalog cache's bucket for this season, and when
// supplied it is AUTHORITATIVE: the cache is a full store snapshot (archived
// products included), so a pid it does not list for this season no longer
// belongs here. This is what retires a product whose SKU season code was
// corrected in Lightspeed (e.g. "/f26" -> "/ps27"): the prior scan's pid maps
// still carry the OLD SKU, so the SKU gate alone keeps restoring it into the old
// season on every scan and the same PO gets counted under both seasons.
// A pid the catalog has not seen yet (created since the last catalog refresh) is
// re-registered from its PO line item during the consignments phase.
export function filterRestoredSeasonPids(
  seasonPids = [],
  season,
  pidToSku = {},
  { catalogPidSet = null } = {}
) {
  return seasonPids.filter((pid) => {
    if (catalogPidSet && !catalogPidSet.has(String(pid))) return false;
    return restoredPidMatchesSeason(pid, season, pidToSku);
  });
}
