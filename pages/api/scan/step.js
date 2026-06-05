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
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

const CHUNK_MS = 6000;

function seasonSkuCodes(seasonId) {
  const m = seasonId.match(/^(prefall|fall|spring|prespring)(\d+)$/);
  if (!m) return [];
  const yy = m[2].slice(-2);
  if (m[1] === "prespring") return ["/rs" + yy, "/ps" + yy];
  if (m[1] === "prefall")   return ["/pf" + yy];
  if (m[1] === "fall") {
    // Include /pf codes only when there's no separate prefall season in the list
    const hasPreFall = SEASONS.some(s => s.id === `prefall${yy}`);
    return hasPreFall ? ["/f" + yy] : ["/f" + yy, "/pf" + yy];
  }
  if (m[1] === "spring") {
    // Include /rs and /ps codes only when there's no separate prespring season
    const hasPreSpring = SEASONS.some(s => s.id === `prespring${yy}`);
    return hasPreSpring ? ["/s" + yy] : ["/s" + yy, "/rs" + yy, "/ps" + yy];
  }
  return [];
}

// Returns an ISO date string 9 months before the season's nominal start,
// used as date_from on the sales query so we don't scan 20 years of history.
function seasonSalesDateFrom(seasonId) {
  const m = seasonId.match(/^(prefall|fall|prespring|spring)(\d{2})$/);
  if (!m) return null;
  const year = 2000 + parseInt(m[2]);
  // Fall/Pre-Fall start ~Aug; Spring/Pre-Spring start ~Feb — subtract 9 months for buffer
  const startMonth = (m[1] === "fall" || m[1] === "prefall") ? 8 : 2;
  const fromDate = new Date(year, startMonth - 1 - 9, 1); // 9 months before season opens
  return fromDate.toISOString().slice(0, 10);
}

function getCursor(data, items) {
  const vfr = (data.version && typeof data.version === "object") ? data.version.max : null;
  const vfi = items.reduce((mx, i) => Math.max(mx, i.version || 0), 0);
  return (vfr !== null ? vfr : vfi) || null;
}

function registerProduct(state, p) {
  const typeId   = p.product_type_id || "__none__";
  const suppId   = (p.supplier && p.supplier.id)   || p.supplier_id   || "__none__";
  const suppName = (p.supplier && p.supplier.name) || "Unknown";
  const price    = parseFloat(p.price_excluding_tax || 0);
  const skuKey   = ((p.custom_sku || "") || (p.sku || "")).toLowerCase().trim();

  let resolvedType = typeId, resolvedSuppId = suppId, resolvedSuppName = suppName;
  let resolvedPrice = price;

  if (p.variant_parent_id) {
    const par = state.parentStore[p.variant_parent_id];
    if (par) {
      if (resolvedType   === "__none__") resolvedType     = par.t;
      if (resolvedSuppId === "__none__") { resolvedSuppId = par.si; resolvedSuppName = par.sn; }
      if (resolvedPrice  === 0)          resolvedPrice    = par.p;
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

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`LS ${r.status} /${path.split("?")[0]}: ${txt.slice(0, 120)}`);
    }
    return r.json();
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

  try {

    // ── INIT: departments + PO headers ──────────────────────────────────────
    if (state.phase === "init") {
      state.progress = "Loading departments & purchase orders…";
      const dateFrom   = seasonSalesDateFrom(season);
      const dateParam  = dateFrom ? `&date_from=${dateFrom}` : "";
      const [cats, consignments, returnConsignments] = await Promise.all([
        lsFetchAll("2.0/product_types"),
        lsFetchAll(`2.0/consignments?type=SUPPLIER${dateParam}`),
        lsFetchAll(`2.0/consignments?type=SUPPLIER_RETURN${dateParam}`),
      ]);
      const skuCodes = seasonSkuCodes(season);
      const skuBase  = skuCodes[0] ? skuCodes[0].replace(/\//g, "") : null;

      // Trim to only needed fields to keep KV payloads small
      state.cats               = cats.map(c => ({ id: c.id, name: c.name }));
      state.consignments       = consignments.map(c => ({ id: c.id }));
      state.returnConsignments = returnConsignments.map(c => ({ id: c.id }));
      state.parentStore        = {};
      state.seasonPids         = [];
      state.seasonParentIds    = [];
      state.pidToType          = {};
      state.pidToSupplier      = {};
      state.pidToPrice         = {};
      state.pidToQtyOrdered    = {};
      state.skuToPid           = {};
      state.variantsSeenInScan   = false;
      state.variantNeedsFixup    = {};
      state.deptVendorData       = {};  // { deptId: { vendorId: {id,name,ordered,received,returned,sold,...} } }
      state.productStats         = {};  // { pid: {sold, onSale, returned} }
      state.anchorVersion        = (skuBase && SEASON_START_CURSORS[skuBase] != null)
        ? SEASON_START_CURSORS[skuBase] : null;

      state.phase            = "products";
      state.productSearchIdx = 0;
      state.progress         = `Loaded ${cats.length} depts, ${consignments.length} POs, ${returnConsignments.length} returns — searching products…`;
    }

    // ── PRODUCTS: fast-path SKU search ──────────────────────────────────────
    if (state.phase === "products" && Date.now() < deadline) {
      const skuCodes = seasonSkuCodes(season);

      while (state.productSearchIdx < skuCodes.length && Date.now() < deadline) {
        const code  = skuCodes[state.productSearchIdx].replace("/", "");
        let after   = null;
        for (let pg = 0; pg < 20 && Date.now() < deadline; pg++) {
          const data  = await lsFetch(
            "2.0/products?active=1&page_size=200&search=" +
            encodeURIComponent(code) +
            (after ? "&after=" + after : "")
          );
          const items = data.data || [];
          for (const prod of items) {
            const sku = ((prod.sku || "") + " " + (prod.custom_sku || "")).toLowerCase();
            if (skuCodes.some(c => sku.includes(c))) registerProduct(state, prod);
          }
          if (items.length < 200) break;
          after = getCursor(data, items);
          if (!after) break;
        }
        state.productSearchIdx++;
      }

      if (state.productSearchIdx >= skuCodes.length) {
        if (state.seasonPids.length === 0) {
          // Fallback: full catalog scan — always start from beginning
          state.phase      = "products_slow";
          state.slowAfter  = null;
          state.slowScanned = 0;
          state.progress   = "Fast-path found nothing — scanning full catalog…";
        } else if (!state.variantsSeenInScan) {
          state.phase      = "products_variants";
          state.variantIdx = 0;
          state.progress   = `Found ${state.seasonParentIds.length} products — fetching variants…`;
        } else {
          state.phase    = "consignments";
          state.consigIdx = 0;
          state.progress  = `Found ${state.seasonPids.length} SKUs — scanning POs (0/${state.consignments.length})…`;
        }
      }
    }

    // ── PRODUCTS_SLOW: full catalog scan (fallback) ──────────────────────────
    if (state.phase === "products_slow" && Date.now() < deadline) {
      const skuCodes = seasonSkuCodes(season);
      while (Date.now() < deadline) {
        const path  = "2.0/products?active=1&page_size=500" + (state.slowAfter ? "&after=" + state.slowAfter : "");
        const data  = await lsFetch(path);
        const prods = data.data || [];
        state.slowScanned += prods.length;

        for (const prod of prods) {
          const sku = ((prod.sku || "") + " " + (prod.custom_sku || "")).toLowerCase();
          if (skuCodes.some(c => sku.includes(c))) registerProduct(state, prod);
        }

        if (prods.length === 0) { state.phase = "products_slow_done"; break; }
        const cursor = getCursor(data, prods);
        if (!cursor) { state.phase = "products_slow_done"; break; }
        state.slowAfter = cursor;
        state.progress  = `Scanning catalog… (${state.slowScanned.toLocaleString()} scanned, ${state.seasonPids.length} found)`;
      }
    }

    if (state.phase === "products_slow_done") {
      if (state.seasonPids.length === 0) {
        const skuCodes = seasonSkuCodes(season);
        state.phase = "error";
        state.error = `No products found matching ${skuCodes.join(", ")} after scanning ${(state.slowScanned || 0).toLocaleString()} catalog entries.`;
      } else if (state.variantNeedsFixup && Object.keys(state.variantNeedsFixup).length > 0) {
        // Fetch parent data for variants whose parent wasn't in-memory during slow scan
        state.phase      = "products_fix";
        state.fixParents = [...new Set(Object.values(state.variantNeedsFixup))];
        state.fixIdx     = 0;
        state.progress   = `Resolving variant data (0/${state.fixParents.length})…`;
      } else {
        state.phase    = "consignments";
        state.consigIdx = 0;
      }
    }

    // ── PRODUCTS_FIX: resolve parent data for slow-path variants ────────────
    if (state.phase === "products_fix" && Date.now() < deadline) {
      const parents = state.fixParents || [];
      while (state.fixIdx < parents.length && Date.now() < deadline) {
        const parentId = parents[state.fixIdx];
        let prod;
        try { prod = (await lsFetch("2.0/products/" + parentId)).data || null; } catch (e) { prod = null; }
        if (prod) {
          const pt = prod.product_type_id || "__none__";
          const si = (prod.supplier && prod.supplier.id) || prod.supplier_id || "__none__";
          const sn = (prod.supplier && prod.supplier.name) || "Unknown";
          const pp = parseFloat(prod.price_excluding_tax || 0);
          for (const [variantId, pId] of Object.entries(state.variantNeedsFixup || {})) {
            if (pId !== parentId) continue;
            if ((state.pidToType[variantId] || "__none__") === "__none__" && pt !== "__none__") state.pidToType[variantId] = pt;
            if ((state.pidToSupplier[variantId]?.i || "__none__") === "__none__" && si !== "__none__") {
              state.pidToSupplier[variantId] = { i: si, n: sn };
            }
            if (!state.pidToPrice[variantId] && pp) state.pidToPrice[variantId] = pp;
          }
        }
        state.fixIdx++;
        state.progress = `Resolving variant data (${state.fixIdx}/${parents.length})…`;
      }
      if (state.fixIdx >= parents.length) {
        delete state.variantNeedsFixup;
        delete state.fixParents;
        state.phase    = "consignments";
        state.consigIdx = 0;
        state.progress  = `Found ${state.seasonPids.length} SKUs — scanning POs (0/${state.consignments.length})…`;
      }
    }

    // ── PRODUCTS_VARIANTS: fetch variants for parent products ────────────────
    if (state.phase === "products_variants" && Date.now() < deadline) {
      const pidSet = new Set(state.seasonPids);
      while (state.variantIdx < state.seasonParentIds.length && Date.now() < deadline) {
        const pid      = state.seasonParentIds[state.variantIdx];
        const variants = await lsFetchAll("2.0/products?variant_parent_id=" + pid);
        const par      = state.parentStore[pid];
        for (const vp of variants) {
          if (pidSet.has(vp.id)) continue;
          pidSet.add(vp.id);
          state.seasonPids.push(vp.id);
          state.pidToType[vp.id]     = vp.product_type_id || par?.t || "__none__";
          state.pidToSupplier[vp.id] = {
            i: (vp.supplier && vp.supplier.id)   || vp.supplier_id   || par?.si || "__none__",
            n: (vp.supplier && vp.supplier.name) || par?.sn || "Unknown",
          };
          state.pidToPrice[vp.id] = parseFloat(vp.price_excluding_tax || 0) || par?.p || 0;
        }
        state.variantIdx++;
        state.progress = `Fetching variants (${state.variantIdx}/${state.seasonParentIds.length})…`;
      }

      if (state.variantIdx >= state.seasonParentIds.length) {
        delete state.parentStore;
        delete state.seasonParentIds;
        state.phase    = "consignments";
        state.consigIdx = 0;
        state.progress  = `Found ${state.seasonPids.length} SKUs — scanning POs (0/${state.consignments.length})…`;
      }
    }

    // ── CONSIGNMENTS: aggregate PO values by dept+vendor ────────────────────
    if (state.phase === "consignments" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      while (state.consigIdx < state.consignments.length && Date.now() < deadline) {
        const c     = state.consignments[state.consigIdx];
        const items = await lsFetchAll("2.0/consignments/" + c.id + "/products");

        for (const item of items) {
          if (!seasonPidSet.has(item.product_id)) continue;
          if ((item.count || 0) < 0) continue; // skip vendor returns / adjustments
          const pid    = item.product_id;
          const cid    = state.pidToType[pid]     || "__none__";
          const sup    = state.pidToSupplier[pid];
          if (!sup || sup.i === "__none__") continue;
          const price  = state.pidToPrice[pid] || 0;

          if (!state.deptVendorData[cid]) state.deptVendorData[cid] = {};
          if (!state.deptVendorData[cid][sup.i]) {
            state.deptVendorData[cid][sup.i] = { id: sup.i, name: sup.n, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
          }
          const v = state.deptVendorData[cid][sup.i];
          const itemCost   = parseFloat(item.cost || 0);
          const qtyOrdered = Math.max(0, item.count    || 0);
          const qtyRecvd   = Math.max(0, item.received || 0);
          v.ordered      += price    * qtyOrdered;
          v.orderedCost  += itemCost * qtyOrdered;
          v.received     += price    * qtyRecvd;
          v.cost         += itemCost * qtyRecvd;
          state.pidToQtyOrdered[pid] = (state.pidToQtyOrdered[pid] || 0) + qtyOrdered;
        }

        state.consigIdx++;
        state.progress = `Scanning POs (${state.consigIdx}/${state.consignments.length})…`;
      }

      if (state.consigIdx >= state.consignments.length) {
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

        for (const item of items) {
          if (!seasonPidSet.has(item.product_id)) continue;
          const pid      = item.product_id;
          const cid      = state.pidToType[pid]     || "__none__";
          const sup      = state.pidToSupplier[pid];
          if (!sup || sup.i === "__none__") continue;
          const price    = state.pidToPrice[pid] || 0;
          const itemCost = parseFloat(item.cost || 0);
          const qty      = Math.max(0, item.count || 0);

          if (!state.deptVendorData[cid]) state.deptVendorData[cid] = {};
          if (!state.deptVendorData[cid][sup.i]) {
            state.deptVendorData[cid][sup.i] = { id: sup.i, name: sup.n, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
          }
          const v = state.deptVendorData[cid][sup.i];
          v.returned     += price    * qty;
          v.returnedCost += itemCost * qty;
        }

        state.returnConsigIdx++;
        state.progress = `Scanning vendor returns (${state.returnConsigIdx}/${state.returnConsignments.length})…`;
      }

      if (state.returnConsigIdx >= state.returnConsignments.length) {
        delete state.returnConsignments;
        state.phase      = "sales";
        state.salesPages = 0;
        state.saleCursor = state.anchorVersion ? Math.max(0, state.anchorVersion - 1_000_000) : null;
        state.progress   = "Loading sales…";
      }
    }

    // ── SALES: aggregate sold $ (vendor) and sold units (product) ───────────
    if (state.phase === "sales" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);
      if (!state.salesDateFrom) state.salesDateFrom = seasonSalesDateFrom(season) || "";

      while (Date.now() < deadline) {
        const dateParam = state.salesDateFrom ? "&date_from=" + state.salesDateFrom : "";
        const path      = "2.0/sales?page_size=500" + dateParam + (state.saleCursor ? "&after=" + state.saleCursor : "");
        const data      = await lsFetch(path);
        const saleItems = data.data || [];
        state.salesPages++;

        for (const sale of saleItems) {
          const saleStatus = (sale.status || "").toUpperCase().replace(/[\s,_-]/g, "");
          if (saleStatus === "OPEN" || saleStatus === "PARKED" || saleStatus === "LAYBY" || saleStatus === "LAYAWAY") continue;
          for (const li of (sale.line_items || [])) {
            if (!li.product_id || li.status === "VOIDED") continue;
            const pid = li.product_id;
            if (!seasonPidSet.has(pid)) continue;

            const qty    = parseInt(li.quantity || 1);
            const amount = li.total_price != null ? parseFloat(li.total_price) : parseFloat(li.price || 0);
            // LS uses negative qty and negative total_price for returns — signs are already correct

            // Per-product stats (units)
            if (!state.productStats[pid]) state.productStats[pid] = { sold: 0, onSale: 0, returned: 0 };
            if (qty < 0) {
              // Customer return — net out of sold; clamp to 0
              state.productStats[pid].sold = Math.max(0, (state.productStats[pid].sold || 0) + qty);
            } else {
              state.productStats[pid].sold += qty;
              const unitPrice   = qty > 0 ? amount / qty : 0;
              const retailPrice = state.pidToPrice ? (state.pidToPrice[pid] || 0) : 0;
              const discounted  = parseFloat(li.discount || li.line_discount || li.discount_total || 0) > 0;
              if (discounted || (retailPrice > 0 && (unitPrice === 0 || unitPrice < retailPrice * 0.99))) {
                state.productStats[pid].onSale += qty;
              }
            }

            // Per-vendor sold $ — amount already negative for returns, just add
            const cid = state.pidToType[pid] || "__none__";
            const sup = state.pidToSupplier[pid];
            if (sup && sup.i !== "__none__" && state.deptVendorData[cid] && state.deptVendorData[cid][sup.i]) {
              const v = state.deptVendorData[cid][sup.i];
              v.sold += amount;
            }
          }
        }

        if (saleItems.length < 500) { state.phase = "finalizing"; break; }
        const cursor = getCursor(data, saleItems);
        if (!cursor) { state.phase = "finalizing"; break; }
        state.saleCursor = cursor;
        state.progress   = `Loading sales… (page ${state.salesPages})`;
      }
    }

    // ── FINALIZING: compute summary rows + write to KV ───────────────────────
    if (state.phase === "finalizing") {
      delete state.pidToPrice;
      // Build summary (dept-level) from deptVendorData
      const catMap = {};
      for (const cat of state.cats) {
        catMap[cat.id] = { id: cat.id, name: cat.name, ordered: 0, orderedCost: 0, received: 0, cost: 0, returned: 0, returnedCost: 0, sold: 0 };
      }
      for (const [deptId, vendors] of Object.entries(state.deptVendorData)) {
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

      // deptVendors: { deptId: [{id,name,ordered,received,sold,cost}] }
      const deptVendors = {};
      for (const [deptId, vendors] of Object.entries(state.deptVendorData)) {
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
        skuToPid:        state.skuToPid || {},
      };

      await kv.set(dataKey, result, { ex: 48 * 3600 });
      await Promise.all([kv.del(jobKey), kv.del(bigKey)]);

      return res.json({ phase: "done", season: state.season, ts: result.ts, progress: "Scan complete!" });
    }

    // ── ERROR ────────────────────────────────────────────────────────────────
    if (state.phase === "error") {
      await kv.set(jobKey, { phase: "error", season, error: state.error }, { ex: 300 });
      return res.json({ phase: "error", error: state.error });
    }

    // Split state across two keys: small operational fields + big data blobs
    const SMALL_FIELDS = new Set(["phase","season","startedAt","progress","error","productSearchIdx","variantIdx","consigIdx","returnConsigIdx","salesPages","saleCursor","slowAfter","slowScanned","variantsSeenInScan","anchorVersion","fixIdx"]);
    const small = {}, big = {};
    for (const [k, v] of Object.entries(state)) {
      if (SMALL_FIELDS.has(k)) small[k] = v; else big[k] = v;
    }
    await Promise.all([
      kv.set(jobKey, small, { ex: 3600 }),
      kv.set(bigKey, big,   { ex: 3600 }),
    ]);
    return res.json({ phase: state.phase, progress: state.progress || "…" });

  } catch (e) {
    const errState = { phase: "error", season, error: e.message };
    await kv.set(jobKey, errState, { ex: 300 }).catch(() => {});
    return res.status(500).json({ phase: "error", error: e.message });
  }
}
