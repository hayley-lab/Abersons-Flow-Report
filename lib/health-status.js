// Pure helpers that drive the in-app Data Health surface (accuracy-assurance
// plan §4 Layer 4 — in-app drift surfacing as the PRIMARY channel).
//
// Two cheap, always-available signals are derived directly from the canonical
// scan:data rows (no network):
//   - store-cache completeness: how many LS products have a live on-hand value
//     (a null liveOnHand means the inventory cache did not cover that product,
//     so the report fell back to PO math for it — an operational gap worth
//     surfacing).
//   - inventoryMismatch count: LS products whose live on-hand diverges from the
//     derived flow stock. These are EXPECTED (manual LS inventory adjustments)
//     and are reported as informational, never as drift failures.
//
// The authoritative drift decision still comes from GET /api/scan/validate
// (lib/report-validate.js evaluateDrift); deriveHealthBadge folds that in when a
// validation report is available so the nav badge lights up exactly when the
// plan's drift threshold trips (any hard verifiable qty mismatch, >0.5% drifted
// verifiable products, or >0.5% season retail-$ drift).

import { mismatchDerivedStock } from "./flow-math";

// Badge severity levels, lowest to highest.
export const HEALTH_LEVEL = {
  OK: "ok",
  WARN: "warn",
  DRIFT: "drift",
};

// Below this fraction of LS products carrying a live on-hand value, the store
// cache is treated as incomplete and the badge warns. Defaults to a strict
// 99.5% so a few uncached products don't nag, but a real gap does.
export const DEFAULT_CACHE_WARN_PCT = 0.995;

function num(x) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

// Cheap, network-free health signal computed from the canonical rows the report
// already loaded for a season.
export function summarizeRowsHealth(rows) {
  let totalRows = 0;
  let lsRows = 0;
  let datatailOnly = 0;
  let inventoryMismatch = 0;
  let liveOnHandRows = 0;
  let missingLiveOnHand = 0;
  let orderedCostGaps = 0;
  let zeroPriceGaps = 0;

  for (const r of rows || []) {
    totalRows += 1;
    if (r == null) continue;
    const orderedQty = num(r.orderedQty != null ? r.orderedQty : r.lsOrderedQty);
    const activeQty =
      orderedQty + num(r.receivedRaw) + num(r.retQty) + num(r.sold) + num(r.onSale) + num(r.onHand);
    if (orderedQty > 0 && num(r.cost) <= 0) orderedCostGaps += 1;
    if (activeQty > 0 && num(r.price) <= 0) zeroPriceGaps += 1;
    if (r.pid == null) {
      datatailOnly += 1;
      continue;
    }
    lsRows += 1;
    if (r.liveOnHand == null) missingLiveOnHand += 1;
    else liveOnHandRows += 1;
    if (r.inventoryMismatch) inventoryMismatch += 1;
  }

  return {
    totalRows,
    lsRows,
    datatailOnly,
    inventoryMismatch,
    liveOnHandRows,
    missingLiveOnHand,
    orderedCostGaps,
    zeroPriceGaps,
    cacheCompletePct: lsRows > 0 ? liveOnHandRows / lsRows : 1,
  };
}

// Normalize a validation report's drift reasons into a flat label list.
function validationReasons(validation) {
  const reasons = validation && validation.drift && validation.drift.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.map((r) => ({
    code: r.code || "drift",
    detail: r.detail || r.code || "drift",
  }));
}

// Decide the badge level/reasons for a season from the cheap row signal plus an
// optional /api/scan/validate report. Drift (validated threshold breach) always
// outranks a cache-completeness warning.
export function deriveHealthBadge({
  rowsHealth,
  validation = null,
  rollupDegraded = false,
  cacheWarnPct = DEFAULT_CACHE_WARN_PCT,
} = {}) {
  const reasons = [];
  let level = HEALTH_LEVEL.OK;

  if (rowsHealth && rowsHealth.lsRows > 0 && rowsHealth.cacheCompletePct < cacheWarnPct) {
    level = HEALTH_LEVEL.WARN;
    reasons.push({
      code: "cache-incomplete",
      detail: `${rowsHealth.missingLiveOnHand} LS product(s) missing live on-hand`,
    });
  }

  if (rollupDegraded) {
    level = HEALTH_LEVEL.WARN;
    reasons.push({
      code: "rollup-degraded",
      detail: "Report totals are degraded because request-time rollup failed",
    });
  }

  const tripped = !!(validation && validation.drift && validation.drift.tripped);
  if (tripped) {
    level = HEALTH_LEVEL.DRIFT;
    for (const r of validationReasons(validation)) reasons.push(r);
  }

  return {
    level,
    validated: !!validation,
    tripped,
    reasons,
  };
}

// Derived flow stock for a row: received − sold − on-sale − vendor returns,
// floored at 0. Delegates to lib/flow-math.mismatchDerivedStock so it applies
// the SAME consignment/migrated fallback used to build the rows: a product with
// no LS PO record (receivedRaw === 0) tracks live on-hand instead of deriving a
// bogus 0, so it is not falsely flagged as a manual-adjustment mismatch.
export function derivedFlowStock(row) {
  if (!row) return 0;
  return mismatchDerivedStock({
    qtyReceived: num(row.receivedRaw),
    liveOnHand: row.liveOnHand == null ? null : num(row.liveOnHand),
    sold: num(row.sold),
    onSale: num(row.onSale),
    retQty: num(row.retQty),
  });
}

// The pieces behind the enriched `≠` tooltip: live LS on-hand vs the derived
// flow stock and their delta, so staff can see why a manual-adjustment row was
// flagged.
export function inventoryMismatchBreakdown(row) {
  const live = row && row.liveOnHand != null ? num(row.liveOnHand) : null;
  const derived = derivedFlowStock(row);
  return {
    live,
    derived,
    delta: live == null ? null : live - derived,
    received: num(row && row.receivedRaw),
    sold: num(row && row.sold),
    onSale: num(row && row.onSale),
    returned: num(row && row.retQty),
  };
}

// A live-vs-derived on-hand delta only counts as a "manual-count difference"
// once it is MATERIAL: at least this many units off, OR worth at least this
// many dollars at the product's price. Sub-threshold deltas (an off-by-one, a
// single cheap item, rounding) are noise and are not surfaced as differences.
export const MATERIAL_UNIT_DELTA = 2;
export const MATERIAL_DOLLAR_DELTA = 25;

// True when a row's live LS on-hand differs MATERIALLY from its derived flow
// stock. Consignment/migrated no-PO products never qualify (derivedFlowStock
// tracks their live on-hand, so the delta is ~0).
export function isMaterialMismatch(row) {
  if (!row || row.pid == null || !row.inventoryMismatch) return false;
  const { delta } = inventoryMismatchBreakdown(row);
  if (delta == null) return false;
  const units = Math.abs(delta);
  return units >= MATERIAL_UNIT_DELTA || units * num(row.price) >= MATERIAL_DOLLAR_DELTA;
}

// Count LS products in a row set whose live on-hand differs MATERIALLY from the
// derived flow stock (drives the Data Health "manual-count differences" count).
export function adjustedCount(rows) {
  let n = 0;
  for (const r of rows || []) {
    if (isMaterialMismatch(r)) n += 1;
  }
  return n;
}

// Plain-language explanation for the Data Health manual-count-differences count.
// Kept here so it matches the per-product `≠` tooltip wording (a Lightspeed
// inventory count/correction; LS is the source of truth for on-hand).
export function adjustedBadgeTooltip(count) {
  const n = num(count);
  return (
    n +
    " product(s) here have a Lightspeed on-hand count that differs from the flow math " +
    "(received − sold − on sale − returned). These are usually counts reconciled in " +
    "Lightspeed — a manual inventory count or correction. Lightspeed is the source of " +
    "truth for on-hand."
  );
}

// Q4 — products Lightspeed could not categorize (no product_type_id → deptId
// "__none__", rendered "Other"). Surfaced on Data Health so staff can assign a
// product type in Lightspeed. Returns a lightweight, display-ready row list:
// SKU, vendor name, season, and ordered/received/sold quantities.
export function uncategorizedRows(rows, season = "") {
  const out = [];
  for (const r of rows || []) {
    if (!r || String(r.deptId) !== "__none__") continue;
    out.push({
      pid: r.pid != null ? r.pid : null,
      sku: r.sku || "",
      vendorName: r.vendorName || "Unassigned",
      season: r.season || season || "",
      ordered: num(r.orderedQty != null ? r.orderedQty : r.lsOrderedQty),
      received: num(r.receivedRaw),
      sold: num(r.sold),
    });
  }
  return out;
}
