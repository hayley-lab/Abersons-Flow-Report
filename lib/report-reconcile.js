// Pure old-report reconciliation logic.
//
// This compares the imported datatailor override records (`scan:override`) with
// the canonical rows and rollups the Lightspeed report currently serves. It does
// not read KV or call Lightspeed; API/UI layers are responsible for loading data.
import { skuMatchesSeason } from "./flow-math";
import { withinDollarTolerance } from "./report-validate";
import { normVendorName } from "./vendor-match";

const QTY_FIELDS = [
  ["qtyOrdered", "orderedQty"],
  ["qtyStock", "onHand"],
  ["qtySold", "sold"],
  ["qtySale", "onSale"],
  ["qtyReturned", "retQty"],
];

const VENDOR_DOLLAR_FIELDS = [
  ["ordered", "ordered"],
  ["received", "received"],
  ["sold", "sold"],
];

function num(x) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

function skuOf(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function activeRow(row) {
  return (
    num(row?.orderedQty ?? row?.lsOrderedQty) +
      num(row?.receivedRaw) +
      num(row?.onHand) +
      num(row?.sold) +
      num(row?.onSale) +
      num(row?.retQty) >
    0
  );
}

function oldVendorRecords(override) {
  return Object.entries((override && override.vendors) || {})
    .map(([key, vendor]) => ({ key, ...(vendor || {}) }))
    .filter((vendor) => vendor && Array.isArray(vendor.products));
}

function oldProductsForSeason(vendor, season) {
  return (vendor.products || [])
    .map((product, index) => ({ ...product, _index: index }))
    .filter((product) => {
      const sku = skuOf(product.style);
      return sku && (!season || skuMatchesSeason(sku, season));
    });
}

function productKey(product) {
  const sku = skuOf(product.style);
  return sku || `old:${product._index}`;
}

function newRowBySku(rows, season) {
  const bySku = new Map();
  for (const row of rows || []) {
    const sku = skuOf(row?.sku);
    if (!sku || (season && !skuMatchesSeason(sku, season))) continue;
    if (!bySku.has(sku)) bySku.set(sku, row);
  }
  return bySku;
}

function newQty(row, newField) {
  if (newField === "orderedQty") return num(row?.orderedQty ?? row?.lsOrderedQty);
  return num(row?.[newField]);
}

function rowLabel(row) {
  return {
    pid: row?.pid ?? null,
    sku: row?.sku || "",
    vendorName: row?.vendorName || "",
    deptId: row?.deptId || "",
    deptName: row?.deptName || "",
  };
}

function oldLabel(vendor, product) {
  return {
    oldVendorKey: vendor.key || "",
    vendorName: vendor.vendorName || "",
    deptId: vendor.deptId || "",
    deptName: vendor.deptName || "",
    sku: product?.style || "",
  };
}

function findVendorRollup(vendor, rollupResult) {
  let best = null;
  let bestScore = 0;
  const oldId = String(vendor.vendorId || "");
  const oldName = normVendorName(vendor.vendorName);
  const oldDept = normVendorName(vendor.deptName);

  for (const [deptId, vendors] of Object.entries(rollupResult?.deptVendors || {})) {
    for (const candidate of vendors || []) {
      let score = 0;
      if (oldId && String(candidate.id || "") === oldId) score += 4;
      if (oldName && normVendorName(candidate.name) === oldName) score += 3;
      if (oldDept && normVendorName(candidate.deptName || deptId) === oldDept) score += 1;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  return bestScore >= 3 ? best : null;
}

function emptyCounts() {
  return {
    oldVendors: 0,
    matchedVendors: 0,
    missingVendors: 0,
    oldProducts: 0,
    matchedProducts: 0,
    oldOnlyProducts: 0,
    newOnlyProducts: 0,
    wrongSeasonOldProducts: 0,
    qtyMismatches: 0,
    dollarMismatches: 0,
    priceMismatches: 0,
    costMismatches: 0,
    mismatchCount: 0,
  };
}

function recordMismatch(report, mismatch) {
  report.mismatches.push(mismatch);
  report.counts.mismatchCount += 1;
  if (mismatch.kind === "qty") report.counts.qtyMismatches += 1;
  if (mismatch.kind === "dollar") report.counts.dollarMismatches += 1;
  if (mismatch.kind === "price") report.counts.priceMismatches += 1;
  if (mismatch.kind === "cost") report.counts.costMismatches += 1;
}

function compareProduct(report, vendor, oldProduct, row) {
  for (const [oldField, newField] of QTY_FIELDS) {
    const expected = num(oldProduct[oldField]);
    const actual = newQty(row, newField);
    if (actual !== expected) {
      recordMismatch(report, {
        kind: "qty",
        field: oldField,
        expected,
        actual,
        delta: actual - expected,
        source: "product",
        ...oldLabel(vendor, oldProduct),
        ...rowLabel(row),
      });
    }
  }

  for (const field of ["price", "cost"]) {
    const expected = round2(oldProduct[field]);
    const actual = round2(row?.[field]);
    if (expected !== actual) {
      recordMismatch(report, {
        kind: field,
        field,
        expected,
        actual,
        delta: round2(actual - expected),
        source: "product",
        ...oldLabel(vendor, oldProduct),
        ...rowLabel(row),
      });
    }
  }
}

function compareVendor(report, vendor, newVendor) {
  if (!newVendor) {
    report.counts.missingVendors += 1;
    report.vendorMismatches.push({
      kind: "missing-vendor",
      oldVendorKey: vendor.key || "",
      vendorName: vendor.vendorName || "",
      deptId: vendor.deptId || "",
      deptName: vendor.deptName || "",
    });
    return;
  }

  report.counts.matchedVendors += 1;
  for (const [oldField, newField] of VENDOR_DOLLAR_FIELDS) {
    const expected = num(vendor[oldField]);
    const actual = num(newVendor[newField]);
    const qty = Math.max(1, num(vendor.products?.length));
    if (!withinDollarTolerance(expected, actual, qty)) {
      const mismatch = {
        kind: "dollar",
        field: oldField,
        expected: round2(expected),
        actual: round2(actual),
        delta: round2(actual - expected),
        source: "vendor",
        oldVendorKey: vendor.key || "",
        vendorName: vendor.vendorName || "",
        deptId: vendor.deptId || "",
        deptName: vendor.deptName || "",
        newVendorId: newVendor.id || "",
        newVendorName: newVendor.name || "",
      };
      report.vendorMismatches.push(mismatch);
      recordMismatch(report, mismatch);
    }
  }
}

export function buildReconciliationReport({
  season,
  rows = [],
  override = null,
  rollupResult = null,
  checkedAt = Date.now(),
} = {}) {
  const report = {
    season: season || null,
    checkedAt,
    mode: "old-report-reconciliation",
    counts: emptyCounts(),
    mismatches: [],
    vendorMismatches: [],
    oldOnly: [],
    newOnly: [],
    skipped: [],
  };

  const bySku = newRowBySku(rows, season);
  const oldSkuSet = new Set();
  const vendors = oldVendorRecords(override);
  report.counts.oldVendors = vendors.length;

  for (const vendor of vendors) {
    const seasonProducts = oldProductsForSeason(vendor, season);
    report.counts.wrongSeasonOldProducts += (vendor.products || []).length - seasonProducts.length;
    compareVendor(report, vendor, findVendorRollup(vendor, rollupResult));

    for (const oldProduct of seasonProducts) {
      const key = productKey(oldProduct);
      oldSkuSet.add(key);
      report.counts.oldProducts += 1;
      const row = bySku.get(key);
      if (!row) {
        report.counts.oldOnlyProducts += 1;
        report.oldOnly.push(oldLabel(vendor, oldProduct));
        continue;
      }
      report.counts.matchedProducts += 1;
      compareProduct(report, vendor, oldProduct, row);
    }
  }

  for (const row of rows || []) {
    const sku = skuOf(row?.sku);
    if (!sku || (season && !skuMatchesSeason(sku, season))) continue;
    if (oldSkuSet.has(sku) || !activeRow(row)) continue;
    report.counts.newOnlyProducts += 1;
    report.newOnly.push(rowLabel(row));
  }

  report.ok = report.counts.mismatchCount === 0 && report.counts.oldOnlyProducts === 0;
  return report;
}
