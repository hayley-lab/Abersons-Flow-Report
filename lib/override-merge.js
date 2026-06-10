// Merges imported "datatail" (old RMH) override data with the LS scan result.
// Hard-pull ordered/received values represent old POs that never made it into
// LS — they ADD to LS values, but a PO present in both sources must not be
// double-counted. Vendor returns are attributed by SKU so brands that share a
// single LS supplier id are split correctly.

export function decodeHtml(s) {
  return (s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'");
}

export function normName(s) {
  return (s || "")
    .replace(/&[a-z]+;/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function mergeOverride(data, override) {
  if (!override) return data;
  if (!data) data = { summaryRows: [], deptVendors: {} };

  const skuToPid = data.skuToPid || {};
  const productStats = data.productStats || {};
  const pidToPrice = data.pidToPrice || {};

  // Compute returned retail/cost for an override vendor's product list by looking
  // up each full SKU in skuToPid → productStats. Returns null when nothing
  // matched so the caller falls back to the LS supplier rollup.
  function computeReturnedFromSkus(ovProducts) {
    let retVal = 0,
      retCost = 0,
      matched = 0;
    for (const op of ovProducts || []) {
      const sku = (op.style || "").toLowerCase().trim();
      if (!sku) continue;
      const pid = skuToPid[sku];
      if (pid && productStats[pid]) {
        const ps = productStats[pid];
        const qty = ps.retQty || 0;
        // Fallback price chain: override product price → pidToPrice from scan
        const fallbackPrice = parseFloat(op.price || 0) || pidToPrice[pid] || 0;
        retVal +=
          ps.retVal > 0 ? ps.retVal : qty > 0 && fallbackPrice > 0 ? fallbackPrice * qty : 0;
        retCost += ps.retCost || 0;
        matched++;
      }
    }
    return matched > 0 ? { retVal, retCost } : null;
  }

  // True when at least one of the override vendor's SKUs already has LS PO or
  // return activity — meaning the same PO exists in both sources.
  function hasLsOverlap(ovProducts) {
    return (ovProducts || []).some((op) => {
      const sku = (op.style || "").toLowerCase().trim();
      const pid = skuToPid[sku];
      const ps = pid ? productStats[pid] : null;
      return !!(
        ps &&
        ((ps.qtyOrdered || 0) > 0 || (ps.qtyReceived || 0) > 0 || (ps.retQty || 0) > 0)
      );
    });
  }

  // Hard pull adds to LS, but when the same PO exists in both sources keep the
  // larger of the two instead of summing (avoids double-counting).
  function combineDollarValue(lsValue, overrideValue, overlap) {
    const lsAmount = lsValue || 0;
    const overrideAmount = overrideValue || 0;
    return overlap ? Math.max(lsAmount, overrideAmount) : lsAmount + overrideAmount;
  }

  // Build LS lookup maps by normalized name
  const lsDeptByName = {};
  (data.summaryRows || []).forEach((r) => {
    lsDeptByName[normName(r.name)] = r;
  });

  const lsVendorByDeptAndName = {};
  Object.entries(data.deptVendors || {}).forEach(([deptId, vendors]) => {
    const deptRow = (data.summaryRows || []).find((r) => String(r.id) === String(deptId));
    const dk = deptRow ? normName(deptRow.name) : deptId;
    lsVendorByDeptAndName[dk] = {};
    (vendors || []).forEach((v) => {
      lsVendorByDeptAndName[dk][normName(v.name)] = v;
    });
  });

  const summaryRows = Object.values(override.stores).map((ov) => {
    const ls = lsDeptByName[normName(ov.name)];
    return {
      id: ls ? ls.id : ov.id,
      name: ls ? ls.name : decodeHtml(ov.name),
      ordered: (ls ? ls.ordered || 0 : 0) + (ov.ordered || 0),
      orderedCost: ls ? ls.orderedCost || 0 : 0,
      received: (ls ? ls.received || 0 : 0) + (ov.received || 0),
      cost: ls ? ls.cost || 0 : 0,
      returned: ls ? ls.returned || 0 : 0,
      returnedCost: ls ? ls.returnedCost || 0 : 0,
      sold: ls ? ls.sold || 0 : ov.sold || 0,
    };
  });

  // Need dept name → id mapping from summaryRows
  const deptIdByName = {};
  summaryRows.forEach((r) => {
    deptIdByName[normName(r.name)] = r.id;
  });

  const deptVendors = {};
  // Group override vendors by dept
  const overrideByDept = {};
  Object.values(override.vendors).forEach((v) => {
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

    deptVendors[deptId] = ovVendors.map((ov) => {
      const match = findLsVendor(ov.vendorName);
      const ls = match ? match.vendor : null;
      if (match) consumedLsVendors.add(match.key);

      // SKU-attributed returns replace the LS supplier rollup when matched so
      // returns land on the brand that owns the products, even when two brands
      // share one LS supplier (e.g. Judi Powers / Judi Powers Consignment).
      const skuReturns = computeReturnedFromSkus(ov.products);
      const overlap = hasLsOverlap(ov.products);
      const lsReturned = ls ? ls.returned || 0 : 0;
      const lsReturnedCost = ls ? ls.returnedCost || 0 : 0;

      return {
        id: ls ? ls.id : ov.vendorId,
        name: ls ? ls.name : decodeHtml(ov.vendorName),
        ordered: combineDollarValue(ls ? ls.ordered : 0, ov.ordered, overlap),
        orderedCost: ls ? ls.orderedCost || 0 : 0,
        received: combineDollarValue(ls ? ls.received : 0, ov.received, overlap),
        cost: ls ? ls.cost || 0 : 0,
        returned: skuReturns ? skuReturns.retVal || lsReturned : lsReturned,
        returnedCost: skuReturns ? skuReturns.retCost || lsReturnedCost : lsReturnedCost,
        sold: ls ? ls.sold || 0 : ov.sold || 0,
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
  (data.summaryRows || []).forEach((r) => {
    lsDeptRowById[r.id] = r;
  });
  Object.entries(data.deptVendors || {}).forEach(([deptId, vendors]) => {
    if (!deptVendors[deptId]) {
      deptVendors[deptId] = vendors;
      if (!summaryRows.find((r) => String(r.id) === String(deptId))) {
        const ls = lsDeptRowById[deptId];
        if (ls) summaryRows.push(ls);
      }
    }
  });

  // Rebuild summaryRows by summing deptVendors so dept totals always match the
  // vendor drilldown.
  const rebuiltSummaryRows = summaryRows.map((row) => {
    const vendors = deptVendors[row.id] || [];
    if (vendors.length === 0) return row;
    return {
      ...row,
      ordered: vendors.reduce((a, v) => a + (v.ordered || 0), 0),
      orderedCost: vendors.reduce((a, v) => a + (v.orderedCost || 0), 0),
      received: vendors.reduce((a, v) => a + (v.received || 0), 0),
      cost: vendors.reduce((a, v) => a + (v.cost || 0), 0),
      returned: vendors.reduce((a, v) => a + (v.returned || 0), 0),
      returnedCost: vendors.reduce((a, v) => a + (v.returnedCost || 0), 0),
      sold: vendors.reduce((a, v) => a + (v.sold || 0), 0),
    };
  });

  return { ...data, summaryRows: rebuiltSummaryRows, deptVendors };
}
