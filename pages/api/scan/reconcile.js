// Old-report reconciliation endpoint.
//
// This is a read-only Data Health check: load imported datatailor override
// records from KV, build the same canonical rows as /api/scan/data, and diff the
// new Lightspeed rollup against the old-report ground truth. No LS calls.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { buildAllRows, rollup } from "../../../lib/flow-rollup";
import { buildReconciliationReport } from "../../../lib/report-reconcile";
import { loadScanData } from "../../../lib/scan-data-store";

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

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Not authenticated" });
  }

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const [rawData, override] = await Promise.all([loadScanData(kv, season), loadOverride(season)]);
  if (!rawData && !override) {
    return res.status(404).json({ error: "No scan or old-report data for season" });
  }
  if (!override) {
    return res.status(404).json({
      error:
        "No old-report import found for this season. Reconciliation requires scan:override data.",
      season,
    });
  }

  try {
    const rows = buildAllRows(rawData, override, { season });
    const rollupResult = rollup(rows, rawData, override, { season });
    const report = buildReconciliationReport({
      season,
      rows,
      override,
      rollupResult,
      checkedAt: Date.now(),
    });
    return res.json(report);
  } catch (e) {
    return res.status(500).json({ error: "reconciliation failed: " + e.message });
  }
}
