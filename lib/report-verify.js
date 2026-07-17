import { computeReport } from "./report-compute";
import { loadScanData } from "./scan-data-store";
import { loadOverride } from "./override-store";
import { getSql, hasSqlDatabase } from "./db";
import { readSqlFull } from "./sql-report-store";
import { loadSeasonConsignOverlay } from "./consignment-store";

const EPSILON = 0.01;
const MAX_MISMATCHES = 100;

function keyVendor(deptId, vendor) {
  return `${deptId}:${vendor?.id || ""}:${vendor?.name || ""}`;
}

function keyProduct(row) {
  return row?.pid != null && row.pid !== "" ? `pid:${row.pid}` : `sku:${row?.sku || ""}`;
}

function indexBy(items, keyFn) {
  const out = new Map();
  for (const item of items || []) out.set(keyFn(item), item);
  return out;
}

function numberEqual(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= EPSILON;
}

function addMismatch(mismatches, scope, key, column, kvValue, sqlValue) {
  if (mismatches.length >= MAX_MISMATCHES) return;
  mismatches.push({ scope, key, column, kvValue, sqlValue });
}

function compareObjectFields(
  mismatches,
  scope,
  key,
  kvObj,
  sqlObj,
  fields,
  numericFields = fields
) {
  for (const field of fields) {
    const numeric = numericFields.includes(field);
    const ok = numeric
      ? numberEqual(kvObj?.[field], sqlObj?.[field])
      : String(kvObj?.[field] ?? "") === String(sqlObj?.[field] ?? "");
    if (!ok) addMismatch(mismatches, scope, key, field, kvObj?.[field], sqlObj?.[field]);
  }
}

function vendorRows(deptVendors) {
  const rows = [];
  for (const [deptId, vendors] of Object.entries(deptVendors || {})) {
    for (const vendor of vendors || []) rows.push({ ...vendor, _deptId: deptId });
  }
  return rows;
}

function compareMaps(mismatches, scope, kvMap, sqlMap, fields, numericFields) {
  const keys = new Set([...kvMap.keys(), ...sqlMap.keys()]);
  for (const key of keys) {
    const kvObj = kvMap.get(key);
    const sqlObj = sqlMap.get(key);
    if (!kvObj || !sqlObj) {
      addMismatch(mismatches, scope, key, "presence", !!kvObj, !!sqlObj);
      continue;
    }
    compareObjectFields(mismatches, scope, key, kvObj, sqlObj, fields, numericFields);
  }
}

function maxNumericDelta(mismatches) {
  return mismatches.reduce((max, mismatch) => {
    const delta = Math.abs(Number(mismatch.kvValue || 0) - Number(mismatch.sqlValue || 0));
    return Number.isFinite(delta) ? Math.max(max, delta) : max;
  }, 0);
}

export async function verifySqlSeason(kv, season) {
  if (!hasSqlDatabase())
    return { season, ok: false, error: "DATABASE_URL or POSTGRES_URL missing" };

  const [rawData, override, sqlReport] = await Promise.all([
    loadScanData(kv, season),
    loadOverride(kv, season),
    readSqlFull(getSql(), season),
  ]);
  if (!rawData && !override) return { season, ok: false, error: "KV oracle missing" };
  if (!sqlReport) return { season, ok: false, error: "SQL report missing" };

  const overlay = await loadSeasonConsignOverlay(kv, season, {
    seasonPids: rawData?.seasonPids || [],
    pidToSku: rawData?.pidToSku || {},
  });
  const consignByPid = overlay && Object.keys(overlay).length ? overlay : null;
  const kvReport = computeReport(rawData, override, season, { consignByPid });
  const kvSummaryRows = kvReport.summaryRows || [];
  const sqlSummaryRows = sqlReport.summaryRows || [];
  const mismatches = [];

  compareMaps(
    mismatches,
    "summary",
    indexBy(kvSummaryRows, (row) => row.id),
    indexBy(sqlSummaryRows, (row) => row.id),
    ["name", "ordered", "orderedCost", "received", "cost", "returned", "returnedCost", "sold"],
    ["ordered", "orderedCost", "received", "cost", "returned", "returnedCost", "sold"]
  );

  compareMaps(
    mismatches,
    "vendor",
    indexBy(vendorRows(kvReport.deptVendors), (row) => keyVendor(row._deptId, row)),
    indexBy(vendorRows(sqlReport.deptVendors), (row) => keyVendor(row._deptId, row)),
    ["ordered", "orderedCost", "received", "cost", "returned", "returnedCost", "sold"],
    ["ordered", "orderedCost", "received", "cost", "returned", "returnedCost", "sold"]
  );

  compareMaps(
    mismatches,
    "product",
    indexBy(kvReport.rows, keyProduct),
    indexBy(sqlReport.rows, keyProduct),
    [
      "sku",
      "deptId",
      "vendorId",
      "price",
      "cost",
      "orderedQty",
      "receivedRaw",
      "retQty",
      "sold",
      "onSale",
      "saleAmt",
      "liveOnHand",
    ],
    [
      "price",
      "cost",
      "orderedQty",
      "receivedRaw",
      "retQty",
      "sold",
      "onSale",
      "saleAmt",
      "liveOnHand",
    ]
  );

  return {
    season,
    ok: mismatches.length === 0,
    maxDelta: maxNumericDelta(mismatches),
    counts: {
      kvRows: kvReport.rows.length,
      sqlRows: sqlReport.rows.length,
      mismatches: mismatches.length,
    },
    mismatches,
  };
}
