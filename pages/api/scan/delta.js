// Delta (incremental) scan — reuses existing PO/returns data from a completed
// full scan and re-processes only sales. Much faster than a full scan (~2-5 min
// vs ~40 min) because it skips product catalog, PO, and returns phases.
//
// Requires a completed scan:data:{season} to exist. If none exists, returns
// an error so the caller knows to run a full scan first.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { makeLsFetch } from "../../../lib/ls-fetch";
import { fetchSalesPages } from "../../../lib/ls-sales-pagination";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import {
  applySalesTotals,
  derivedOnHand,
  displayOnHand,
  netOrderedValue,
  netReceivedCost,
  netReceivedRetail,
  returnedCostValue,
  returnedRetailValue,
} from "../../../lib/flow-math";
import { loadSalesState, reconcileSale, saveSalesState } from "../../../lib/sales-ledger";
import { liveOnHandFromCache, syncInventoryCache } from "../../../lib/inventory-ledger";

const MAX_DURATION_MS = 55_000; // stay under 60s function limit
const ENABLE_BULK_INVENTORY = process.env.ENABLE_BULK_INVENTORY !== "0";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
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

  const base = lsBase();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const deadline = Date.now() + MAX_DURATION_MS;
  const lsFetch = makeLsFetch({ base, headers });

  async function fetchLiveOnHand(pid) {
    const inv = await lsFetch(`2.0/products/${pid}/inventory`);
    const d = inv.data || inv;
    return Array.isArray(d)
      ? d.reduce((s, r) => s + (r.current_amount || 0), 0)
      : d.current_amount != null
        ? d.current_amount
        : d.count != null
          ? d.count
          : null;
  }

  try {
    // Clone productStats and reset sales-derived fields; ledger totals are applied below.
    const productStats = {};
    for (const [pid, ps] of Object.entries(existing.productStats)) {
      productStats[pid] = {
        ordered: ps.ordered || 0,
        orderedCost: ps.orderedCost || 0,
        received: ps.received || 0,
        receivedCost: ps.receivedCost || 0,
        retVal: ps.retVal || 0,
        retCost: ps.retCost || 0,
        retQty: ps.retQty || 0,
        qtyOrdered: ps.qtyOrdered || 0,
        qtyReceived: ps.qtyReceived || 0,
        onHand: ps.onHand || 0,
        liveOnHand: ps.liveOnHand,
        inventoryMismatch: ps.inventoryMismatch || false,
        _sup: ps._sup || undefined,
        // Sales fields reset to 0 — ledger totals are authoritative.
        soldAmt: 0,
        saleAmt: 0,
        sold: 0,
        onSale: 0,
        returned: 0,
      };
    }

    const seasonPidSet = new Set(existing.seasonPids);
    const pidToType = existing.pidToType || {};
    const pidToSupplier = existing.pidToSupplier || {};
    const pidToQtyOrdered = existing.pidToQtyOrdered || {};
    const pidToQtyReceived = existing.pidToQtyReceived || {};
    const pidToQtyReturned = existing.pidToQtyReturned || {};
    const pidToPrice = existing.pidToPrice || {};
    const pidToCost = existing.pidToCost || {};

    const salesState = await loadSalesState(kv, season);
    if (!salesState.maxVersion) {
      return res.status(409).json({ error: "No sales ledger found. Run a full scan first." });
    }

    let pages = 0;
    const touchedPids = new Set();

    await fetchSalesPages({
      lsFetch,
      deadline,
      initialCursor: salesState.maxVersion,
      onPage: async (saleItems) => {
        pages++;

        for (const sale of saleItems) {
          await reconcileSale(kv, season, salesState, sale, seasonPidSet, pidToPrice);
          for (const li of sale.line_items || []) {
            if (li?.product_id && seasonPidSet.has(li.product_id)) touchedPids.add(li.product_id);
          }
        }
      },
    });

    await saveSalesState(kv, season, salesState, seasonPidSet);
    applySalesTotals(productStats, salesState.perPid);

    if (ENABLE_BULK_INVENTORY) {
      try {
        const inventoryResult = await syncInventoryCache(kv, season, lsFetch, { deadline });
        for (const pid of existing.seasonPids || []) {
          const live = liveOnHandFromCache(inventoryResult.cache, pid);
          if (live != null && productStats[pid]) productStats[pid].liveOnHand = live;
        }
      } catch (e) {
        console.warn(`[delta] ${season} bulk inventory sync failed, falling back:`, e.message);
        await refreshTouchedInventory();
      }
    } else {
      await refreshTouchedInventory();
    }

    async function refreshTouchedInventory() {
      const changedPids = Array.from(touchedPids).filter((pid) => productStats[pid]);
      for (let i = 0; i < changedPids.length && Date.now() < deadline; i += 5) {
        const batch = changedPids.slice(i, i + 5);
        const liveValues = await Promise.all(
          batch.map((pid) => fetchLiveOnHand(pid).catch(() => productStats[pid].liveOnHand ?? null))
        );
        batch.forEach((pid, idx) => {
          if (liveValues[idx] != null) productStats[pid].liveOnHand = liveValues[idx];
        });
      }
    }

    // Roll up productStats → deptVendorData
    const deptVendorData = {};
    for (const [pid, ps] of Object.entries(productStats)) {
      const cid = pidToType[pid] || "__none__";
      const sup = pidToSupplier[pid] || ps._sup;
      const price = pidToPrice[pid] || 0;
      const cost = pidToCost[pid] || 0;
      ps.qtyOrdered = ps.qtyOrdered || pidToQtyOrdered[pid] || 0;
      ps.qtyReceived = ps.qtyReceived || pidToQtyReceived[pid] || 0;
      ps.retQty = ps.retQty || pidToQtyReturned[pid] || 0;
      ps.ordered = price * ps.qtyOrdered;
      ps.orderedCost = cost * ps.qtyOrdered;
      ps.received = price * ps.qtyReceived;
      ps.receivedCost = cost * ps.qtyReceived;
      ps.retVal = returnedRetailValue(ps, price);
      ps.retCost = returnedCostValue(ps, cost);
      const derivedStock = derivedOnHand(ps);
      ps.onHand = displayOnHand(ps);
      ps.onOrder = Math.max(0, ps.qtyOrdered - ps.qtyReceived);
      ps.inventoryMismatch = ps.liveOnHand != null && ps.liveOnHand !== derivedStock;
      if (!deptVendorData[cid]) deptVendorData[cid] = {};
      const vendorId = sup?.i && sup.i !== "__none__" ? sup.i : "__unassigned__";
      const vendorName = sup?.i && sup.i !== "__none__" ? sup.n : "Unassigned";
      if (!deptVendorData[cid][vendorId]) {
        deptVendorData[cid][vendorId] = {
          id: vendorId,
          name: vendorName,
          ordered: 0,
          orderedCost: 0,
          received: 0,
          cost: 0,
          returned: 0,
          returnedCost: 0,
          sold: 0,
        };
      }
      const v = deptVendorData[cid][vendorId];
      v.ordered += netOrderedValue(ps, price);
      v.orderedCost += Math.max(0, ((ps.qtyOrdered || 0) - (ps.retQty || 0)) * cost);
      v.received += netReceivedRetail(ps, price);
      v.cost += netReceivedCost(ps, cost);
      v.returned += returnedRetailValue(ps, price);
      v.returnedCost += returnedCostValue(ps, cost);
      v.sold += (ps.sold || 0) * price;
    }

    // Build summaryRows from deptVendorData
    // Preserve dept names from existing summaryRows
    const existingDeptNames = {};
    for (const r of existing.summaryRows || []) existingDeptNames[r.id] = r.name;

    const catMap = {};
    for (const [deptId, vendors] of Object.entries(deptVendorData)) {
      if (!catMap[deptId])
        catMap[deptId] = {
          id: deptId,
          name: existingDeptNames[deptId] || "Other",
          ordered: 0,
          orderedCost: 0,
          received: 0,
          cost: 0,
          returned: 0,
          returnedCost: 0,
          sold: 0,
        };
      for (const v of Object.values(vendors)) {
        catMap[deptId].ordered += v.ordered;
        catMap[deptId].orderedCost += v.orderedCost || 0;
        catMap[deptId].received += v.received;
        catMap[deptId].cost += v.cost || 0;
        catMap[deptId].returned += v.returned || 0;
        catMap[deptId].returnedCost += v.returnedCost || 0;
        catMap[deptId].sold += v.sold;
      }
    }
    // Include depts from existing data that have no vendors (e.g. override-only depts)
    for (const r of existing.summaryRows || []) {
      if (!catMap[r.id])
        catMap[r.id] = {
          ...r,
          ordered: r.ordered || 0,
          received: r.received || 0,
          sold: 0,
          returned: 0,
          returnedCost: 0,
        };
    }
    const summaryRows = Object.values(catMap).sort((a, b) => b.ordered - a.ordered);

    const deptVendors = {};
    for (const [deptId, vendors] of Object.entries(deptVendorData)) {
      deptVendors[deptId] = Object.values(vendors).sort((a, b) => b.ordered - a.ordered);
    }

    const result = {
      ...existing,
      ts: Date.now(),
      summaryRows,
      deptVendors,
      productStats,
      isDelta: true, // flag so UI can show "quick refresh" label if desired
      salesPages: pages,
      salesState: { maxVersion: salesState.maxVersion, ts: Date.now() },
    };

    await kv.set(dataKey, result, { ex: 48 * 3600 });
    return res.json({ ok: true, ts: result.ts, pages });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
