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

export function filterRestoredSeasonPids(seasonPids = [], season, pidToSku = {}) {
  return seasonPids.filter((pid) => restoredPidMatchesSeason(pid, season, pidToSku));
}
