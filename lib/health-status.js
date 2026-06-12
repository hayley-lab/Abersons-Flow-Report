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

  for (const r of rows || []) {
    totalRows += 1;
    if (r == null) continue;
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
// floored at 0. Mirrors lib/flow-math.derivedOnHand but works on a report row.
export function derivedFlowStock(row) {
  if (!row) return 0;
  return Math.max(0, num(row.receivedRaw) - num(row.sold) - num(row.onSale) - num(row.retQty));
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

// Count LS products in a row set whose live on-hand was manually adjusted away
// from the derived flow stock (drives the per-vendor adjusted-count badge).
export function adjustedCount(rows) {
  let n = 0;
  for (const r of rows || []) {
    if (r && r.pid != null && r.inventoryMismatch) n += 1;
  }
  return n;
}

// Plain-language explanation for the per-vendor adjusted-count badge. Kept here
// so it matches the per-product `≠` tooltip wording (manual LS inventory
// adjustment; LS is the source of truth for on-hand).
export function adjustedBadgeTooltip(count) {
  const n = num(count);
  return (
    n +
    " product(s) here have a Lightspeed on-hand that doesn't match the flow math " +
    "(received − sold − on sale − returned). This usually means a manual inventory " +
    "adjustment was made in Lightspeed. Lightspeed is the source of truth for on-hand."
  );
}
