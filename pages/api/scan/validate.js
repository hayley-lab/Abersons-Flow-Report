// LS-based flow-report validation harness (accuracy-assurance plan §4 Layer 3).
//
// For a given season this re-derives expected values independently from
// Lightspeed and diffs them against the persisted scan:data rows that the report
// serves (the canonical rows from lib/flow-rollup.buildAllRows — the same path
// pages/api/scan/data.js uses):
//   1. fresh LS live on-hand (2.0/products/{id}/inventory) vs the row liveOnHand
//   2. re-summed LS SUPPLIER/RETURN consignments (re-projected from the LS
//      consignment store cache) vs qtyOrdered / qtyReceived / retQty
//   3. re-run saleContribution over the season's sales (via the LS sales store
//      aggregate) vs sold / onSale / saleAmt
//
// Quantities are compared exactly; dollars within a tolerance. Datatail-only
// pids (no LS product) and manual-LS-adjustment rows (inventoryMismatch) are
// reported as skipped, never failures — they are not LS-verifiable.
//
// On-demand (staff) and budgeted nightly-sample modes are both supported. Only
// the live on-hand check issues LS calls (one per sampled pid, deadline-bounded
// like the other scan routes); consignment + sales re-derivation read the
// LS-sourced store caches with zero LS paging.
//
// Auth matches the other scan routes: CRON_SECRET bearer OR iron-session.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { isLsDeadlineError, makeLsFetch } from "../../../lib/ls-fetch";
import { buildAllRows, rowsForVendor } from "../../../lib/flow-rollup";
import { seasonScanDateRange } from "../../../lib/flow-math";
import { loadConsignEntries, seasonConsignmentBuckets } from "../../../lib/consignment-store";
import { loadSalesAgg, projectSeasonSales } from "../../../lib/sales-store";
import {
  buildValidationReport,
  DEFAULT_THRESHOLDS,
  evaluateDrift,
  samplePids,
} from "../../../lib/report-validate";
import { loadValidationHistory, persistValidation } from "../../../lib/validation-history";

// Under the 60s maxDuration; leaves headroom for KV reads + JSON serialization.
const BUDGET_MS = 50000;
const DEFAULT_SAMPLE = 150;

function parseKv(val) {
  if (!val) return null;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}

async function loadOverride(season) {
  const [storesRaw, indexRaw] = await Promise.all([
    kv.get(`scan:override:${season}:stores`),
    kv.get(`scan:override:${season}:vendorIndex`),
  ]);
  if (!indexRaw) return null;
  const vendorIndex = parseKv(indexRaw);
  const stores = parseKv(storesRaw) || {};
  if (!Array.isArray(vendorIndex)) return null;
  const vendorRaws = await Promise.all(
    vendorIndex.map((key) => kv.get(`scan:override:${season}:v:${key}`))
  );
  const vendors = {};
  vendorIndex.forEach((key, i) => {
    vendors[key] = parseKv(vendorRaws[i]);
  });
  return { stores, vendors };
}

async function fetchLiveOnHand(lsFetch, pid, deadline) {
  const inv = await lsFetch(`2.0/products/${pid}/inventory`, { deadline });
  const d = inv?.data || inv;
  if (Array.isArray(d)) {
    return d.reduce((s, r) => s + (Number(r?.current_amount ?? r?.count ?? 0) || 0), 0);
  }
  if (d?.current_amount != null) return Number(d.current_amount) || 0;
  if (d?.count != null) return Number(d.count) || 0;
  return null;
}

function buildFreshConsign(bucket) {
  const fresh = {};
  const pids = new Set([
    ...Object.keys(bucket?.pidToQtyOrdered || {}),
    ...Object.keys(bucket?.pidToQtyReceived || {}),
    ...Object.keys(bucket?.pidToQtyReturned || {}),
  ]);
  for (const pid of pids) {
    fresh[pid] = {
      qtyOrdered: bucket?.pidToQtyOrdered?.[pid] || 0,
      qtyReceived: bucket?.pidToQtyReceived?.[pid] || 0,
      qtyReturned: bucket?.pidToQtyReturned?.[pid] || 0,
    };
  }
  return fresh;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Not authenticated" });
  }

  const { season, vendor } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  // Read path: return the persisted drift trend without re-running the harness
  // (the Data Health trend + nav "last validated" age consume this).
  if (req.query.history === "1" || req.query.history === "true") {
    try {
      const { latest, history } = await loadValidationHistory(kv, season);
      return res.json({ season, latest, history });
    } catch (e) {
      return res.status(500).json({ error: "history read failed: " + e.message });
    }
  }

  const full = req.query.full === "1" || req.query.sample === "all";
  const sampleCap = full ? 0 : Math.max(1, parseInt(req.query.sample, 10) || DEFAULT_SAMPLE);

  // 1. Canonical rows — same source the report serves (data.js path).
  const [rawData, override] = await Promise.all([
    kv.get(`scan:data:${season}`),
    loadOverride(season),
  ]);
  if (!rawData && !override) {
    return res.status(404).json({ error: "No scan data for season" });
  }

  let rows;
  try {
    rows = buildAllRows(rawData, override);
  } catch (e) {
    return res.status(500).json({ error: "rows build failed: " + e.message });
  }
  if (vendor) rows = rowsForVendor(rows, { id: vendor, name: vendor }, null);

  // 2. Verifiable LS pids -> deterministic sample (full season unless capped).
  const verifiablePids = rows
    .filter((r) => r.pid != null && !r.inventoryMismatch)
    .map((r) => String(r.pid));
  const sampled = sampleCap ? samplePids(verifiablePids, sampleCap) : verifiablePids;

  // 3. Fresh consignment + sales re-derivation from the LS-sourced store caches
  //    (zero LS paging — mirrors the store-cache "build once, project per
  //    season" pattern). Re-projecting independently of scan:data catches
  //    scan-time / delta bugs (e.g. wrong-season projection, stale aggregates).
  const seasonPids = (rawData?.seasonPids || []).map(String);
  const scanRanges = { [season]: seasonScanDateRange(season) };
  const seasonPidSets = { [season]: new Set(seasonPids) };

  let freshConsign = {};
  let consignError = null;
  try {
    const entries = await loadConsignEntries(kv);
    const buckets = seasonConsignmentBuckets(entries, {
      seasons: [season],
      seasonPidSets,
      scanRanges,
    });
    freshConsign = buildFreshConsign(buckets[season]);
  } catch (e) {
    consignError = e.message;
  }

  let freshSales = {};
  let salesError = null;
  try {
    const agg = await loadSalesAgg(kv);
    freshSales = projectSeasonSales(agg, seasonPids);
  } catch (e) {
    salesError = e.message;
  }

  // 4. Fresh live on-hand — one LS call per sampled pid, deadline-bounded.
  const freshOnHand = {};
  let onHandFetched = 0;
  let onHandBudgetExhausted = false;
  let lsCalls = null;
  let lsError = null;
  try {
    const token = await getLsToken();
    const lsFetch = makeLsFetch({
      base: lsBase(),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const deadline = Date.now() + BUDGET_MS;
    for (const pid of sampled) {
      if (Date.now() >= deadline) {
        onHandBudgetExhausted = true;
        break;
      }
      try {
        const live = await fetchLiveOnHand(lsFetch, pid, deadline);
        if (live != null) {
          freshOnHand[pid] = live;
          onHandFetched += 1;
        }
      } catch (e) {
        if (isLsDeadlineError(e)) {
          onHandBudgetExhausted = true;
          break;
        }
        // Individual product fetch error: leave unfetched (reported no-fresh-data).
      }
    }
    lsCalls = lsFetch.callStats;
  } catch (e) {
    lsError = e.message;
  }

  // 5. Diff + threshold.
  const report = buildValidationReport({
    season,
    rows,
    freshOnHand,
    freshConsign,
    freshSales,
    sampledPids: sampleCap ? sampled : null,
    thresholds: DEFAULT_THRESHOLDS,
    checkedAt: Date.now(),
  });
  report.drift = evaluateDrift(report);

  // 6. Persist the compact drift record so the Data Health trend + nightly
  //    GitHub Action both populate history. Only whole-season runs are stored
  //    (a vendor-filtered run is a partial slice and would pollute the trend).
  //    Best-effort: a KV hiccup must never fail the validation response.
  let persisted = false;
  if (!vendor) {
    try {
      await persistValidation(kv, season, report);
      persisted = true;
    } catch {
      persisted = false;
    }
  }

  return res.json({
    ...report,
    vendor: vendor || null,
    sampleSize: sampled.length,
    onHandFetched,
    onHandBudgetExhausted,
    persisted,
    consignError,
    salesError,
    lsError,
    calls: lsCalls,
  });
}
