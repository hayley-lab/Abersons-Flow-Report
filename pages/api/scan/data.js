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
  return (s || "").replace(/&[a-z]+;/gi, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mergeOverride(data, override) {
  if (!override) return data;
  if (!data) data = { summaryRows: [], deptVendors: {} };

  // Build LS lookup maps by normalized name
  const lsDeptByName = {};
  (data.summaryRows || []).forEach(r => { lsDeptByName[normName(r.name)] = r; });

  const lsVendorByDeptAndName = {};
  Object.entries(data.deptVendors || {}).forEach(([deptId, vendors]) => {
    const deptRow = (data.summaryRows || []).find(r => String(r.id) === String(deptId));
    const dk = deptRow ? normName(deptRow.name) : deptId;
    lsVendorByDeptAndName[dk] = {};
    (vendors || []).forEach(v => { lsVendorByDeptAndName[dk][normName(v.name)] = v; });
  });

  // Build summaryRows from override as primary, supplement with LS sold amounts
  const summaryRows = Object.values(override.stores).map(ov => {
    const ls = lsDeptByName[normName(ov.name)];
    return {
      id:           ls ? ls.id : ov.id,
      name:         ov.name,
      ordered:      ov.ordered  || 0,
      orderedCost:  ls ? (ls.orderedCost  || 0) : 0,
      received:     ov.received || (ls ? (ls.received || 0) : 0),
      cost:         ls ? (ls.cost         || 0) : 0,
      returned:     ls ? (ls.returned     || 0) : 0,
      returnedCost: ls ? (ls.returnedCost || 0) : 0,
      sold:         ls ? (ls.sold || ov.sold || 0) : (ov.sold || 0),
    };
  });

  // Build deptVendors from override as primary, supplement with LS sold amounts
  // Need dept name → id mapping from summaryRows
  const deptIdByName = {};
  summaryRows.forEach(r => { deptIdByName[normName(r.name)] = r.id; });

  const deptVendors = {};
  // Group override vendors by dept
  const overrideByDept = {};
  Object.values(override.vendors).forEach(v => {
    if (!v) return;
    const dk = normName(v.deptName);
    if (!overrideByDept[dk]) overrideByDept[dk] = [];
    overrideByDept[dk].push(v);
  });

  Object.entries(overrideByDept).forEach(([deptNorm, ovVendors]) => {
    const deptId = deptIdByName[deptNorm];
    if (!deptId) return;
    const lsVendors = lsVendorByDeptAndName[deptNorm] || {};

    deptVendors[deptId] = ovVendors.map(ov => {
      const ls = lsVendors[normName(ov.vendorName)];
      return {
        id:               ls ? ls.id : ov.vendorId,
        name:             ov.vendorName,
        ordered:          ov.ordered  || 0,
        orderedCost:      ls ? (ls.orderedCost  || 0) : 0,
        received:         ov.received || (ls ? (ls.received || 0) : 0),
        cost:             ls ? (ls.cost         || 0) : 0,
        returned:         ls ? (ls.returned     || 0) : 0,
        returnedCost:     ls ? (ls.returnedCost || 0) : 0,
        sold:             ls ? (ls.sold || ov.sold || 0) : (ov.sold || 0),
        overrideProducts: ov.products || [],
      };
    });

    // Also add any LS vendors not in override
    Object.entries(lsVendors).forEach(([vNorm, ls]) => {
      const already = ovVendors.some(ov => normName(ov.vendorName) === vNorm);
      if (!already) deptVendors[deptId].push(ls);
    });
  });

  // Preserve any LS depts not in override
  Object.entries(data.deptVendors || {}).forEach(([deptId, vendors]) => {
    if (!deptVendors[deptId]) deptVendors[deptId] = vendors;
  });

  return { ...data, summaryRows, deptVendors };
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
