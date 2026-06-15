// Returns report data for the requested season.
//
// This is the normal UI read path: load raw scan:data + optional datatail
// override records from KV, then run the request-time rollup so summary rows,
// department/vendor lists, and product rows all share the same bottom-up math.
// Keep this path aligned with validate/reconcile endpoints when adding new
// canonical row fields.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { buildAllRows, rollup } from "../../../lib/flow-rollup";
import { loadScanData } from "../../../lib/scan-data-store";
import { getLsHealth } from "../../../lib/ls-auth";

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

  // Load all vendor entries in parallel
  const vendorRaws = await Promise.all(
    vendorIndex.map((key) => kv.get(`scan:override:${season}:v:${key}`))
  );
  const vendors = {};
  vendorIndex.forEach((key, i) => {
    vendors[key] = parseKv(vendorRaws[i]);
  });

  return { stores, vendors };
}

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const [rawData, job, override, lsHealth] = await Promise.all([
    loadScanData(kv, season),
    kv.get(`scan:job:${season}`),
    loadOverride(season),
    getLsHealth(),
  ]);

  let data = rawData || null;
  let mergeError = null;
  const since = req.query.since ? Number(req.query.since) : null;
  if (since && data?.ts && data.ts <= since && (!job || job.phase === "done")) {
    return res.json({
      data: null,
      job: job ? { phase: job.phase, progress: job.progress, error: job.error } : null,
      hasOverride: !!override,
      lsHealth: lsHealth || null,
      notModified: true,
    });
  }

  // Authoritative rollup: derive summary/department/vendor totals bottom-up from
  // one canonical set of per-product rows (lib/flow-rollup.js). Runs for every
  // season — with or without a datatail override — so all three pages share the
  // same math and grouping (also fixes the full-scan-vs-delta vendor grouping
  // mismatch, since grouping now happens here at request time).
  if (rawData || override) {
    try {
      const rows = buildAllRows(rawData, override, { season });
      const { summaryRows, deptVendors } = rollup(rows, rawData, override, { season });
      data = { ...(rawData || {}), season, summaryRows, deptVendors, rows };
    } catch (e) {
      console.error("rollup error", e);
      mergeError = e.message;
      data = rawData
        ? {
            ...rawData,
            mergeError,
            rollupDegraded: true,
            totalsDegraded: true,
          }
        : {
            season,
            ts: null,
            summaryRows: [],
            deptVendors: {},
            rows: [],
            mergeError,
            rollupDegraded: true,
            totalsDegraded: true,
          };
    }
  }

  if (data && req.query.view === "summary") {
    data = {
      ts: data.ts,
      season: data.season,
      summaryRows: data.summaryRows || [],
      deptVendors: data.deptVendors || {},
      isDelta: data.isDelta || false,
      salesState: data.salesState || null,
      mergeError: data.mergeError || null,
      rollupDegraded: !!data.rollupDegraded,
      totalsDegraded: !!data.totalsDegraded,
    };
  }

  return res.json({
    data: data || null,
    job: job ? { phase: job.phase, progress: job.progress, error: job.error } : null,
    hasOverride: !!override,
    lsHealth: lsHealth || null,
    mergeError,
    rollupDegraded: !!data?.rollupDegraded,
    totalsDegraded: !!data?.totalsDegraded,
  });
}
