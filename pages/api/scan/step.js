// Chunked server-side LS scan. Each POST call does ~8s of work, saves state to
// KV, and returns { phase, progress }. The client calls this in a loop until
// phase === "done" or phase === "error".
//
// KV keys:
//   scan:job:{season}     — small operational state (phase, cursors, progress)
//   scan:job:big:{season} — large data blobs (pidMaps, deptVendorData, etc.)
//   scan:data:{season}    — final computed report (48h TTL)
//
// Required env vars: LS_DOMAIN_PREFIX, LS_CLIENT_ID, LS_CLIENT_SECRET,
//   LS_REFRESH_TOKEN, REPORT_PASSWORD, SESSION_SECRET, KV_REST_API_URL,
//   KV_REST_API_TOKEN
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import {
  applySalesTotals,
  consignmentDate,
  dateMinusDays,
  derivedOnHand,
  emptyProductStats,
  netOrderedValue,
  netReceivedValue,
  productCost,
  productName,
  productPrice,
  productVariant,
  seasonSalesFallbackDate,
  skuMatchesSeason,
} from "../../../lib/flow-math";
import { backfillSales, clearLedger, loadSalesState, reconcileSale, saveSalesState } from "../../../lib/sales-ledger";

const CHUNK_MS = 6000;

function getCursor(data, items) {
  const vfr = (data.version && typeof data.version === "object") ? data.version.max : null;
  const vfi = items.reduce((mx, i) => Math.max(mx, i.version || 0), 0);
  return (vfr !== null ? vfr : vfi) || null;
}

function registerProduct(state, p) {
  if (!state.parentStore) state.parentStore = {};
  const typeId   = p.product_type_id || "__none__";
  const suppId   = (p.supplier && p.supplier.id)   || p.supplier_id   || "__none__";
  const suppName = (p.supplier && p.supplier.name) || "Unknown";
  const price    = productPrice(p);
  const cost     = productCost(p);
  const skuKey   = (p.sku || "").toLowerCase().trim();

  let resolvedType = typeId, resolvedSuppId = suppId, resolvedSuppName = suppName;
  let resolvedPrice = price;
  let resolvedCost = cost;

  if (p._parent && !state.parentStore[p._parent.id]) {
    state.parentStore[p._parent.id] = {
      t: p._parent.product_type_id || "__none__",
      si: (p._parent.supplier && p._parent.supplier.id) || p._parent.supplier_id || "__none__",
      sn: (p._parent.supplier && p._parent.supplier.name) || "Unknown",
      p: productPrice(p._parent),
      c: productCost(p._parent),
    };
  }

  if (p.variant_parent_id) {
    const par = state.parentStore[p.variant_parent_id];
    if (par) {
      if (resolvedType   === "__none__") resolvedType     = par.t;
      if (resolvedSuppId === "__none__") { resolvedSuppId = par.si; resolvedSuppName = par.sn; }
      if (resolvedPrice  === 0)          resolvedPrice    = par.p;
      if (resolvedCost   === 0)          resolvedCost     = par.c;
    } else if (resolvedType === "__none__" || resolvedSuppId === "__none__" || resolvedPrice === 0) {
      // Parent not in store (slow-path scan) — queue for fixup after scan
      if (!state.variantNeedsFixup) state.variantNeedsFixup = {};
      state.variantNeedsFixup[p.id] = p.variant_parent_id;
    }
    state.variantsSeenInScan = true;
  } else {
    state.parentStore[p.id] = { t: typeId, si: suppId, sn: suppName, p: price };
    if (!state.seasonParentIds.includes(p.id)) state.seasonParentIds.push(p.id);
  }

  if (!state.seasonPids.includes(p.id)) {
    state.seasonPids.push(p.id);
    state.pidToType[p.id]     = resolvedType;
    state.pidToSupplier[p.id] = { i: resolvedSuppId, n: resolvedSuppName };
    state.pidToPrice[p.id]    = resolvedPrice;
    state.pidToCost[p.id]     = resolvedCost;
    state.pidToName[p.id]     = productName(p);
    state.pidToSku[p.id]      = p.sku || "";
    state.pidToVariant[p.id]  = productVariant(p);
    if (skuKey) {
      if (!state.skuToPid) state.skuToPid = {};
      state.skuToPid[skuKey] = p.id;
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const cronAuth = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const session = cronAuth ? { authed: true } : await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const jobKey  = `scan:job:${season}`;
  const bigKey  = `scan:job:big:${season}`;
  const dataKey = `scan:data:${season}`;

  // Load small + big state and merge
  const restart = req.query.restart === "1";
  let [smallState, bigData] = restart ? [null, null] : await Promise.all([kv.get(jobKey), kv.get(bigKey)]);
  let state = smallState ? { ...smallState, ...(bigData || {}) } : null;

  if (!state || state.phase === "done" || state.phase === "error") {
    state = {
      phase: "init",
      season,
      startedAt: Date.now(),
      progress: "Starting…",
    };
  }

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ phase: "error", error: "LS auth failed: " + e.message });
  }

  const base    = lsBase();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const deadline = Date.now() + CHUNK_MS;

  async function lsFetch(path, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await fetch(`${base}/${path}`, { headers, cache: "no-store" });
      if (r.status === 429 || r.status === 503) {
        if (attempt < retries) {
          const wait = Math.min(2000 * Math.pow(2, attempt), 16000);
          await new Promise(resolve => setTimeout(resolve, wait));
          continue;
        }
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`LS ${r.status} /${path.split("?")[0]}: ${txt.slice(0, 120)}`);
      }
      return r.json();
    }
  }

  async function lsFetchAll(path) {
    const results = [];
    let after = null;
    for (let p = 0; p < 200; p++) {
      const sep  = path.includes("?") ? "&" : "?";
      const data = await lsFetch(path + sep + "page_size=200" + (after ? "&after=" + after : ""));
      const items = data.data || [];
      results.push(...items);
      if (items.length < 200) break;
      after = getCursor(data, items);
      if (!after) break;
    }
    return results;
  }

  async function fetchProduct(pid) {
    const r = await lsFetch(`2.0/products/${pid}`);
    const p = r.data || r;
    if (p && p.variant_parent_id) {
      try {
        const pr = await lsFetch(`2.0/products/${p.variant_parent_id}`);
        p._parent = pr.data || pr;
      } catch (e) {}
    }
    return p;
  }

  async function ensureSeasonProduct(pid) {
    if (!pid) return false;
    if (state.seasonPids && state.seasonPids.includes(pid)) return true;
    if (!state.negPids) state.negPids = {};
    if (state.negPids[pid]) return false;
    if (!state._productTried) state._productTried = {};
    if (state._productTried[pid]) return state.seasonPids.includes(pid);
    state._productTried[pid] = true;

    try {
      const product = await fetchProduct(pid);
      const matches = skuMatchesSeason(product?.sku, season) || skuMatchesSeason(product?._parent?.sku, season);
      if (!matches) {
        state.negPids[pid] = true;
        return false;
      }
      registerProduct(state, product);
      return true;
    } catch (e) {
      state.negPids[pid] = true;
      return false;
    }
  }

  function getProductStats(pid) {
    if (!state.productStats[pid]) state.productStats[pid] = emptyProductStats();
    return state.productStats[pid];
  }

  try {

    // ── INIT: departments + PO headers ──────────────────────────────────────
    if (state.phase === "init") {
      state.progress = "Loading departments & purchase orders…";
      const dateFrom   = seasonSalesFallbackDate(season);
      const dateParam  = dateFrom ? `&date_from=${dateFrom}` : "";
      const [cats, consignments, returnConsignments] = await Promise.all([
        lsFetchAll("2.0/product_types"),
        lsFetchAll(`2.0/consignments?type=SUPPLIER${dateParam}`),
        lsFetchAll(`2.0/consignments?type=SUPPLIER_RETURN`),
      ]);

      // Trim to only needed fields to keep KV payloads small
      state.cats               = cats.map(c => ({ id: c.id, name: c.name }));
      state.consignments       = consignments.map(c => ({ id: c.id, date: consignmentDate(c) }));
      state.returnConsignments = returnConsignments.map(c => ({
        id:      c.id,
        suppId:  (c.supplier && c.supplier.id)   || c.supplier_id   || "__none__",
        suppName:(c.supplier && c.supplier.name) || "Unknown",
        date:    consignmentDate(c),
      }));
      state.parentStore        = {};
      state.seasonPids         = [];
      state.seasonParentIds    = [];
      state.pidToType          = {};
      state.pidToSupplier      = {};
      state.pidToPrice         = {};
      state.pidToCost          = {};
      state.pidToName          = {};
      state.pidToSku           = {};
      state.pidToVariant       = {};
      state.pidToQtyOrdered    = {};
      state.pidToQtyReceived   = {};
      state.pidToQtyReturned   = {};
      state.skuToPid           = {};
      state.negPids            = {};
      state.salesFloorDate     = null;
      state.variantsSeenInScan   = false;
      state.variantNeedsFixup    = {};
      state.productStats         = {};

      state.phase    = "products_seed";
      state.progress = `Loaded ${cats.length} depts, ${consignments.length} POs, ${returnConsignments.length} returns — seeding products…`;
    }

    // ── PRODUCTS_SEED: discover season products without a full catalog scan ───
    // Sources (deduplicated by PID):
    //   1. Prior scan's pid maps — restored directly from KV (instant, no API calls)
    //   2. Datatail override SKUs — handle lookup for any new products not in prior scan
    //   3. LS PO line items       — lazy registration in consignments phase below
    if (state.phase === "products_seed" && Date.now() < deadline) {
      if (!state._seedReady) {
        state._seedReady   = true;
        state._seedHandles = [];
        state._handleIdx   = 0;
        const priorPidSet  = new Set(state.seasonPids);

        // 1. Restore pid maps from lightweight scan:pids key (avoids loading full scan:data blob)
        try {
          const pidsKey   = `scan:pids:${season}`;
          const priorPids = await kv.get(pidsKey) || await kv.get(dataKey); // fallback for first run
          if (priorPids && Array.isArray(priorPids.seasonPids) && priorPids.seasonPids.length > 0) {
            for (const pid of priorPids.seasonPids) {
              if (!priorPidSet.has(pid)) { state.seasonPids.push(pid); priorPidSet.add(pid); }
            }
            Object.assign(state.pidToType,     priorPids.pidToType     || {});
            Object.assign(state.pidToSupplier, priorPids.pidToSupplier || {});
            Object.assign(state.skuToPid,      priorPids.skuToPid      || {});
            Object.assign(state.pidToPrice,    priorPids.pidToPrice    || {});
            Object.assign(state.pidToCost,     priorPids.pidToCost     || {});
            Object.assign(state.pidToName,     priorPids.pidToName     || {});
            Object.assign(state.pidToSku,      priorPids.pidToSku      || {});
            Object.assign(state.pidToVariant,  priorPids.pidToVariant  || {});
          }
        } catch (e) {}

        // 2. Collect handles for override products not already in the pid set
        //    (new products added to datatail since last scan)
        try {
          const indexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
          const vendorIndex = Array.isArray(indexRaw) ? indexRaw
            : (indexRaw ? JSON.parse(indexRaw) : []);
          const vendorRaws = await Promise.all(
            vendorIndex.map(k => kv.get(`scan:override:${season}:v:${k}`))
          );
          const handleSet = new Set();
          for (const raw of vendorRaws) {
            const v = !raw ? null : (typeof raw === "object" ? raw : JSON.parse(raw));
            for (const p of (v && v.products) || []) {
              const sku = (p.style || "").toLowerCase().trim();
              // Only fetch if this SKU isn't already mapped to a PID
              if (sku && !state.skuToPid[sku]) handleSet.add(sku.replace("/", ""));
            }
          }
          state._seedHandles = [...handleSet];
        } catch (e) {}

        console.log(`[step] ${season} products_seed: restored ${state.seasonPids.length} prior pids, ${state._seedHandles.length} new handles to fetch`);
        state.progress = `Seeding products (${state.seasonPids.length} from prior scan, ${state._seedHandles.length} new from datatail)…`;
      }

      const pidSet = new Set(state.seasonPids);

      // Fetch only NEW override handles not covered by the prior scan
      while (state._handleIdx < state._seedHandles.length && Date.now() < deadline) {
        const handle = state._seedHandles[state._handleIdx];
        try {
          const data = await lsFetch("2.0/products?handle=" + encodeURIComponent(handle) + "&page_size=10");
          for (const prod of (data.data || [])) {
            if (prod && prod.id && !pidSet.has(prod.id)) {
              if (skuMatchesSeason(prod.sku, season)) {
                registerProduct(state, prod); pidSet.add(prod.id);
              }
            }
          }
        } catch (e) {}
        state._handleIdx++;
        if (state._handleIdx % 20 === 0)
          state.progress = `Fetching new datatail products (${state._handleIdx}/${state._seedHandles.length})…`;
      }

      if (state._handleIdx >= state._seedHandles.length) {
        delete state._seedReady; delete state._seedHandles; delete state._handleIdx;
        console.log(`[step] ${season} products_seed done: ${state.seasonPids.length} products found`);

        state.phase     = "consignments";
        state.consigIdx = 0;
        state.progress  = `Found ${state.seasonPids.length} products — scanning POs (0/${state.consignments.length})…`;
      }
    }

    // ── CONSIGNMENTS: aggregate PO values by dept+vendor ────────────────────
    if (state.phase === "consignments" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      while (state.consigIdx < state.consignments.length && Date.now() < deadline) {
        const c     = state.consignments[state.consigIdx];
        const items = await lsFetchAll("2.0/consignments/" + c.id + "/products");

        for (const item of items) {
          if ((item.count || 0) < 0) continue; // skip vendor returns / adjustments
          const pid = item.product_id;
          if (!seasonPidSet.has(pid)) {
            const registered = await ensureSeasonProduct(pid);
            if (!registered) continue;
            seasonPidSet.add(pid);
          }

          const itemRetailPrice = parseFloat(item.price || item.unit_price || item.retail_price || 0);
          const price      = state.pidToPrice[pid] || itemRetailPrice || 0;
          const itemCost   = state.pidToCost[pid] || parseFloat(item.cost || 0);
          const qtyOrdered = Math.max(0, item.count    || 0);
          const qtyRecvd   = Math.max(0, item.received || 0);
          if (c.date) state.salesFloorDate = state.salesFloorDate
            ? (c.date < state.salesFloorDate ? c.date : state.salesFloorDate)
            : c.date;

          state.pidToQtyOrdered[pid] = (state.pidToQtyOrdered[pid] || 0) + qtyOrdered;
          state.pidToQtyReceived[pid] = (state.pidToQtyReceived[pid] || 0) + qtyRecvd;

          // Dollar rollup only makes sense when we know the supplier (non-override products)
          const sup = state.pidToSupplier[pid];
          if (!sup || sup.i === "__none__") continue;

          const ps = getProductStats(pid);
          ps.qtyOrdered  = (ps.qtyOrdered  || 0) + qtyOrdered;
          ps.qtyReceived = (ps.qtyReceived || 0) + qtyRecvd;
          ps.ordered      += price    * qtyOrdered;
          ps.orderedCost  += itemCost * qtyOrdered;
          ps.received     += price    * qtyRecvd;
          ps.receivedCost += itemCost * qtyRecvd;
        }

        state.consigIdx++;
        state.progress = `Scanning POs (${state.consigIdx}/${state.consignments.length})…`;
      }

      if (state.consigIdx >= state.consignments.length) {
        const orderedCount = Object.values(state.pidToQtyOrdered).filter(q => q > 0).length;
        console.log(`[step] ${season} CONSIGNMENTS DONE: ${orderedCount} products with ordered qty, ${Object.keys(state.productStats).length} products with any stats`);
        delete state.consignments;
        delete state.parentStore;

        state.phase          = "returns";
        state.returnConsigIdx = 0;
        state.progress       = `Scanning vendor returns (0/${state.returnConsignments.length})…`;
      }
    }

    // ── RETURNS: aggregate vendor return values by dept+vendor ───────────────
    if (state.phase === "returns" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      while (state.returnConsigIdx < state.returnConsignments.length && Date.now() < deadline) {
        const c     = state.returnConsignments[state.returnConsigIdx];
        const items = await lsFetchAll("2.0/consignments/" + c.id + "/products");

        // Debug: log each return consignment summary
        const inSeasonItems = items.filter(i => seasonPidSet.has(i.product_id));
        const totalQty = items.reduce((s, i) => s + Math.abs(i.count || 0), 0);
        if (items.length > 0 || state.returnConsigIdx < 3) {
          console.log(`[step] ${season} return consig ${state.returnConsigIdx} (${c.suppName}): ${items.length} items, ${inSeasonItems.length} in-season, totalQty=${totalQty}, suppId=${c.suppId}`);
          if (inSeasonItems.length > 0) {
            const s = inSeasonItems[0];
            const price = state.pidToPrice ? (state.pidToPrice[s.product_id] || 0) : 0;
            console.log(`[step] ${season} in-season return sample: pid=${s.product_id}, count=${s.count}, cost=${s.cost}, price=${price}`);
          }
        }

        for (const item of items) {
          const pid      = item.product_id;
          // LS may store return quantities as negative (return) or positive — use absolute value
          const qty      = Math.abs(item.count || 0);
          if (!qty) continue;

          if (!seasonPidSet.has(pid)) {
            const registered = await ensureSeasonProduct(pid);
            if (!registered) continue;
            seasonPidSet.add(pid);
          }

          const itemCost = state.pidToCost[pid] || parseFloat(item.cost || 0);
          const sup = state.pidToSupplier[pid] && state.pidToSupplier[pid].i !== "__none__"
            ? state.pidToSupplier[pid]
            : { i: c.suppId, n: c.suppName };
          if (!sup || sup.i === "__none__") continue;

          // Try pidToPrice first, then item's own retail price field as fallback
          const itemRetailPrice = parseFloat(item.price || item.unit_price || item.retail_price || 0);
          const price = (state.pidToPrice && state.pidToPrice[pid]) || itemRetailPrice || 0;

          state.pidToQtyReturned[pid] = (state.pidToQtyReturned[pid] || 0) + qty;
          const ps = getProductStats(pid);
          ps.retVal  += price    * qty;
          ps.retCost += itemCost * qty;
          ps.retQty  = (ps.retQty || 0) + qty;
        }

        state.returnConsigIdx++;
        state.progress = `Scanning vendor returns (${state.returnConsigIdx}/${state.returnConsignments.length})…`;
      }

      if (state.returnConsigIdx >= state.returnConsignments.length) {
        // Summary log: total retVal / retCost across all products so we can confirm returns were captured
        let totalRetVal = 0, totalRetCost = 0, retProds = 0;
        for (const ps of Object.values(state.productStats)) {
          if (ps.retVal || ps.retCost) { totalRetVal += ps.retVal || 0; totalRetCost += ps.retCost || 0; retProds++; }
        }
        console.log(`[step] ${season} RETURNS DONE: ${retProds} products with returns, totalRetVal=$${totalRetVal.toFixed(2)}, totalRetCost=$${totalRetCost.toFixed(2)}`);
        // Log any products with retQty but no retVal so we can diagnose missing prices
        for (const [pid, ps] of Object.entries(state.productStats)) {
          if ((ps.retQty || 0) > 0 && !ps.retVal) {
            const inSeason = seasonPidSet.has(pid);
            console.log(`[step] ${season} RETURN-NO-PRICE: pid=${pid} retQty=${ps.retQty} inSeason=${inSeason} pidToPrice=${state.pidToPrice?.[pid]} ordered=${ps.ordered} pidToQtyOrdered=${state.pidToQtyOrdered?.[pid]}`);
          }
        }

        delete state.returnConsignments;
        state.phase      = "inventory";
        state.inventoryIdx = 0;
        state.salesPages = 0;
        state.saleCursor = null;
        state.progress   = `Reconciling live inventory (0/${state.seasonPids.length})…`;
      }
    }

    // ── INVENTORY: scan-time live inventory reconciliation (not used as primary)
    if (state.phase === "inventory" && Date.now() < deadline) {
      while (state.inventoryIdx < state.seasonPids.length && Date.now() < deadline) {
        const pid = state.seasonPids[state.inventoryIdx];
        const ps = getProductStats(pid);
        try {
          const inv = await lsFetch(`2.0/products/${pid}/inventory`);
          const d = inv.data || inv;
          const live = Array.isArray(d)
            ? d.reduce((s, r) => s + (r.current_amount || 0), 0)
            : (d.current_amount != null ? d.current_amount : (d.count != null ? d.count : null));
          if (live != null) {
            // Store the live count now; the mismatch flag is computed in
            // finalizing, after sold/onSale are known (sales run after this phase).
            ps.liveOnHand = live;
          }
        } catch (e) {}
        state.inventoryIdx++;
        if (state.inventoryIdx % 50 === 0) {
          state.progress = `Reconciling live inventory (${state.inventoryIdx}/${state.seasonPids.length})…`;
        }
      }

      if (state.inventoryIdx >= state.seasonPids.length) {
        state.phase      = "sales";
        state.salesPages = 0;
        state.saleCursor = null;
        state.progress   = "Loading sales…";
      }
    }

    // ── SALES: aggregate sold $ (vendor) and sold units (product) ───────────
    if (state.phase === "sales" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      if (!state.salesState) {
        state.salesState = await loadSalesState(kv, season);
        const priorPidSet = new Set(state.salesState.pidSet || []);
        const pidsChanged = state.seasonPids.some(pid => !priorPidSet.has(pid));
        // Backfill (full rebuild) when there is no ledger yet OR the product set
        // expanded — a newly-registered product may have sold before the prior
        // maxVersion and must be re-attributed against the current pid set.
        state.salesBackfill = !state.salesState.maxVersion || pidsChanged;
        state.salesDateFrom = state.salesBackfill
          ? (dateMinusDays(state.salesFloorDate, 30) || seasonSalesFallbackDate(season) || "")
          : "";
        state.saleCursor = state.salesBackfill ? null : state.salesState.maxVersion;
        state.salesPages = state.salesPages || 0;
        state.progress = state.salesBackfill
          ? `Backfilling sales from ${state.salesDateFrom || "first sale"}…`
          : `Loading sales after version ${state.saleCursor}…`;
      }

      // On the first chunk of a backfill, clear the stale ledger + perPid totals
      // so the rebuild starts clean. Guarded so it only runs once per backfill.
      if (state.salesBackfill && !state.salesLedgerCleared) {
        await clearLedger(kv, season);
        state.salesState.perPid = {};
        state.salesState.maxVersion = null;
        state.salesLedgerCleared = true;
      }

      while (Date.now() < deadline) {
        const dateParam = state.salesDateFrom ? "&date_from=" + state.salesDateFrom : "";
        const path      = "2.0/sales?page_size=500" + dateParam + (state.saleCursor ? "&after=" + state.saleCursor : "");
        const data      = await lsFetch(path);
        const saleItems = data.data || [];
        state.salesPages++;

        if (state.salesBackfill) {
          // Batched rebuild — no per-sale KV reads, one hset per page.
          await backfillSales(kv, season, state.salesState, saleItems, seasonPidSet, state.pidToPrice || {});
        } else {
          // Incremental — small number of changed sales, read-modify-write each.
          for (const sale of saleItems) {
            await reconcileSale(kv, season, state.salesState, sale, seasonPidSet, state.pidToPrice || {});
          }
        }

        if (saleItems.length < 500) {
          await saveSalesState(kv, season, state.salesState, seasonPidSet);
          applySalesTotals(state.productStats, state.salesState.perPid);
          state.phase = "finalizing";
          break;
        }
        const cursor = getCursor(data, saleItems);
        if (!cursor) {
          await saveSalesState(kv, season, state.salesState, seasonPidSet);
          applySalesTotals(state.productStats, state.salesState.perPid);
          state.phase = "finalizing";
          break;
        }
        state.saleCursor = cursor;
        state.progress   = `${state.salesBackfill ? "Backfilling" : "Loading"} sales… (page ${state.salesPages})`;
      }

      await saveSalesState(kv, season, state.salesState, seasonPidSet);
    }

    // ── FINALIZING: roll productStats up to vendor → dept → summary ────────────
    if (state.phase === "finalizing") {
      const pidToPrice = state.pidToPrice || {};
      const pidToCost  = state.pidToCost  || {};
      if (state.salesState && state.salesState.perPid) {
        applySalesTotals(state.productStats, state.salesState.perPid);
      }

      // Patch retVal for any vendor returns where price wasn't available during the returns phase.
      // 1. Try pidToPrice (already fetched during consignments/returns phases)
      // 2. Try deriving price from ordered retail ÷ ordered qty
      // 3. Last resort: live API fetch for the specific product (and its parent if variant)
      //    — only fires for the small number of products with retQty>0 and still no price,
      //      bypassing any stale _priceTried flags that may have blocked earlier fetches.
      for (const [pid, ps] of Object.entries(state.productStats)) {
        if ((ps.retQty || 0) > 0 && !ps.retVal) {
          let derivedPrice = pidToPrice[pid] || 0;
          if (!derivedPrice && (state.pidToQtyOrdered?.[pid] || 0) > 0 && (ps.ordered || 0) > 0) {
            derivedPrice = ps.ordered / state.pidToQtyOrdered[pid];
          }
          if (!derivedPrice) {
            // Live fetch — only for products with a vendor return still missing a price
            try {
              const r = await lsFetch(`2.0/products/${pid}`);
              const pd = r.data || r;
              derivedPrice = parseFloat(pd.price_excluding_tax || pd.price || pd.retail_price || 0);
              if (!derivedPrice && pd.variant_parent_id) {
                const pr = await lsFetch(`2.0/products/${pd.variant_parent_id}`);
                const pard = pr.data || pr;
                derivedPrice = parseFloat(pard.price_excluding_tax || pard.price || pard.retail_price || 0);
              }
            } catch (e) {}
          }
          if (derivedPrice > 0) {
            ps.retVal = ps.retQty * derivedPrice;
            pidToPrice[pid] = derivedPrice; // keep in sync for vendor rollup below
          }
          console.log(`[step] ${season} FINALIZING-RET: pid=${pid} retQty=${ps.retQty} retVal=${ps.retVal} derivedPrice=${derivedPrice}`);
        }
      }

      // Roll up productStats → deptVendorData
      const deptVendorData = {};
      for (const [pid, ps] of Object.entries(state.productStats)) {
        const cid = state.pidToType[pid]     || "__none__";
        const sup = state.pidToSupplier[pid] || ps._sup;
        if (!sup || sup.i === "__none__") continue;
        const price = pidToPrice[pid] || 0;
        const cost  = pidToCost[pid]  || 0;
        ps.qtyOrdered  = ps.qtyOrdered  || state.pidToQtyOrdered[pid]  || 0;
        ps.qtyReceived = ps.qtyReceived || state.pidToQtyReceived[pid] || 0;
        ps.retQty      = ps.retQty      || state.pidToQtyReturned[pid] || 0;
        ps.ordered      = price * ps.qtyOrdered;
        ps.orderedCost  = cost  * ps.qtyOrdered;
        ps.received     = price * ps.qtyReceived;
        ps.receivedCost = cost  * ps.qtyReceived;
        ps.retVal       = price * ps.retQty;
        ps.retCost      = cost  * ps.retQty;
        ps.onHand       = derivedOnHand(ps);
        ps.onOrder      = Math.max(0, ps.qtyOrdered - ps.qtyReceived);
        // Reconcile derived flow stock against live LS inventory (captured in the
        // inventory phase). Computed here so sold/onSale are already applied.
        ps.inventoryMismatch = (ps.liveOnHand != null && ps.liveOnHand !== ps.onHand);
        if (!deptVendorData[cid]) deptVendorData[cid] = {};
        if (!deptVendorData[cid][sup.i]) {
          deptVendorData[cid][sup.i] = { id: sup.i, name: sup.n, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
        }
        const v = deptVendorData[cid][sup.i];
        v.ordered      += netOrderedValue(ps, price);
        v.orderedCost  += Math.max(0, ((ps.qtyOrdered || 0) - (ps.retQty || 0)) * cost);
        v.received     += netReceivedValue(ps, price);
        v.cost         += Math.max(0, ((ps.qtyReceived || 0) - (ps.retQty || 0)) * cost);
        v.returned     += ps.retVal || ((ps.retQty || 0) * price);
        v.returnedCost += ps.retCost      || 0;
        v.sold         += (ps.sold || 0) * price;
      }

      // Build summary (dept-level) from deptVendorData
      const catMap = {};
      for (const cat of state.cats) {
        catMap[cat.id] = { id: cat.id, name: cat.name, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
      }
      for (const [deptId, vendors] of Object.entries(deptVendorData)) {
        if (!catMap[deptId]) catMap[deptId] = { id: deptId, name: "Other", ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
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
      const summaryRows = Object.values(catMap).sort((a, b) => b.ordered - a.ordered);

      // deptVendors: { deptId: [{id,name,ordered,received,sold,cost,...}] }
      const deptVendors = {};
      for (const [deptId, vendors] of Object.entries(deptVendorData)) {
        deptVendors[deptId] = Object.values(vendors).sort((a, b) => b.ordered - a.ordered);
      }

      const result = {
        ts:              Date.now(),
        season:          state.season,
        summaryRows,
        deptVendors,
        productStats:    state.productStats,
        seasonPids:      state.seasonPids,
        pidToType:       state.pidToType,
        pidToSupplier:   state.pidToSupplier,
        pidToQtyOrdered: state.pidToQtyOrdered,
        pidToQtyReceived: state.pidToQtyReceived || {},
        pidToQtyReturned: state.pidToQtyReturned || {},
        skuToPid:        state.skuToPid || {},
        pidToPrice,
        pidToCost,
        pidToName:       state.pidToName || {},
        pidToSku:        state.pidToSku || {},
        pidToVariant:    state.pidToVariant || {},
        salesState:      state.salesState ? { maxVersion: state.salesState.maxVersion, ts: state.salesState.ts } : null,
      };

      const pidsKey = `scan:pids:${state.season}`;
      const doneTs  = Date.now();
      await Promise.all([
        kv.set(dataKey, result, { ex: 48 * 3600 }),
        kv.set(pidsKey, {
          seasonPids: state.seasonPids,
          pidToType: state.pidToType,
          pidToSupplier: state.pidToSupplier,
          skuToPid: state.skuToPid || {},
          pidToPrice,
          pidToCost,
          pidToName: state.pidToName || {},
          pidToSku: state.pidToSku || {},
          pidToVariant: state.pidToVariant || {},
        }, { ex: 48 * 3600 }),
        // Keep job key with done+ts so cron/scan can check recency without loading scan:data
        kv.set(jobKey, { phase: "done", season: state.season, ts: doneTs }, { ex: 2 * 3600 }),
      ]);
      await kv.del(bigKey);

      return res.json({ phase: "done", season: state.season, ts: doneTs, progress: "Scan complete!" });
    }

    // ── ERROR ────────────────────────────────────────────────────────────────
    if (state.phase === "error") {
      await kv.set(jobKey, { phase: "error", season, error: state.error }, { ex: 300 });
      return res.json({ phase: "error", error: state.error });
    }

    // Split state across two keys: small operational fields + big data blobs
    const SMALL_FIELDS = new Set(["phase","season","startedAt","progress","error","consigIdx","returnConsigIdx","inventoryIdx","salesPages","saleCursor","salesDateFrom","salesBackfill","salesLedgerCleared","_seedReady","_priorIdx","_handleIdx"]);
    const small = {}, big = {};
    for (const [k, v] of Object.entries(state)) {
      if (SMALL_FIELDS.has(k)) small[k] = v; else big[k] = v;
    }
    await Promise.all([
      kv.set(jobKey, small, { ex: 24 * 3600 }),
      kv.set(bigKey, big,   { ex: 24 * 3600 }),
    ]);
    return res.json({ phase: state.phase, progress: state.progress || "…" });

  } catch (e) {
    console.error(`[step] ${season} error:`, e.message);
    const errState = { phase: "error", season, error: e.message };
    await kv.set(jobKey, errState, { ex: 300 }).catch(() => {});
    return res.status(500).json({ phase: "error", error: e.message });
  }
}
