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
  const price    = parseFloat(p.price_excluding_tax || p.price || p.retail_price || 0);
  const skuKey   = (p.sku || "").toLowerCase().trim();

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

  try {

    // ── INIT: departments + PO headers ──────────────────────────────────────
    if (state.phase === "init") {
      state.progress = "Loading departments & purchase orders…";
      const dateFrom   = seasonSalesDateFrom(season);
      const dateParam  = dateFrom ? `&date_from=${dateFrom}` : "";
      const [cats, consignments, returnConsignments] = await Promise.all([
        lsFetchAll("2.0/product_types"),
        lsFetchAll(`2.0/consignments?type=SUPPLIER${dateParam}`),
        lsFetchAll(`2.0/consignments?type=RETURN`),
      ]);

      // Trim to only needed fields to keep KV payloads small
      state.cats               = cats.map(c => ({ id: c.id, name: c.name }));
      state.consignments       = consignments.map(c => ({ id: c.id }));
      state.returnConsignments = returnConsignments.map(c => ({
        id:      c.id,
        suppId:  (c.supplier && c.supplier.id)   || c.supplier_id   || "__none__",
        suppName:(c.supplier && c.supplier.name) || "Unknown",
      }));
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
              registerProduct(state, prod); pidSet.add(prod.id);
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

        if (state.seasonPids.length === 0) {
          const doneTs = Date.now();
          const result = { ts: doneTs, season, summaryRows: [], deptVendors: {}, productStats: {}, seasonPids: [], pidToType: {}, pidToSupplier: {}, pidToQtyOrdered: {}, skuToPid: {} };
          await Promise.all([
            kv.set(dataKey, result, { ex: 48 * 3600 }),
            kv.set(jobKey, { phase: "done", season, ts: doneTs }, { ex: 2 * 3600 }),
          ]);
          await kv.del(bigKey);
          return res.json({ phase: "done", season, ts: doneTs, progress: "No products found for season." });
        }

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
          if (!seasonPidSet.has(pid)) continue;
          const itemRetailPrice = parseFloat(item.price || item.unit_price || item.retail_price || 0);
          if (!state.pidToPrice[pid] && itemRetailPrice) state.pidToPrice[pid] = itemRetailPrice;

          // Lazy price fetch: only for LS-native products with no price, fetched at most once per pid.
          // Limits fetches to ~200-500 distinct products in POs rather than all 7000+ season products.
          if (!state.pidToPrice[pid]) {
            const sup = state.pidToSupplier[pid];
            if (sup && sup.i !== "__none__") {
              if (!state._priceTried) state._priceTried = {};
              if (!state._priceTried[pid]) {
                state._priceTried[pid] = true;
                try {
                  const r = await fetch(`${base}/2.0/products/${pid}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
                  if (r.ok) {
                    const json = await r.json();
                    const pd = json.data || json;
                    const fetchedPrice = parseFloat(pd.price_excluding_tax || pd.price || pd.retail_price || 0);
                    if (fetchedPrice > 0) {
                      state.pidToPrice[pid] = fetchedPrice;
                    } else if (pd.variant_parent_id && !state._priceTried[pd.variant_parent_id]) {
                      // Variant has no own price — LS stores price on the parent product
                      state._priceTried[pd.variant_parent_id] = true;
                      try {
                        const pr = await fetch(`${base}/2.0/products/${pd.variant_parent_id}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
                        if (pr.ok) {
                          const pjson = await pr.json();
                          const pard = pjson.data || pjson;
                          const parentPrice = parseFloat(pard.price_excluding_tax || pard.price || pard.retail_price || 0);
                          if (parentPrice > 0) state.pidToPrice[pid] = parentPrice;
                        }
                      } catch (e) {}
                    }
                  }
                } catch (e) {}
              }
            }
          }

          const price      = state.pidToPrice[pid] || 0;
          const itemCost   = parseFloat(item.cost || 0);
          const qtyOrdered = Math.max(0, item.count    || 0);
          const qtyRecvd   = Math.max(0, item.received || 0);

          // Always accumulate qty — pidToQtyOrdered is looked up by SKU for override products,
          // so supplier doesn't matter here
          state.pidToQtyOrdered[pid] = (state.pidToQtyOrdered[pid] || 0) + qtyOrdered;

          // Dollar rollup only makes sense when we know the supplier (non-override products)
          const sup = state.pidToSupplier[pid];
          if (!sup || sup.i === "__none__") continue;

          if (!state.productStats[pid]) state.productStats[pid] = { ordered: 0, orderedCost: 0, received: 0, receivedCost: 0, retVal: 0, retCost: 0, soldAmt: 0, sold: 0, onSale: 0, returned: 0 };
          const ps = state.productStats[pid];
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
          const itemCost = parseFloat(item.cost || 0);
          // LS may store return quantities as negative (return) or positive — use absolute value
          const qty      = Math.abs(item.count || 0);
          if (!qty) continue;

          const inSeason = seasonPidSet.has(pid);
          // Prefer supplier from product scan; fall back to consignment header supplier
          const sup = (inSeason && state.pidToSupplier[pid] && state.pidToSupplier[pid].i !== "__none__")
            ? state.pidToSupplier[pid]
            : { i: c.suppId, n: c.suppName };
          if (!sup || sup.i === "__none__") continue;

          // Lazy price fetch for in-season products still missing a price
          if (inSeason && !state.pidToPrice[pid]) {
            if (!state._priceTried) state._priceTried = {};
            if (!state._priceTried[pid]) {
              state._priceTried[pid] = true;
              try {
                const r = await fetch(`${base}/2.0/products/${pid}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
                if (r.ok) {
                  const json = await r.json();
                  const pd = json.data || json;
                  const fetchedPrice = parseFloat(pd.price_excluding_tax || pd.price || pd.retail_price || 0);
                  if (fetchedPrice > 0) {
                    state.pidToPrice[pid] = fetchedPrice;
                  } else if (pd.variant_parent_id && !state._priceTried[pd.variant_parent_id]) {
                    state._priceTried[pd.variant_parent_id] = true;
                    try {
                      const pr = await fetch(`${base}/2.0/products/${pd.variant_parent_id}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
                      if (pr.ok) {
                        const pjson = await pr.json();
                        const pard = pjson.data || pjson;
                        const parentPrice = parseFloat(pard.price_excluding_tax || pard.price || pard.retail_price || 0);
                        if (parentPrice > 0) state.pidToPrice[pid] = parentPrice;
                      }
                    } catch (e) {}
                  }
                }
              } catch (e) {}
            }
          }

          // Try pidToPrice first, then item's own retail price field as fallback
          const itemRetailPrice = parseFloat(item.price || item.unit_price || item.retail_price || 0);
          const price = (inSeason && state.pidToPrice && state.pidToPrice[pid]) || (inSeason ? itemRetailPrice : 0);

          if (!state.productStats[pid]) state.productStats[pid] = { ordered: 0, orderedCost: 0, received: 0, receivedCost: 0, retVal: 0, retCost: 0, retQty: 0, soldAmt: 0, sold: 0, onSale: 0, returned: 0 };
          const ps = state.productStats[pid];
          ps.retVal  += price    * qty;
          ps.retCost += itemCost * qty;
          ps.retQty  = (ps.retQty || 0) + qty;
          // Store fallback supplier on out-of-season products so finalizing can roll them up
          if (!inSeason) ps._sup = { i: sup.i, n: sup.n };
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

        delete state.returnConsignments;
        state.phase      = "sales";
        state.salesPages = 0;
        state.saleCursor = null;
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

            if (!state.productStats[pid]) state.productStats[pid] = { ordered: 0, orderedCost: 0, received: 0, receivedCost: 0, retVal: 0, retCost: 0, soldAmt: 0, saleAmt: 0, sold: 0, onSale: 0, returned: 0 };
            const ps = state.productStats[pid];
            // soldAmt tracks net $ (negative for customer returns)
            ps.soldAmt = (ps.soldAmt || 0) + amount;
            const unitPrice   = qty !== 0 ? Math.abs(amount / qty) : 0;
            const retailPrice = state.pidToPrice ? (state.pidToPrice[pid] || 0) : 0;
            const discounted  = parseFloat(li.discount || li.line_discount || li.discount_total || 0) > 0
              || amount === 0
              || (retailPrice > 0 && unitPrice < retailPrice * 0.99);
            if (qty < 0) {
              // Customer return — remove from the correct bucket, track returned units
              if (discounted) {
                ps.onSale = Math.max(0, (ps.onSale || 0) + qty);
              } else {
                ps.sold = Math.max(0, (ps.sold || 0) + qty);
              }
              ps.returned = (ps.returned || 0) + Math.abs(qty);
            } else {
              if (discounted) {
                ps.onSale = (ps.onSale || 0) + qty;
                ps.saleAmt = (ps.saleAmt || 0) + amount; // actual discounted sale dollars
              } else {
                ps.sold += qty;
              }
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

    // ── FINALIZING: roll productStats up to vendor → dept → summary ────────────
    if (state.phase === "finalizing") {
      const pidToPrice = state.pidToPrice || {};
      delete state.pidToPrice;

      // Patch retVal for any vendor returns where price wasn't available during the returns phase
      for (const [pid, ps] of Object.entries(state.productStats)) {
        if ((ps.retQty || 0) > 0 && !ps.retVal && pidToPrice[pid]) {
          ps.retVal = ps.retQty * pidToPrice[pid];
        }
      }

      // Roll up productStats → deptVendorData
      const deptVendorData = {};
      for (const [pid, ps] of Object.entries(state.productStats)) {
        const cid = state.pidToType[pid]     || "__none__";
        const sup = state.pidToSupplier[pid] || ps._sup;
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
        v.returned     += ps.retVal || ((ps.retQty || 0) * (pidToPrice[pid] || 0));
        v.returnedCost += ps.retCost      || 0;
        v.sold         += ps.soldAmt      || 0;
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
        skuToPid:        state.skuToPid || {},
      };

      const pidsKey = `scan:pids:${state.season}`;
      const doneTs  = Date.now();
      await Promise.all([
        kv.set(dataKey, result, { ex: 48 * 3600 }),
        kv.set(pidsKey, { seasonPids: state.seasonPids, pidToType: state.pidToType, pidToSupplier: state.pidToSupplier, skuToPid: state.skuToPid || {}, pidToPrice }, { ex: 48 * 3600 }),
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
    const SMALL_FIELDS = new Set(["phase","season","startedAt","progress","error","consigIdx","returnConsigIdx","salesPages","saleCursor","salesDateFrom","_seedReady","_priorIdx","_handleIdx"]);
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
