// Pure helpers for recovering product display metadata during the scan.
//
// Older pid caches (scan:pids / scan:data) saved skuToPid + pidToPrice but
// predate the per-pid name/sku/cost/variant maps that registerProduct now
// writes. SKU (and a usable name) can be rebuilt from skuToPid with zero API
// calls — for these products the Lightspeed "name" is just the SKU string —
// so only the small remainder needs a live fetch. Cost is the one field that
// always needs Lightspeed (supply_price), so it is backfilled in bounded
// per-scan chunks instead.

// Fills pidToSku (and a pidToName fallback) in place by inverting skuToPid.
// Returns the number of pids whose SKU was newly recovered.
export function recoverSkuMetadata({ skuToPid = {}, pidToSku = {}, pidToName = {} } = {}) {
  let recovered = 0;
  for (const [sku, pid] of Object.entries(skuToPid)) {
    if (!pid || !sku) continue;
    if (!pidToSku[pid]) {
      pidToSku[pid] = sku;
      recovered++;
    }
    if (!pidToName[pid]) pidToName[pid] = sku;
  }
  return recovered;
}

// Pids that still have no SKU after inversion — these need a live fetch.
export function pidsMissingSku(seasonPids = [], pidToSku = {}) {
  return seasonPids.filter((pid) => !pidToSku[pid]);
}

// Up to `limit` priced pids whose cost has not been looked up yet. costDone
// marks every previously attempted pid (even legitimately $0 consignment /
// datatail products) so they are not re-fetched on every scan.
export function selectCostBackfillPids(
  seasonPids = [],
  { pidToPrice = {}, costDone = {} } = {},
  limit = 200
) {
  const out = [];
  for (const pid of seasonPids) {
    if (out.length >= limit) break;
    if (costDone[pid]) continue;
    if (!((pidToPrice[pid] || 0) > 0)) continue;
    out.push(pid);
  }
  return out;
}
