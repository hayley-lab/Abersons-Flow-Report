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

export function reportSummaryKey(season) {
  return `scan:report:${season}`;
}

export function reportDeptKey(season, deptId) {
  return `scan:report:${season}:dept:${deptId}`;
}

export function reportEpochKey(season) {
  return `scan:report:epoch:${season}`;
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

// ── Report read-cache (write-through) ───────────────────────────────────────
//
// The request-time rollup is expensive only because it must read the full
// sharded scan:data blob plus every override vendor record. These helpers cache
// the computed result so the common summary/vendor screens read a tiny blob and
// product drilldowns read only one department's rows. Each cached value carries
// a `tag` ("{ts}:{epoch}") validated against the live scan ts + an import epoch,
// so a new scan/delta (new ts) or a datatail import (bumped epoch) invalidates
// it without scanning variable dept keys.

export function reportCacheTag(ts, epoch) {
  return `${ts == null ? "none" : ts}:${epoch == null ? 0 : epoch}`;
}

export async function loadReportEpoch(kv, season) {
  const raw = await kv.get(reportEpochKey(season));
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function bumpReportEpoch(kv, season) {
  return kv.incr(reportEpochKey(season));
}

export async function loadReportSummary(kv, season) {
  return kv.get(reportSummaryKey(season));
}

export async function saveReportSummary(kv, season, blob) {
  return kv.set(reportSummaryKey(season), blob, { ex: SCAN_DATA_TTL_SECONDS });
}

export async function loadReportDeptRows(kv, season, deptId) {
  return kv.get(reportDeptKey(season, deptId));
}

export async function saveReportDeptRows(kv, season, deptId, blob) {
  return kv.set(reportDeptKey(season, deptId), blob, { ex: SCAN_DATA_TTL_SECONDS });
}
