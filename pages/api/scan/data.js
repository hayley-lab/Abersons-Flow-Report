// Returns pre-computed scan data from KV for the requested season.
// For seasons with override data (Spring/Fall 2025), merges imported
// ordered/received values into the scan result.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

function parseKv(val) {
  if (!val) return null;
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return null; } }
  return val;
}

async function loadOverride(season) {
  const [storesRaw, indexRaw] = await Promise.all([
    kv.get(`scan:override:${season}:stores`),
    kv.get(`scan:override:${season}:vendorIndex`),
  ]);
  if (!indexRaw) return null;

  const vendorIndex = parseKv(indexRaw);
  const stores      = parseKv(storesRaw) || {};
  if (!Array.isArray(vendorIndex)) return null;

  // Load all vendor entries in parallel
  const vendorRaws = await Promise.all(
    vendorIndex.map(key => kv.get(`scan:override:${season}:v:${key}`))
  );
  const vendors = {};
  vendorIndex.forEach((key, i) => {
    vendors[key] = parseKv(vendorRaws[i]);
  });

  return { stores, vendors };
}

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mergeOverride(data, override) {
  if (!data || !override) return data;

  // Build lookup maps keyed by normalized name
  const storeByName = {};
  Object.values(override.stores).forEach(s => {
    storeByName[normName(s.name)] = s;
  });

  // Build vendor lookup: deptNormName → vendorNormName → vendor entry
  const vendorByDeptAndName = {};
  Object.values(override.vendors).forEach(v => {
    if (!v) return;
    const dk = normName(v.deptName);
    if (!vendorByDeptAndName[dk]) vendorByDeptAndName[dk] = {};
    vendorByDeptAndName[dk][normName(v.vendorName)] = v;
  });

  // Merge summaryRows
  const summaryRows = (data.summaryRows || []).map(row => {
    const ov = storeByName[normName(row.name)];
    if (!ov) return row;
    return {
      ...row,
      ordered:      ov.ordered  || row.ordered  || 0,
      received:     ov.received || row.received || 0,
      // Keep cost fields from scan (old system didn't track cost separately)
      orderedCost:  row.orderedCost || 0,
      cost:         row.cost        || 0,
    };
  });

  // If summaryRows is empty (no scan yet), build from override stores
  const effectiveSummaryRows = summaryRows.length > 0 ? summaryRows :
    Object.values(override.stores).map(s => ({
      id: s.id, name: s.name,
      ordered: s.ordered, received: s.received, sold: s.sold,
      orderedCost: 0, cost: 0,
    }));

  // Merge deptVendors
  const deptVendors = { ...(data.deptVendors || {}) };

  // For each dept in override, find the matching LS dept id
  const deptIdByName = {};
  effectiveSummaryRows.forEach(r => { deptIdByName[normName(r.name)] = r.id; });

  Object.entries(vendorByDeptAndName).forEach(([deptNorm, vendorMap]) => {
    const deptId = deptIdByName[deptNorm];
    const existingVendors = deptId ? (deptVendors[deptId] || []) : [];

    const merged = existingVendors.map(v => {
      const ov = vendorMap[normName(v.name)];
      if (!ov) return v;
      return {
        ...v,
        ordered:     ov.ordered  || v.ordered  || 0,
        received:    ov.received || v.received || 0,
        orderedCost: v.orderedCost || 0,
        cost:        v.cost       || 0,
      };
    });

    // Add any override vendors not found in LS scan
    const lsNormNames = new Set(existingVendors.map(v => normName(v.name)));
    Object.entries(vendorMap).forEach(([vNorm, ov]) => {
      if (!lsNormNames.has(vNorm) && ov) {
        merged.push({
          id: ov.vendorId, name: ov.vendorName,
          ordered: ov.ordered, received: ov.received, sold: ov.sold,
          orderedCost: 0, cost: 0,
        });
      }
    });

    if (deptId) deptVendors[deptId] = merged;
  });

  return { ...data, summaryRows: effectiveSummaryRows, deptVendors };
}

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const [rawData, job, override] = await Promise.all([
    kv.get(`scan:data:${season}`),
    kv.get(`scan:job:${season}`),
    loadOverride(season),
  ]);

  let data = rawData || null;
  if (override) { try { data = mergeOverride(rawData, override); } catch (e) { console.error("merge error", e); } }

  return res.json({
    data: data || null,
    job:  job  ? { phase: job.phase, progress: job.progress, error: job.error } : null,
    hasOverride: !!override,
  });
}
