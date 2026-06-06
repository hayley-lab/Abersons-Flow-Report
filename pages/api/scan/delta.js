// Delta (incremental) scan — reuses existing PO/returns data from a completed
// full scan and re-processes only sales. Much faster than a full scan (~2-5 min
// vs ~40 min) because it skips product catalog, PO, and returns phases.
//
// Requires a completed scan:data:{season} to exist. If none exists, returns
// an error so the caller knows to run a full scan first.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

const MAX_DURATION_MS = 55_000; // stay under 60s function limit

const SEASON_START_CURSORS = {
  pf26: 50022000000,
};

function seasonSkuCodes(seasonId) {
  const m = seasonId.match(/^(prefall|fall|spring|prespring)(\d+)$/);
  if (!m) return [];
  const yy = m[2].slice(-2);
  if (m[1] === "prespring") return ["/rs" + yy, "/ps" + yy];
  if (m[1] === "prefall")   return ["/pf" + yy];
  if (m[1] === "fall") {
    const hasPreFall = SEASONS.some(s => s.id === `prefall${yy}`);
    return hasPreFall ? ["/f" + yy] : ["/f" + yy, "/pf" + yy];
  }
  if (m[1] === "spring") {
    const hasPreSpring = SEASONS.some(s => s.id === `prespring${yy}`);
    return hasPreSpring ? ["/s" + yy] : ["/s" + yy, "/rs" + yy, "/ps" + yy];
  }
  return [];
}

function seasonSalesDateFrom(seasonId) {
  const m = seasonId.match(/^(prefall|fall|prespring|spring)(\d{2})$/);
  if (!m) return null;
  const year = 2000 + parseInt(m[2]);
  const startMonth = (m[1] === "fall" || m[1] === "prefall") ? 8 : 2;
  const fromDate = new Date(year, startMonth - 1 - 9, 1);
  return fromDate.toISOString().slice(0, 10);
}

function getCursor(data, items) {
  const vfr = (data.version && typeof data.version === "object") ? data.version.max : null;
  const vfi = items.reduce((mx, i) => Math.max(mx, i.version || 0), 0);
  return (vfr !== null ? vfr : vfi) || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const cronAuth = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const session = cronAuth ? { authed: true } : await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const dataKey = `scan:data:${season}`;

  // Load existing full scan data — abort if none (caller should run full scan)
  const existing = await kv.get(dataKey);
  if (!existing || !existing.productStats || !existing.seasonPids) {
    return res.status(409).json({ error: "No base scan data found. Run a full scan first." });
  }

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ error: "LS auth failed: " + e.message });
  }

  const base    = lsBase();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const deadline = Date.now() + MAX_DURATION_MS;

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`LS ${r.status} /${path.split("?")[0]}: ${txt.slice(0, 120)}`);
    }
    return r.json();
  }

  try {
    // Clone productStats and reset all sales-derived fields, keeping PO/returns data
    const productStats = {};
    for (const [pid, ps] of Object.entries(existing.productStats)) {
      productStats[pid] = {
        ordered:      ps.ordered      || 0,
        orderedCost:  ps.orderedCost  || 0,
        received:     ps.received     || 0,
        receivedCost: ps.receivedCost || 0,
        retVal:       ps.retVal       || 0,
        retCost:      ps.retCost      || 0,
        _sup:         ps._sup         || undefined,
        // Sales fields reset to 0 — will be recomputed below
        soldAmt:   0,
        sold:      0,
        onSale:    0,
        returned:  0,
      };
    }

    const seasonPidSet   = new Set(existing.seasonPids);
    const pidToType      = existing.pidToType      || {};
    const pidToSupplier  = existing.pidToSupplier  || {};
    const pidToQtyOrdered = existing.pidToQtyOrdered || {};

    // Reconstruct pidToPrice from productStats received/ordered ratio
    // (pidToPrice is not stored in scan:data; approximate from PO data)
    const pidToPrice = {};
    for (const [pid, ps] of Object.entries(productStats)) {
      const qty = pidToQtyOrdered[pid] || 0;
      if (qty > 0 && ps.ordered > 0) pidToPrice[pid] = ps.ordered / qty;
    }

    // Re-fetch all sales for this season
    const skuBase = (seasonSkuCodes(season)[0] || "").replace(/\//g, "");
    const anchorVersion = skuBase && SEASON_START_CURSORS[skuBase] != null
      ? SEASON_START_CURSORS[skuBase] : null;

    const dateFrom  = seasonSalesDateFrom(season) || "";
    const dateParam = dateFrom ? "&date_from=" + dateFrom : "";
    let saleCursor  = anchorVersion ? Math.max(0, anchorVersion - 1_000_000) : null;
    let pages = 0;

    while (Date.now() < deadline) {
      const path = "2.0/sales?page_size=500" + dateParam + (saleCursor ? "&after=" + saleCursor : "");
      const data = await lsFetch(path);
      const saleItems = data.data || [];
      pages++;

      for (const sale of saleItems) {
        const saleStatus = (sale.status || "").toUpperCase().replace(/[\s,_-]/g, "");
        if (saleStatus === "OPEN" || saleStatus === "PARKED" || saleStatus === "LAYBY" || saleStatus === "LAYAWAY") continue;
        for (const li of (sale.line_items || [])) {
          if (!li.product_id || li.status === "VOIDED") continue;
          const pid = li.product_id;
          if (!seasonPidSet.has(pid)) continue;

          const qty    = parseInt(li.quantity || 1);
          const amount = li.total_price != null ? parseFloat(li.total_price) : parseFloat(li.price || 0);

          if (!productStats[pid]) {
            productStats[pid] = { ordered: 0, orderedCost: 0, received: 0, receivedCost: 0, retVal: 0, retCost: 0, soldAmt: 0, sold: 0, onSale: 0, returned: 0 };
          }
          const ps = productStats[pid];
          ps.soldAmt = (ps.soldAmt || 0) + amount;

          if (qty < 0) {
            ps.sold     = Math.max(0, (ps.sold || 0) + qty);
            ps.returned = (ps.returned || 0) + Math.abs(qty);
          } else {
            ps.sold += qty;
            const unitPrice   = qty > 0 ? amount / qty : 0;
            const retailPrice = pidToPrice[pid] || 0;
            const discounted  = parseFloat(li.discount || li.line_discount || li.discount_total || 0) > 0
              || amount === 0;
            if (discounted || (retailPrice > 0 && unitPrice < retailPrice * 0.99)) {
              ps.onSale += qty;
            }
          }
        }
      }

      if (saleItems.length < 500) break;
      const cursor = getCursor(data, saleItems);
      if (!cursor) break;
      saleCursor = cursor;
    }

    // Roll up productStats → deptVendorData
    const deptVendorData = {};
    for (const [pid, ps] of Object.entries(productStats)) {
      const cid = pidToType[pid]     || "__none__";
      const sup = pidToSupplier[pid] || ps._sup;
      if (!sup || sup.i === "__none__") continue;
      if (!deptVendorData[cid]) deptVendorData[cid] = {};
      if (!deptVendorData[cid][sup.i]) {
        deptVendorData[cid][sup.i] = { id: sup.i, name: sup.n, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
      }
      const v = deptVendorData[cid][sup.i];
      v.ordered      += ps.ordered      || 0;
      v.orderedCost  += ps.orderedCost  || 0;
      v.received     += ps.received     || 0;
      v.cost         += ps.receivedCost || 0;
      v.returned     += ps.retVal       || 0;
      v.returnedCost += ps.retCost      || 0;
      v.sold         += ps.soldAmt      || 0;
    }

    // Build summaryRows from deptVendorData
    // Preserve dept names from existing summaryRows
    const existingDeptNames = {};
    for (const r of (existing.summaryRows || [])) existingDeptNames[r.id] = r.name;

    const catMap = {};
    for (const [deptId, vendors] of Object.entries(deptVendorData)) {
      if (!catMap[deptId]) catMap[deptId] = { id: deptId, name: existingDeptNames[deptId] || "Other", ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
      for (const v of Object.values(vendors)) {
        catMap[deptId].ordered      += v.ordered;
        catMap[deptId].orderedCost  += v.orderedCost  || 0;
        catMap[deptId].received     += v.received;
        catMap[deptId].cost         += v.cost         || 0;
        catMap[deptId].returned     += v.returned     || 0;
        catMap[deptId].returnedCost += v.returnedCost || 0;
        catMap[deptId].sold         += v.sold;
      }
    }
    // Include depts from existing data that have no vendors (e.g. override-only depts)
    for (const r of (existing.summaryRows || [])) {
      if (!catMap[r.id]) catMap[r.id] = { ...r, ordered: r.ordered || 0, received: r.received || 0, sold: 0, returned: 0, returnedCost: 0 };
    }
    const summaryRows = Object.values(catMap).sort((a, b) => b.ordered - a.ordered);

    const deptVendors = {};
    for (const [deptId, vendors] of Object.entries(deptVendorData)) {
      deptVendors[deptId] = Object.values(vendors).sort((a, b) => b.ordered - a.ordered);
    }

    const result = {
      ...existing,
      ts:           Date.now(),
      summaryRows,
      deptVendors,
      productStats,
      isDelta:      true,  // flag so UI can show "quick refresh" label if desired
      salesPages:   pages,
    };

    await kv.set(dataKey, result, { ex: 48 * 3600 });
    return res.json({ ok: true, ts: result.ts, pages });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
