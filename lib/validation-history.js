// Persisted validation drift history (accuracy-assurance plan §4 Layer 4 —
// validation-history todo). Every /api/scan/validate run for a whole season
// writes a COMPACT record to KV so the in-app Data Health surface can show a
// drift trend and the nav badge can surface a "last validated" age, without
// re-running the (LS-paging) harness.
//
// Two keys per season, mirroring the existing scan KV patterns:
//   scan:validation:{season}          — the latest compact record.
//   scan:validation:history:{season}  — a bounded rolling list of the last N
//                                       records (oldest dropped).
//
// Only the compact summary is stored (counts + drift verdict + checkedAt +
// mode) — NEVER the full per-row mismatch/skip arrays — so the records stay
// small. The record keeps a `drift: { tripped, reasons }` shape so it plugs
// straight into deriveHealthBadge (lib/health-status.js) and the existing
// Data Health UI which reads validation.drift / validation.counts.

export const VALIDATION_HISTORY_MAX = 30;
// History should outlive scan:data (48h) so the trend survives day to day; a
// nightly run keeps ~30 records inside this window.
export const VALIDATION_HISTORY_TTL_SECONDS = 90 * 24 * 3600;

export function validationLatestKey(season) {
  return `scan:validation:${season}`;
}

export function validationHistoryKey(season) {
  return `scan:validation:history:${season}`;
}

function parseKv(val) {
  if (val == null) return null;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}

function num(x) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

// Shape a full validation report (lib/report-validate.buildValidationReport)
// into the compact persisted record. Drops the per-row mismatches/skipped
// arrays and the endpoint-only diagnostics; keeps the counts, drift verdict,
// timestamp and mode.
export function toHistoryRecord(report) {
  if (!report) return null;
  const c = report.counts || {};
  const drift = report.drift || {};
  return {
    season: report.season ?? null,
    checkedAt: report.checkedAt ?? Date.now(),
    mode: report.mode || "full",
    drift: {
      tripped: !!drift.tripped,
      reasons: Array.isArray(drift.reasons)
        ? drift.reasons.map((r) => ({
            code: r.code || "drift",
            detail: r.detail || r.code || "drift",
          }))
        : [],
    },
    counts: {
      totalRows: num(c.totalRows),
      datatailOnly: num(c.datatailOnly),
      manualAdjustment: num(c.manualAdjustment),
      verifiableProducts: num(c.verifiableProducts),
      checkedProducts: num(c.checkedProducts),
      driftedProducts: num(c.driftedProducts),
      mismatchCount: num(c.mismatchCount),
      hardQtyMismatches: num(c.hardQtyMismatches),
      seasonReportedRetail: num(c.seasonReportedRetail),
      seasonRetailDrift: num(c.seasonRetailDrift),
      seasonRetailDriftRatio: num(c.seasonRetailDriftRatio),
    },
  };
}

// Append a record to a bounded rolling history, dropping the oldest entries
// beyond `max`. Pure — callers persist the returned list.
export function appendHistory(history, record, max = VALIDATION_HISTORY_MAX) {
  const list = Array.isArray(history) ? history.slice() : [];
  if (record) list.push(record);
  if (max > 0 && list.length > max) return list.slice(list.length - max);
  return list;
}

// Read-modify-write a season's validation history: append the report's compact
// record, trim to the bound, and persist both the latest and the rolling list
// with a TTL. Best-effort callers should wrap this in try/catch so a KV hiccup
// never fails the validation response.
export async function persistValidation(kv, season, report, opts = {}) {
  const max = opts.max ?? VALIDATION_HISTORY_MAX;
  const ttl = opts.ttl ?? VALIDATION_HISTORY_TTL_SECONDS;
  const record = toHistoryRecord(report);
  if (!record) return { record: null, history: [] };
  const prev = parseKv(await kv.get(validationHistoryKey(season)));
  const history = appendHistory(prev, record, max);
  await Promise.all([
    kv.set(validationLatestKey(season), record, { ex: ttl }),
    kv.set(validationHistoryKey(season), history, { ex: ttl }),
  ]);
  return { record, history };
}

// Fetch the persisted latest record + rolling history for a season (the GET
// read path behind /api/scan/validate?history=1 and the Data Health trend).
export async function loadValidationHistory(kv, season) {
  const [latestRaw, historyRaw] = await Promise.all([
    kv.get(validationLatestKey(season)),
    kv.get(validationHistoryKey(season)),
  ]);
  const history = parseKv(historyRaw);
  return {
    latest: parseKv(latestRaw),
    history: Array.isArray(history) ? history : [],
  };
}
