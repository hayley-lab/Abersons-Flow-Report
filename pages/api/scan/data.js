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

function decodeHtml(s) {
  return (s || "").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#039;/gi, "'");
}

function normName(s) {
  return (s || "").replace(/&[a-z]+;/gi, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mergeOverride(data, override) {
  if (!override) return data;
  if (!data) data = { summaryRows: [], deptVendors: {} };

  // Given an override vendor's product list (from datatail), compute returned retail
  // and cost by looking up each product's full SKU directly in skuToPid → productStats.
  // The override "style" field stores the full LS SKU (e.g. "cafmrhalo/s2601").
  // Returns null if no SKUs matched — fall back to LS supplier rollup.
  const skuToPid = data.skuToPid || {};
  const productStats = data.productStats || {};
  function computeReturnedFromSkus(ovProducts) {
    let retVal = 0, retCost = 0, matched = 0;
    for (const op of (ovProducts || [])) {
      const sku = (op.style || "").toLowerCase().trim();
      if (!sku) continue;
      const pid = skuToPid[sku];
      if (pid && productStats[pid]) {
        const ps  = productStats[pid];
        const qty = ps.retQty || 0;
        // Fall back to override product price × retQty when retVal wasn't computed during scan
        // (happens for datatail-only products whose LS price wasn't available at scan time)
        const fallbackPrice = parseFloat(op.price || 0);
        retVal  += ps.retVal  > 0 ? ps.retVal  : (qty > 0 && fallbackPrice > 0 ? fallbackPrice * qty : 0);
        retCost += ps.retCost || 0;
        matched++;
      }
    }
    return matched > 0 ? { retVal, retCost } : null;
  }

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
      name:         ls ? ls.name : decodeHtml(ov.name),
      ordered:      ls && ls.ordered  > 0 ? ls.ordered  : (ov.ordered  || 0),
      orderedCost:  ls ? (ls.orderedCost  || 0) : 0,
      received:     ls && ls.received > 0 ? ls.received : (ov.received || 0),
      cost:         ls ? (ls.cost         || 0) : 0,
      returned:     ls ? (ls.returned     || 0) : 0,
      returnedCost: ls ? (ls.returnedCost || 0) : 0,
      sold:         ls ? (ls.sold || 0) : (ov.sold || 0),
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

    // Track which LS vendors were consumed by override matching so they don't appear twice
    const consumedLsVendors = new Set();

    // Find the LS vendor entry for an override vendor by exact normalized name.
    function findLsVendor(ovName) {
      const ovNorm = normName(ovName);
      if (lsVendors[ovNorm]) return { key: ovNorm, vendor: lsVendors[ovNorm] };
      return null;
    }

    deptVendors[deptId] = ovVendors.map(ov => {
      const match = findLsVendor(ov.vendorName);
      const ls = match ? match.vendor : null;
      if (match) consumedLsVendors.add(match.key);

      // Compute returns from product-level SKU matching so returns are attributed to
      // whichever override vendor owns the products, regardless of LS supplier name.
      // (Two brands can share the same LS supplier — e.g. Judi Powers / Judi Powers Consignment.)
      const skuReturns = computeReturnedFromSkus(ov.products);

      return {
        id:               ls ? ls.id : ov.vendorId,
        name:             ls ? ls.name : decodeHtml(ov.vendorName),
        ordered:          ls && ls.ordered  > 0 ? ls.ordered  : (ov.ordered  || 0),
        orderedCost:      ls ? (ls.orderedCost  || 0) : 0,
        received:         ls && ls.received > 0 ? ls.received : (ov.received || 0),
        cost:             ls ? (ls.cost         || 0) : 0,
        returned:         skuReturns ? skuReturns.retVal  : (ls ? (ls.returned     || 0) : 0),
        returnedCost:     skuReturns ? skuReturns.retCost : (ls ? (ls.returnedCost || 0) : 0),
        sold:             ls ? (ls.sold || 0) : (ov.sold || 0),
        overrideProducts: ov.products || [],
      };
    });

    // Also add any LS vendors not consumed by override matching
    Object.entries(lsVendors).forEach(([vNorm, ls]) => {
      if (!consumedLsVendors.has(vNorm)) deptVendors[deptId].push(ls);
    });
  });

  // Preserve any LS depts not in override (vendors and summaryRows)
  const lsDeptRowById = {};
  (data.summaryRows || []).forEach(r => { lsDeptRowById[r.id] = r; });
  Object.entries(data.deptVendors || {}).forEach(([deptId, vendors]) => {
    if (!deptVendors[deptId]) {
      deptVendors[deptId] = vendors;
      // Also add to summaryRows if not already there
      if (!summaryRows.find(r => String(r.id) === String(deptId))) {
        const ls = lsDeptRowById[deptId];
        if (ls) summaryRows.push(ls);
      }
    }
  });

  // Rebuild summaryRows by summing deptVendors so dept totals always match vendor drilldown
  const rebuiltSummaryRows = summaryRows.map(row => {
    const vendors = deptVendors[row.id] || [];
    if (vendors.length === 0) return row;
    return {
      ...row,
      ordered:      vendors.reduce((a, v) => a + (v.ordered      || 0), 0),
      orderedCost:  vendors.reduce((a, v) => a + (v.orderedCost  || 0), 0),
      received:     vendors.reduce((a, v) => a + (v.received     || 0), 0),
      cost:         vendors.reduce((a, v) => a + (v.cost         || 0), 0),
      returned:     vendors.reduce((a, v) => a + (v.returned     || 0), 0),
      returnedCost: vendors.reduce((a, v) => a + (v.returnedCost || 0), 0),
      sold:         vendors.reduce((a, v) => a + (v.sold         || 0), 0),
    };
  });

  return { ...data, summaryRows: rebuiltSummaryRows, deptVendors };
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
