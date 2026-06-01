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

const CHUNK_MS = 8000;

function seasonSkuCodes(seasonId) {
  const m = seasonId.match(/^(prefall|fall|spring|prespring)(\d+)$/);
  if (!m) return [];
  const year = m[2].slice(-2);
  if (m[1] === "prespring") return ["/rs" + year, "/ps" + year];
  const abbr = { prefall: "pf", fall: "f", spring: "s" };
  return ["/" + abbr[m[1]] + year];
}

// Hardcoded lower-bound product-version cursors so sales scan skips history
// predating the season. Same logic as the browser scan.
const SEASON_START_CURSORS = {
  pf26: 50022000000,
};

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

  let resolvedType = typeId, resolvedSuppId = suppId, resolvedSuppName = suppName;
  let resolvedPrice = price;

  if (p.variant_parent_id) {
    const par = state.parentStore[p.variant_parent_id];
    if (par) {
      if (resolvedType   === "__none__") resolvedType     = par.t;
      if (resolvedSuppId === "__none__") { resolvedSuppId = par.si; resolvedSuppName = par.sn; }
      if (resolvedPrice  === 0)          resolvedPrice    = par.p;
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
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const jobKey     = `scan:job:${season}`;
  const bigKey     = `scan:job:big:${season}`;
  const parentsKey = `scan:job:parents:${season}`;
  const dataKey    = `scan:data:${season}`;

  // Load all three state slices and merge
  const restart = req.query.restart === "1";
  let [smallState, bigData, parentsData] = restart
    ? [null, null, null]
    : await Promise.all([kv.get(jobKey), kv.get(bigKey), kv.get(parentsKey)]);
  let state = smallState
    ? { ...smallState, ...(bigData || {}), parentStore: parentsData || undefined }
    : null;

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
      const [cats, consignments] = await Promise.all([
        lsFetchAll("2.0/product_types"),
        lsFetchAll("2.0/consignments?type=SUPPLIER"),
      ]);
      const skuCodes = seasonSkuCodes(season);
      const skuBase  = skuCodes[0] ? skuCodes[0].replace(/\//g, "") : null;

      // Trim to only needed fields to keep KV payloads small
      state.cats             = cats.map(c => ({ id: c.id, name: c.name }));
      state.consignments     = consignments.map(c => ({ id: c.id }));
      state.parentStore      = {};
      state.seasonPids       = [];
      state.seasonParentIds  = [];
      state.pidToType        = {};
      state.pidToSupplier    = {};
      state.pidToPrice       = {};
      state.variantsSeenInScan = false;
      state.deptVendorData   = {};  // { deptId: { vendorId: {id,name,ordered,received,sold,cost} } }
      state.productStats     = {};  // { pid: {sold, onSale, returned} }
      state.anchorVersion    = (skuBase && SEASON_START_CURSORS[skuBase] != null)
        ? SEASON_START_CURSORS[skuBase] : null;

      state.phase            = "products";
      state.productSearchIdx = 0;
      state.progress         = `Loaded ${cats.length} depts, ${consignments.length} POs — searching products…`;
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
            const sku = (prod.sku || "").toLowerCase();
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
          // Fallback: full catalog scan from anchor version
          state.phase      = "products_slow";
          state.slowAfter  = state.anchorVersion;
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
          // Always store parent data for variant inheritance
          if (!prod.variant_parent_id) {
            state.parentStore[prod.id] = {
              t:  prod.product_type_id || "__none__",
              si: (prod.supplier && prod.supplier.id) || prod.supplier_id || "__none__",
              sn: (prod.supplier && prod.supplier.name) || "Unknown",
              p:  parseFloat(prod.price_excluding_tax || 0),
            };
          }
          const sku = (prod.sku || "").toLowerCase();
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
      } else if (!state.variantsSeenInScan) {
        state.phase      = "products_variants";
        state.variantIdx = 0;
      } else {
        state.phase    = "consignments";
        state.consigIdx = 0;
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
          const pid    = item.product_id;
          const cid    = state.pidToType[pid]     || "__none__";
          const sup    = state.pidToSupplier[pid];
          if (!sup || sup.i === "__none__") continue;
          const price  = state.pidToPrice[pid] || 0;

          if (!state.deptVendorData[cid]) state.deptVendorData[cid] = {};
          if (!state.deptVendorData[cid][sup.i]) {
            state.deptVendorData[cid][sup.i] = { id: sup.i, name: sup.n, ordered: 0, received: 0, sold: 0, cost: 0 };
          }
          const v = state.deptVendorData[cid][sup.i];
          v.ordered  += price * (item.count    || 0);
          v.received += price * (item.received || 0);
          v.cost     += parseFloat(item.cost || 0) * (item.received || 0);
        }

        state.consigIdx++;
        state.progress = `Scanning POs (${state.consigIdx}/${state.consignments.length})…`;
      }

      if (state.consigIdx >= state.consignments.length) {
        // Free memory not needed in sales phase
        delete state.consignments;
        delete state.parentStore;
        delete state.pidToPrice;

        state.phase      = "sales";
        state.salesPages = 0;
        state.saleCursor = state.anchorVersion ? Math.max(0, state.anchorVersion - 1_000_000) : null;
        state.progress   = "Loading sales…";
      }
    }

    // ── SALES: aggregate sold $ (vendor) and sold units (product) ───────────
    if (state.phase === "sales" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      while (Date.now() < deadline) {
        const path      = "2.0/sales?page_size=500" + (state.saleCursor ? "&after=" + state.saleCursor : "");
        const data      = await lsFetch(path);
        const saleItems = data.data || [];
        state.salesPages++;

        for (const sale of saleItems) {
          if (sale.status !== "CLOSED") continue;
          for (const li of (sale.line_items || [])) {
            if (!li.product_id || li.status === "VOIDED") continue;
            const pid = li.product_id;
            if (!seasonPidSet.has(pid)) continue;

            const qty    = parseInt(li.quantity || 1);
            const amount = parseFloat(li.total_price || li.price || 0);

            // Per-product stats (units)
            if (!state.productStats[pid]) state.productStats[pid] = { sold: 0, onSale: 0, returned: 0 };
            if (li.is_return) {
              state.productStats[pid].returned += qty;
            } else {
              state.productStats[pid].sold += qty;
              const unitPrice   = parseFloat(li.price || 0) || (qty > 0 ? amount / qty : 0);
              const retailPrice = state.pidToPrice ? (state.pidToPrice[pid] || 0) : 0;
              const discounted  = parseFloat(li.discount || li.line_discount || 0) > 0;
              if (discounted || (retailPrice > 0 && unitPrice > 0 && unitPrice < retailPrice * 0.99)) {
                state.productStats[pid].onSale += qty;
              }
            }

            // Per-vendor sold $ (for vendor drilldown table)
            const cid = state.pidToType[pid] || "__none__";
            const sup = state.pidToSupplier[pid];
            if (sup && sup.i !== "__none__" && state.deptVendorData[cid] && state.deptVendorData[cid][sup.i]) {
              const v = state.deptVendorData[cid][sup.i];
              if (li.is_return) { v.sold -= amount; } else { v.sold += amount; }
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
      // Build summary (dept-level) from deptVendorData
      const catMap = {};
      for (const cat of state.cats) {
        catMap[cat.id] = { id: cat.id, name: cat.name, ordered: 0, received: 0, sold: 0 };
      }
      for (const [deptId, vendors] of Object.entries(state.deptVendorData)) {
        if (!catMap[deptId]) catMap[deptId] = { id: deptId, name: "Other", ordered: 0, received: 0, sold: 0 };
        for (const v of Object.values(vendors)) {
          catMap[deptId].ordered  += v.ordered;
          catMap[deptId].received += v.received;
          catMap[deptId].sold     += v.sold;
        }
      }
      const summaryRows = Object.values(catMap).sort((a, b) => b.ordered - a.ordered);

      // deptVendors: { deptId: [{id,name,ordered,received,sold,cost}] }
      const deptVendors = {};
      for (const [deptId, vendors] of Object.entries(state.deptVendorData)) {
        deptVendors[deptId] = Object.values(vendors).sort((a, b) => b.ordered - a.ordered);
      }

      const result = {
        ts:           Date.now(),
        season:       state.season,
        summaryRows,
        deptVendors,
        productStats: state.productStats,
        seasonPids:   state.seasonPids,
        pidToType:    state.pidToType,
        pidToSupplier: state.pidToSupplier,
      };

      await kv.set(dataKey, result, { ex: 48 * 3600 });
      await Promise.all([kv.del(jobKey), kv.del(bigKey), kv.del(parentsKey)]);

      return res.json({ phase: "done", season: state.season, ts: result.ts, progress: "Scan complete!" });
    }

    // ── ERROR ────────────────────────────────────────────────────────────────
    if (state.phase === "error") {
      await kv.set(jobKey, { phase: "error", season, error: state.error }, { ex: 300 });
      return res.json({ phase: "error", error: state.error });
    }

    // Save job state split across three keys to stay under KV 10MB limit:
    //   jobKey     — small operational state (phase, cursors, indexes)
    //   bigKey     — medium data (pidMaps, deptVendorData, productStats, cats, consignments)
    //   parentsKey — parentStore alone (can be very large during full catalog scan)
    const SMALL_FIELDS = new Set(["phase","season","startedAt","progress","error","productSearchIdx","variantIdx","consigIdx","salesPages","saleCursor","slowAfter","slowScanned","variantsSeenInScan","anchorVersion"]);
    const small = {}, big = {}, parents = state.parentStore || {};
    for (const [k, v] of Object.entries(state)) {
      if (k === "parentStore") continue;
      if (SMALL_FIELDS.has(k)) small[k] = v; else big[k] = v;
    }
    await Promise.all([
      kv.set(jobKey,     small,   { ex: 3600 }),
      kv.set(bigKey,     big,     { ex: 3600 }),
      kv.set(parentsKey, parents, { ex: 3600 }),
    ]);
    return res.json({ phase: state.phase, progress: state.progress || "…" });

  } catch (e) {
    const errState = { phase: "error", season, error: e.message };
    await kv.set(jobKey, errState, { ex: 300 }).catch(() => {});
    return res.status(500).json({ phase: "error", error: e.message });
  }
}
