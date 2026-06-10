// Delta (incremental) scan — reuses existing PO/returns data from a completed
// full scan and re-processes only sales. Much faster than a full scan (~2-5 min
// vs ~40 min) because it skips product catalog, PO, and returns phases.
//
// Requires a completed scan:data:{season} to exist. If none exists, returns
// an error so the caller knows to run a full scan first.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import {
  applySalesTotals,
  derivedOnHand,
  emptyProductStats,
  netOrderedValue,
  netReceivedValue,
} from "../../../lib/flow-math";
import { loadSalesState, reconcileSale, saveSalesState } from "../../../lib/sales-ledger";

const MAX_DURATION_MS = 55_000; // stay under 60s function limit

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
    // Clone productStats and reset sales-derived fields; ledger totals are applied below.
    const productStats = {};
    for (const [pid, ps] of Object.entries(existing.productStats)) {
      productStats[pid] = {
        ordered:      ps.ordered      || 0,
        orderedCost:  ps.orderedCost  || 0,
        received:     ps.received     || 0,
        receivedCost: ps.receivedCost || 0,
        retVal:       ps.retVal       || 0,
        retCost:      ps.retCost      || 0,
        retQty:       ps.retQty       || 0,
        qtyOrdered:   ps.qtyOrdered   || 0,
        qtyReceived:  ps.qtyReceived  || 0,
        onHand:       ps.onHand       || 0,
        _sup:         ps._sup         || undefined,
        // Sales fields reset to 0 — ledger totals are authoritative.
        soldAmt:   0,
        saleAmt:   0,
        sold:      0,
        onSale:    0,
        returned:  0,
      };
    }

    const seasonPidSet   = new Set(existing.seasonPids);
    const pidToType      = existing.pidToType      || {};
    const pidToSupplier  = existing.pidToSupplier  || {};
    const pidToQtyOrdered = existing.pidToQtyOrdered || {};
    const pidToQtyReceived = existing.pidToQtyReceived || {};
    const pidToQtyReturned = existing.pidToQtyReturned || {};
    const pidToPrice = existing.pidToPrice || {};
    const pidToCost = existing.pidToCost || {};

    const salesState = await loadSalesState(kv, season);
    if (!salesState.maxVersion) {
      return res.status(409).json({ error: "No sales ledger found. Run a full scan first." });
    }

    let saleCursor  = salesState.maxVersion;
    let pages = 0;

    while (Date.now() < deadline) {
      const path = "2.0/sales?page_size=500" + (saleCursor ? "&after=" + saleCursor : "");
      const data = await lsFetch(path);
      const saleItems = data.data || [];
      pages++;

      for (const sale of saleItems) {
        await reconcileSale(kv, season, salesState, sale, seasonPidSet, pidToPrice);
      }

      if (saleItems.length < 500) break;
      const cursor = getCursor(data, saleItems);
      if (!cursor) break;
      saleCursor = cursor;
    }

    await saveSalesState(kv, season, salesState, seasonPidSet);
    applySalesTotals(productStats, salesState.perPid);

    // Roll up productStats → deptVendorData
    const deptVendorData = {};
    for (const [pid, ps] of Object.entries(productStats)) {
      const cid = pidToType[pid]     || "__none__";
      const sup = pidToSupplier[pid] || ps._sup;
      if (!sup || sup.i === "__none__") continue;
      const price = pidToPrice[pid] || 0;
      const cost = pidToCost[pid] || 0;
      ps.qtyOrdered = ps.qtyOrdered || pidToQtyOrdered[pid] || 0;
      ps.qtyReceived = ps.qtyReceived || pidToQtyReceived[pid] || 0;
      ps.retQty = ps.retQty || pidToQtyReturned[pid] || 0;
      ps.ordered = price * ps.qtyOrdered;
      ps.orderedCost = cost * ps.qtyOrdered;
      ps.received = price * ps.qtyReceived;
      ps.receivedCost = cost * ps.qtyReceived;
      ps.retVal = price * ps.retQty;
      ps.retCost = cost * ps.retQty;
      ps.onHand = derivedOnHand(ps);
      ps.onOrder = Math.max(0, ps.qtyOrdered - ps.qtyReceived);
      if (!deptVendorData[cid]) deptVendorData[cid] = {};
      if (!deptVendorData[cid][sup.i]) {
        deptVendorData[cid][sup.i] = { id: sup.i, name: sup.n, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
      }
      const v = deptVendorData[cid][sup.i];
      v.ordered      += netOrderedValue(ps, price);
      v.orderedCost  += Math.max(0, ((ps.qtyOrdered || 0) - (ps.retQty || 0)) * cost);
      v.received     += netReceivedValue(ps, price);
      v.cost         += Math.max(0, ((ps.qtyReceived || 0) - (ps.retQty || 0)) * cost);
      v.returned     += ps.retVal       || 0;
      v.returnedCost += ps.retCost      || 0;
      v.sold         += (ps.sold || 0) * price;
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
      salesState:   { maxVersion: salesState.maxVersion, ts: Date.now() },
    };

    await kv.set(dataKey, result, { ex: 48 * 3600 });
    return res.json({ ok: true, ts: result.ts, pages });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
