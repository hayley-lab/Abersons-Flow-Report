import {
  delShardedObject,
  getShardedObjectByPid,
  isShardedKvObject,
  setShardedObjectByPid,
} from "./kv-sharded";

const SCAN_DATA_TTL_SECONDS = 48 * 3600;
const SCAN_BIG_TTL_SECONDS = 72 * 3600;

const SCAN_DATA_PID_FIELDS = [
  "productStats",
  "pidToType",
  "pidToSupplier",
  "pidToQtyOrdered",
  "pidToQtyReceived",
  "pidToQtyReturned",
  "pidToPrice",
  "pidToCost",
  "pidToName",
  "pidToSku",
  "pidToVariant",
  "costDone",
];

const SCAN_PIDS_PID_FIELDS = [
  "pidToType",
  "pidToSupplier",
  "pidToPrice",
  "pidToCost",
  "pidToName",
  "pidToSku",
  "pidToVariant",
  "costDone",
];

const SCAN_BIG_PID_FIELDS = [
  ...SCAN_DATA_PID_FIELDS,
  "parentStore",
  "negPids",
  "_productTried",
  "variantNeedsFixup",
];

const SKU_TO_PID_FIELDS = ["skuToPid"];

export function scanDataKey(season) {
  return `scan:data:${season}`;
}

export function scanPidsKey(season) {
  return `scan:pids:${season}`;
}

export function scanBigKey(season) {
  return `scan:job:big:${season}`;
}

export async function loadScanData(kv, season) {
  return getShardedObjectByPid(kv, scanDataKey(season));
}

export function scanDataSummaryFromValue(value) {
  if (!value) return null;
  const scalar = isShardedKvObject(value) ? value.scalar || {} : value;
  return { ts: scalar.ts ?? value.ts ?? null };
}

export async function loadScanDataSummary(kv, season) {
  return scanDataSummaryFromValue(await kv.get(scanDataKey(season)));
}

export async function saveScanData(kv, season, data) {
  return setShardedObjectByPid(kv, scanDataKey(season), data, {
    ex: SCAN_DATA_TTL_SECONDS,
    pidFields: SCAN_DATA_PID_FIELDS,
    skuToPidFields: SKU_TO_PID_FIELDS,
  });
}

export async function loadScanPids(kv, season) {
  return getShardedObjectByPid(kv, scanPidsKey(season));
}

export async function saveScanPids(kv, season, maps) {
  return setShardedObjectByPid(kv, scanPidsKey(season), maps, {
    ex: SCAN_DATA_TTL_SECONDS,
    pidFields: SCAN_PIDS_PID_FIELDS,
    skuToPidFields: SKU_TO_PID_FIELDS,
  });
}

export async function loadScanBig(kv, season) {
  return getShardedObjectByPid(kv, scanBigKey(season));
}

export async function saveScanBig(kv, season, state) {
  return setShardedObjectByPid(kv, scanBigKey(season), state, {
    ex: SCAN_BIG_TTL_SECONDS,
    pidFields: SCAN_BIG_PID_FIELDS,
    skuToPidFields: SKU_TO_PID_FIELDS,
  });
}

export async function deleteScanBig(kv, season) {
  return delShardedObject(kv, scanBigKey(season));
}
