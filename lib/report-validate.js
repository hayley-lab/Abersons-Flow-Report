// Pure diff/threshold logic for the Lightspeed-based flow-report validation
// harness (GET /api/scan/validate). The endpoint re-derives expected values
// independently from Lightspeed — a fresh live on-hand fetch plus a fresh
// re-projection of the LS-sourced consignment + sales store caches — and this
// module diffs them against the persisted scan:data rows and decides what
// counts as drift.
//
// Domain rules honored (see CLAUDE.md and the accuracy-assurance plan §5):
//   - Quantities are compared EXACTLY; dollar figures within a tolerance of
//     0.5% of the expected value OR $0.01 per unit, whichever is larger.
//   - Datatail-only products (no LS pid) are NOT LS-verifiable -> reported as
//     skipped, never failures.
//   - Rows whose live on-hand diverges from the flow math (inventoryMismatch)
//     reflect a manual LS inventory adjustment -> skipped, never failures, and
//     excluded from the verifiable counts that drive the drift threshold.
//   - The drift threshold (trips the nav badge / fails the nightly Action) is:
//     ANY hard verifiable qty mismatch (on-hand / PO-ordered / PO-received /
//     vendor-return), OR drifted verifiable products > 0.5% of the checked
//     verifiable count, OR season retail-$ drift > 0.5% of reported retail.

export const DEFAULT_THRESHOLDS = {
  dollarPct: 0.005, // dollar drift tolerated per row: 0.5% of expected
  dollarPerUnit: 0.01, // ... or $0.01 per unit, whichever is larger
  driftedProductPct: 0.005, // verifiable products allowed to drift: 0.5%
  seasonDollarPct: 0.005, // season retail-$ drift tolerated: 0.5%
};

// Reasons a product/field is reported as skipped (never a failure).
export const SKIP_REASONS = {
  DATATAIL_ONLY: "datatail-only",
  MANUAL_ADJUSTMENT: "manual-adjustment",
  NOT_SAMPLED: "not-sampled",
  NO_FRESH_DATA: "no-fresh-data",
};

// Hard quantity fields: a single exact mismatch on any of these on a verifiable
// row trips the drift threshold on its own (independent ground truth, no
// tolerance). Sales sold/onSale qty drift counts toward the drifted-product and
// dollar-drift signals but is not an automatic hard trip.
const HARD_QTY_FIELDS = new Set(["onHand", "qtyOrdered", "qtyReceived", "retQty"]);

function num(x) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

// Allowed absolute dollar drift for a row/field given its expected value and
// the unit quantity behind it.
export function dollarTolerance(expected, qty, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  return Math.max(
    Math.abs(num(expected)) * t.dollarPct,
    t.dollarPerUnit * Math.abs(num(qty)),
    t.dollarPerUnit
  );
}

export function withinDollarTolerance(expected, actual, qty, thresholds = DEFAULT_THRESHOLDS) {
  return Math.abs(num(actual) - num(expected)) <= dollarTolerance(expected, qty, thresholds);
}

// Deterministic, evenly-spaced subset of pids capped at `cap`. Stable ordering
// means a nightly sample is reproducible and spread across the season rather
// than clustered at one end. cap <= 0 (or >= length) returns the full list.
export function samplePids(pids, cap) {
  const list = (pids || []).map(String);
  if (!cap || cap <= 0 || list.length <= cap) return list;
  const step = list.length / cap;
  const out = [];
  for (let i = 0; i < cap; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

// A row is LS-verifiable only when it maps to a real LS product (pid) and its
// live on-hand reconciles with the flow math (no manual adjustment).
export function isVerifiableRow(row) {
  return !!row && row.pid != null && !row.inventoryMismatch;
}

// Retail dollars the report attributes to a row that this harness can validate
// (on-hand + full-price sold + actual on-sale dollars). Used as the per-season
// denominator for the retail-$ drift ratio.
function rowReportedRetail(row) {
  const price = num(row.price);
  const onHand = row.liveOnHand == null ? num(row.onHand) : num(row.liveOnHand);
  return (
    Math.max(0, onHand) * price + Math.max(0, num(row.sold)) * price + Math.abs(num(row.saleAmt))
  );
}

function emptyByField() {
  return { onHand: 0, qtyOrdered: 0, qtyReceived: 0, retQty: 0, sold: 0, onSale: 0, saleAmt: 0 };
}

// Decide whether a season's validation result trips the drift threshold.
export function evaluateDrift(report, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const c = (report && report.counts) || {};
  const reasons = [];

  if ((c.hardQtyMismatches || 0) > 0) {
    reasons.push({
      code: "hard-qty-mismatch",
      detail: `${c.hardQtyMismatches} hard quantity mismatch(es) on verifiable rows`,
    });
  }

  const denom = c.checkedProducts || 0;
  const driftRatio = denom > 0 ? (c.driftedProducts || 0) / denom : 0;
  if (denom > 0 && driftRatio > t.driftedProductPct) {
    reasons.push({
      code: "drifted-products",
      detail: `${c.driftedProducts}/${denom} (${(driftRatio * 100).toFixed(2)}%) verifiable products drifted`,
      threshold: t.driftedProductPct,
      value: driftRatio,
    });
  }

  const retailRatio = c.seasonReportedRetail > 0 ? c.seasonRetailDrift / c.seasonReportedRetail : 0;
  if (c.seasonReportedRetail > 0 && retailRatio > t.seasonDollarPct) {
    reasons.push({
      code: "season-retail-drift",
      detail: `season retail-$ drift ${(retailRatio * 100).toFixed(2)}% of reported retail`,
      threshold: t.seasonDollarPct,
      value: retailRatio,
    });
  }

  return { tripped: reasons.length > 0, reasons };
}

// Diff the persisted scan:data rows for a season against freshly-derived LS
// values and produce a structured mismatch/skip report.
//
//   rows         canonical rows from lib/flow-rollup.buildAllRows
//   freshOnHand  { pid -> live on-hand } fetched fresh from LS (sampled pids
//                only; a missing entry means "not fetched" -> no-fresh-data)
//   freshConsign { pid -> { qtyOrdered, qtyReceived, qtyReturned } } re-summed
//                from the LS consignment store cache (missing pid means 0)
//   freshSales   { pid -> { sold, onSale, saleAmt, soldAmt } } re-projected from
//                the LS sales store aggregate (missing pid means 0)
//   sampledPids  array limiting which verifiable pids are checked; null = all
export function buildValidationReport({
  season,
  rows = [],
  freshOnHand = {},
  freshConsign = {},
  freshSales = {},
  sampledPids = null,
  thresholds = DEFAULT_THRESHOLDS,
  checkedAt = Date.now(),
} = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const sampledSet = sampledPids ? new Set(sampledPids.map(String)) : null;

  const mismatches = [];
  const skipped = [];
  const driftedSet = new Set();
  const byField = emptyByField();

  let datatailOnly = 0;
  let manualAdjustment = 0;
  let verifiableProducts = 0;
  let checkedProducts = 0;
  let notSampled = 0;
  let hardQtyMismatches = 0;
  let seasonReportedRetail = 0;
  let seasonRetailDrift = 0;

  function record(row, field, expected, actual, source, dollar) {
    const delta = round2(num(actual) - num(expected));
    mismatches.push({
      pid: row.pid,
      sku: row.sku || "",
      field,
      expected: dollar ? round2(expected) : num(expected),
      actual: dollar ? round2(actual) : num(actual),
      source,
      delta,
    });
    byField[field] += 1;
    driftedSet.add(String(row.pid));
    if (HARD_QTY_FIELDS.has(field)) hardQtyMismatches += 1;
  }

  for (const row of rows || []) {
    const sku = row.sku || "";

    if (row.pid == null) {
      datatailOnly += 1;
      skipped.push({ pid: null, sku, reason: SKIP_REASONS.DATATAIL_ONLY });
      continue;
    }
    if (row.inventoryMismatch) {
      manualAdjustment += 1;
      skipped.push({ pid: row.pid, sku, reason: SKIP_REASONS.MANUAL_ADJUSTMENT });
      continue;
    }

    verifiableProducts += 1;
    seasonReportedRetail += rowReportedRetail(row);

    if (sampledSet && !sampledSet.has(String(row.pid))) {
      notSampled += 1;
      skipped.push({ pid: row.pid, sku, reason: SKIP_REASONS.NOT_SAMPLED });
      continue;
    }
    checkedProducts += 1;

    const price = num(row.price);

    // On-hand — fresh live LS fetch vs the report's live on-hand.
    const expectedOnHand = row.liveOnHand;
    if (
      Object.prototype.hasOwnProperty.call(freshOnHand, String(row.pid)) &&
      expectedOnHand != null
    ) {
      const actual = num(freshOnHand[String(row.pid)]);
      if (actual !== num(expectedOnHand)) {
        record(row, "onHand", num(expectedOnHand), actual, "inventory", false);
        seasonRetailDrift += Math.abs(actual - num(expectedOnHand)) * price;
      }
    } else {
      skipped.push({
        pid: row.pid,
        sku,
        field: "onHand",
        reason: SKIP_REASONS.NO_FRESH_DATA,
      });
    }

    // Consignments — re-summed SUPPLIER/RETURN qty vs the report (exact).
    const fc = freshConsign[String(row.pid)] || {};
    const consignChecks = [
      ["qtyOrdered", num(row.lsOrderedQty), num(fc.qtyOrdered)],
      ["qtyReceived", num(row.receivedRaw), num(fc.qtyReceived)],
      ["retQty", num(row.retQty), num(fc.qtyReturned)],
    ];
    for (const [field, expected, actual] of consignChecks) {
      if (actual !== expected) {
        record(row, field, expected, actual, "consignment", false);
        seasonRetailDrift += Math.abs(actual - expected) * price;
      }
    }

    // Sales — re-run saleContribution (via the store aggregate) vs the report.
    const fs = freshSales[String(row.pid)] || {};
    if (num(fs.sold) !== num(row.sold)) {
      record(row, "sold", num(row.sold), num(fs.sold), "sales", false);
      seasonRetailDrift += Math.abs(num(fs.sold) - num(row.sold)) * price;
    }
    if (num(fs.onSale) !== num(row.onSale)) {
      record(row, "onSale", num(row.onSale), num(fs.onSale), "sales", false);
    }
    if (!withinDollarTolerance(row.saleAmt, fs.saleAmt, row.onSale, t)) {
      record(row, "saleAmt", num(row.saleAmt), num(fs.saleAmt), "sales", true);
      seasonRetailDrift += Math.abs(num(fs.saleAmt) - num(row.saleAmt));
    }
  }

  const report = {
    season: season || null,
    checkedAt,
    mode: sampledSet ? "sample" : "full",
    counts: {
      totalRows: (rows || []).length,
      datatailOnly,
      manualAdjustment,
      verifiableProducts,
      checkedProducts,
      notSampled,
      driftedProducts: driftedSet.size,
      mismatchCount: mismatches.length,
      hardQtyMismatches,
      byField,
      seasonReportedRetail: round2(seasonReportedRetail),
      seasonRetailDrift: round2(seasonRetailDrift),
      seasonRetailDriftRatio:
        seasonReportedRetail > 0 ? seasonRetailDrift / seasonReportedRetail : 0,
    },
    mismatches,
    skipped,
  };
  report.drift = evaluateDrift(report, t);
  return report;
}
