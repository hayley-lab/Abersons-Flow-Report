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
import { makeLsFetch } from "../../../lib/ls-fetch";
import { fetchSalesPages, getCursor } from "../../../lib/ls-sales-pagination";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import {
  applySalesTotals,
  consignmentDate,
  dateInRange,
  dateMinusDays,
  derivedOnHand,
  displayOnHand,
  emptyProductStats,
  netOrderedValue,
  netReceivedCost,
  netReceivedRetail,
  preferPositive,
  productCost,
  productName,
  productPrice,
  productVariant,
  returnedCostValue,
  returnedRetailValue,
  seasonScanDateRange,
  seasonSalesFallbackDate,
  skuMatchesSeason,
} from "../../../lib/flow-math";
import {
  backfillSales,
  clearLedger,
  loadSalesState,
  reconcileSale,
  saveSalesState,
} from "../../../lib/sales-ledger";
import {
  applyConsignmentTotalsToMaps,
  clearConsignmentLedger,
  loadConsignmentState,
  reconcileConsignment,
  saveConsignmentState,
} from "../../../lib/consignment-ledger";
import { liveOnHandFromCache, syncInventoryCache } from "../../../lib/inventory-ledger";
import {
  handleForSku,
  pidsMissingSku,
  recoverSkuMetadata,
  selectCostBackfillPids,
  shouldFetchHandle,
} from "../../../lib/product-metadata";
import { filterRestoredSeasonPids, pidToSkuFromSources } from "../../../lib/product-seed";
import { searchEnabled, searchPages, SEARCH_PAGE_SIZE } from "../../../lib/ls-search";
import { shouldFullCatalogScan } from "../../../lib/catalog-gate";
import { loadSeasonBucket } from "../../../lib/catalog-store";
import { loadSalesAgg, loadSalesStoreMeta, projectSeasonSales } from "../../../lib/sales-store";
import { consignSeasonKey } from "../../../lib/consignment-store";
import {
  deleteScanBig,
  loadScanBig,
  loadScanData,
  loadScanPids,
  saveScanBig,
  saveScanData,
  saveScanPids,
} from "../../../lib/scan-data-store";
import {
  isResolvedSupplier,
  supplierId,
  supplierName,
  vendorBucketKey,
  vendorIdentityFromLs,
} from "../../../lib/vendor-match";

const CHUNK_MS = 6000;
// Bulk inventory is the default on Vercel Pro (300s maxDuration); set
// ENABLE_BULK_INVENTORY=0 to force the per-product fallback. The bulk path is
// chunked by the step deadline and the store-wide cache is version-incremental,
// so it no longer risks the Hobby-runtime timeout that originally gated it.
const ENABLE_BULK_INVENTORY = process.env.ENABLE_BULK_INVENTORY !== "0";
// When the store-wide sales cache is built (by the cron drive), each season
// projects its sales from that shared aggregate instead of paging 2.0/sales —
// the single biggest per-season call saving. Set ENABLE_SALES_STORE=0 to force
// the legacy per-season paging path. step.js also auto-falls-back per run if the
// store isn't complete yet, so a missing/partial cache never blocks a scan.
const ENABLE_SALES_STORE = process.env.ENABLE_SALES_STORE !== "0";
// When the store-wide consignment cache is built (by the cron drive), each
// season reads its ordered/received/returned qty from the projected per-season
// bucket instead of re-paging consignment headers and every PO's line items.
// Set ENABLE_CONSIGN_STORE=0 to force legacy per-season consignment paging;
// step.js also auto-falls-back per run if the bucket isn't present yet.
const ENABLE_CONSIGN_STORE = process.env.ENABLE_CONSIGN_STORE !== "0";
// Cost is the only product field we cannot recover by inverting skuToPid — it
// needs a live LS fetch (supply_price). Backfill it in bounded per-scan chunks
// so the scan always finalizes; remaining products fill in over later scans.
const COST_BACKFILL_PER_SCAN = 200;

function registerProduct(state, p) {
  if (!state.parentStore) state.parentStore = {};
  const typeId = p.product_type_id || "__none__";
  const vendor = vendorIdentityFromLs(p);
  const price = productPrice(p);
  const cost = productCost(p);
  const skuKey = (p.sku || "").toLowerCase().trim();
  const overrideVendor = state.skuToVendorOverride?.[skuKey];

  let resolvedType = typeId,
    resolvedSuppId = overrideVendor?.id || vendor.id,
    resolvedSuppName = overrideVendor?.name || vendor.name;
  let resolvedPrice = price;
  let resolvedCost = cost;

  if (p._parent && !state.parentStore[p._parent.id]) {
    const parentVendor = vendorIdentityFromLs(p._parent);
    state.parentStore[p._parent.id] = {
      t: p._parent.product_type_id || "__none__",
      si: parentVendor.id,
      sn: parentVendor.name,
      p: productPrice(p._parent),
      c: productCost(p._parent),
    };
  }

  if (p.variant_parent_id) {
    const par = state.parentStore[p.variant_parent_id];
    if (par) {
      if (resolvedType === "__none__") resolvedType = par.t;
      if (resolvedSuppId === "__none__") {
        resolvedSuppId = par.si;
        resolvedSuppName = par.sn;
      }
      if (resolvedPrice === 0) resolvedPrice = par.p;
      if (resolvedCost === 0) resolvedCost = par.c;
    } else if (
      resolvedType === "__none__" ||
      resolvedSuppId === "__none__" ||
      resolvedPrice === 0
    ) {
      // Parent not in store (slow-path scan) — queue for fixup after scan
      if (!state.variantNeedsFixup) state.variantNeedsFixup = {};
      state.variantNeedsFixup[p.id] = p.variant_parent_id;
    }
    state.variantsSeenInScan = true;
  } else {
    state.parentStore[p.id] = { t: typeId, si: vendor.id, sn: vendor.name, p: price };
    if (!state.seasonParentIds.includes(p.id)) state.seasonParentIds.push(p.id);
  }

  if (!state.seasonPids.includes(p.id)) {
    state.seasonPids.push(p.id);
    state.pidToType[p.id] = resolvedType;
    state.pidToSupplier[p.id] = { i: resolvedSuppId, n: resolvedSuppName };
    state.pidToPrice[p.id] = resolvedPrice;
    state.pidToCost[p.id] = resolvedCost;
    state.pidToName[p.id] = productName(p);
    state.pidToSku[p.id] = p.sku || "";
    state.pidToVariant[p.id] = productVariant(p);
    if (skuKey) {
      if (!state.skuToPid) state.skuToPid = {};
      state.skuToPid[skuKey] = p.id;
    }
  }

  // Prior pid caches may predate metadata fields. Keep product display maps
  // fresh even when the pid was already registered.
  state.pidToType[p.id] = state.pidToType[p.id] || resolvedType;
  state.pidToSupplier[p.id] = state.pidToSupplier[p.id] || {
    i: resolvedSuppId,
    n: resolvedSuppName,
  };
  // Upgrade-only: promote a stored $0 to a real catalog price, but never let a
  // real price be clobbered back to $0 (preferPositive encodes both rules).
  state.pidToPrice[p.id] = preferPositive(state.pidToPrice[p.id], resolvedPrice);
  state.pidToCost[p.id] = preferPositive(state.pidToCost[p.id], resolvedCost);
  state.pidToName[p.id] = state.pidToName[p.id] || productName(p);
  state.pidToSku[p.id] = state.pidToSku[p.id] || p.sku || "";
  state.pidToVariant[p.id] = state.pidToVariant[p.id] || productVariant(p);
  if (skuKey && !state.skuToPid[skuKey]) state.skuToPid[skuKey] = p.id;
}

function restorePriorPidMaps(state, sources, allowedPids) {
  for (const source of sources) {
    if (!source) continue;
    for (const [pid, value] of Object.entries(source.pidToType || {})) {
      if (allowedPids.has(String(pid))) state.pidToType[pid] = value;
    }
    for (const [pid, value] of Object.entries(source.pidToSupplier || {})) {
      if (allowedPids.has(String(pid))) state.pidToSupplier[pid] = value;
    }
    for (const [sku, pid] of Object.entries(source.skuToPid || {})) {
      if (allowedPids.has(String(pid))) state.skuToPid[sku] = pid;
    }
    for (const [pid, value] of Object.entries(source.pidToPrice || {})) {
      if (allowedPids.has(String(pid))) state.pidToPrice[pid] = value;
    }
    for (const [pid, value] of Object.entries(source.pidToCost || {})) {
      if (allowedPids.has(String(pid))) state.pidToCost[pid] = value;
    }
    for (const [pid, value] of Object.entries(source.pidToName || {})) {
      if (allowedPids.has(String(pid))) state.pidToName[pid] = value;
    }
    for (const [pid, value] of Object.entries(source.pidToSku || {})) {
      if (allowedPids.has(String(pid))) state.pidToSku[pid] = value;
    }
    for (const [pid, value] of Object.entries(source.pidToVariant || {})) {
      if (allowedPids.has(String(pid))) state.pidToVariant[pid] = value;
    }
    for (const [pid, value] of Object.entries(source.costDone || {})) {
      if (allowedPids.has(String(pid))) state.costDone[pid] = value;
    }
    Object.assign(state.deadHandles, source.deadHandles || {});
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const session = cronAuth ? { authed: true } : await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  // Force the legacy per-season catalog scan even when a cache/prior set exists.
  const catalogForce = req.query.catalog === "1";

  const jobKey = `scan:job:${season}`;

  // Load small + big state and merge
  const restart = req.query.restart === "1";
  const requestedMode = !restart && req.query.mode === "incremental" ? "incremental" : "full";
  if (restart) await deleteScanBig(kv, season).catch(() => {});
  const [smallState, bigData] = restart
    ? [null, null]
    : await Promise.all([kv.get(jobKey), loadScanBig(kv, season)]);
  let state = smallState ? { ...smallState, ...(bigData || {}) } : null;

  if (!state || state.phase === "done" || state.phase === "error") {
    state = {
      phase: "init",
      season,
      scanMode: requestedMode,
      startedAt: Date.now(),
      progress: "Starting…",
    };
  }
  if (!state.scanMode) state.scanMode = requestedMode;

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ phase: "error", error: "LS auth failed: " + e.message });
  }

  const base = lsBase();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const deadline = Date.now() + CHUNK_MS;
  const lsFetch = makeLsFetch({ base, headers });

  // Fold this step's request tally into the season's cumulative counter so a
  // full scan reports total LS calls per endpoint family (rate-limit budget).
  function accumulateCalls() {
    if (!state.callCounts) state.callCounts = { total: 0, byFamily: {} };
    const s = lsFetch.callStats;
    state.callCounts.total += s.total;
    for (const [k, v] of Object.entries(s.byFamily)) {
      state.callCounts.byFamily[k] = (state.callCounts.byFamily[k] || 0) + v;
    }
    return state.callCounts;
  }

  async function lsFetchAll(path) {
    const results = [];
    let after = null;
    for (let p = 0; p < 200; p++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await lsFetch(path + sep + "page_size=200" + (after ? "&after=" + after : ""));
      const items = data.data || [];
      results.push(...items);
      if (items.length < 200) break;
      after = getCursor(data, items);
      if (!after) break;
    }
    return results;
  }

  async function fetchProduct(pid, retries = 4) {
    const r = await lsFetch(`2.0/products/${pid}`, retries);
    const p = r.data || r;
    if (p && p.variant_parent_id) {
      try {
        const pr = await lsFetch(`2.0/products/${p.variant_parent_id}`, retries);
        p._parent = pr.data || pr;
      } catch (e) {}
    }
    return p;
  }

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
      const matches =
        skuMatchesSeason(product?.sku, season) || skuMatchesSeason(product?._parent?.sku, season);
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

  function fullRebuild() {
    return state.scanMode !== "incremental";
  }

  function trimConsignment(c) {
    return {
      id: c.id,
      type: c.type,
      version: c.version || null,
      status: c.status || null,
      deleted_at: c.deleted_at || null,
      date: consignmentDate(c),
      created_at: c.created_at || null,
      received_at: c.received_at || null,
      due_at: c.due_at || null,
      supplier_id: c.supplier_id || null,
      supplier: c.supplier || null,
    };
  }

  async function fetchConsignmentHeaders(type) {
    const scanRange = state.scanRange || seasonScanDateRange(season);
    const params = [`type=${encodeURIComponent(type)}`];
    const modeIsFull = fullRebuild() || state.consignmentBackfill;
    const after = state.consignmentState?.maxVersionByType?.[type];
    if (modeIsFull && scanRange.start)
      params.push(`date_from=${encodeURIComponent(scanRange.start)}`);
    if (!modeIsFull && after) params.push(`after=${encodeURIComponent(after)}`);

    const headers = (await lsFetchAll(`2.0/consignments?${params.join("&")}`)).map(trimConsignment);
    if (type !== "RETURN") return headers;
    return headers.filter((c) => !c.date || dateInRange(c.date, scanRange));
  }

  function hydrateProductStatsFromQuantityMaps() {
    const ids = new Set([
      ...Object.keys(state.pidToQtyOrdered || {}),
      ...Object.keys(state.pidToQtyReceived || {}),
      ...Object.keys(state.pidToQtyReturned || {}),
    ]);

    for (const pid of ids) {
      const ps = getProductStats(pid);
      ps.qtyOrdered = state.pidToQtyOrdered?.[pid] || 0;
      ps.qtyReceived = state.pidToQtyReceived?.[pid] || 0;
      ps.retQty = state.pidToQtyReturned?.[pid] || 0;
    }
  }

  try {
    // ── INIT: departments + PO headers ──────────────────────────────────────
    if (state.phase === "init") {
      state.progress = "Loading departments…";
      const scanRange = seasonScanDateRange(season);
      const cats = await lsFetchAll("2.0/product_types");

      // Trim to only needed fields to keep KV payloads small
      state.cats = cats.map((c) => ({ id: c.id, name: c.name }));
      state.scanRange = scanRange;
      state.parentStore = {};
      state.seasonPids = [];
      state.seasonParentIds = [];
      state.pidToType = {};
      state.pidToSupplier = {};
      state.pidToPrice = {};
      state.pidToCost = {};
      state.pidToName = {};
      state.pidToSku = {};
      state.pidToVariant = {};
      state.pidToQtyOrdered = {};
      state.pidToQtyReceived = {};
      state.pidToQtyReturned = {};
      state.skuToPid = {};
      state.skuToVendorOverride = {};
      state.negPids = {};
      state.salesFloorDate = null;
      state.variantsSeenInScan = false;
      state.variantNeedsFixup = {};
      state.productStats = {};
      state.costDone = {};
      state.deadHandles = {};
      state.callCounts = { total: 0, byFamily: {} };

      state.phase = "products_seed";
      state.progress = `Loaded ${cats.length} depts — seeding products…`;
    }

    // ── PRODUCTS_SEED: discover season products without a full catalog scan ───
    // Sources (deduplicated by PID):
    //   1. Prior scan's pid maps — restored directly from KV (instant, no API calls)
    //   2. Datatail override SKUs — handle lookup for any new products not in prior scan
    //   3. LS PO line items       — lazy registration in consignments phase below
    if (state.phase === "products_seed" && Date.now() < deadline) {
      if (!state._seedReady) {
        state._seedReady = true;
        state._seedHandles = [];
        state._handleIdx = 0;
        state._metaPids = [];
        state._metaIdx = 0;
        state._costPids = [];
        state._costIdx = 0;
        if (!state.costDone) state.costDone = {};
        if (!state.deadHandles) state.deadHandles = {};
        const priorPidSet = new Set(state.seasonPids);

        // 1. Restore pid maps from lightweight scan:pids key (avoids loading full scan:data blob)
        try {
          const [priorPidMaps, priorData] = await Promise.all([
            loadScanPids(kv, season),
            loadScanData(kv, season),
          ]);
          const priorPids = priorPidMaps || priorData; // fallback for first run
          if (priorPids && Array.isArray(priorPids.seasonPids) && priorPids.seasonPids.length > 0) {
            const priorSources = [priorData, priorPidMaps];
            const restoredPidToSku = pidToSkuFromSources(...priorSources);
            const restoredSeasonPids = filterRestoredSeasonPids(
              priorPids.seasonPids,
              season,
              restoredPidToSku
            );
            const allowedPids = new Set(restoredSeasonPids.map(String));
            for (const pid of restoredSeasonPids) {
              if (!priorPidSet.has(pid)) {
                state.seasonPids.push(pid);
                priorPidSet.add(pid);
              }
            }
            restorePriorPidMaps(state, priorSources, allowedPids);
          }
        } catch (e) {}

        // 1b. Restore this season's products from the shared catalog bucket
        //     (zero API calls). The store-wide catalog cache holds every product;
        //     the bucket is the season's slice in the same shape as scan:pids.
        try {
          const bucket = await loadSeasonBucket(kv, season);
          // A present bucket means the shared catalog finished and bucketed this
          // season — authoritative even when empty (a future season with no
          // products). Record that so the per-season /search fallback is skipped.
          if (bucket && Array.isArray(bucket.seasonPids)) {
            state._catalogSeeded = true;
            for (const pid of bucket.seasonPids) {
              if (!priorPidSet.has(pid)) {
                state.seasonPids.push(pid);
                priorPidSet.add(pid);
              }
            }
            Object.assign(state.pidToType, bucket.pidToType || {});
            Object.assign(state.pidToSupplier, bucket.pidToSupplier || {});
            Object.assign(state.skuToPid, bucket.skuToPid || {});
            Object.assign(state.pidToPrice, bucket.pidToPrice || {});
            Object.assign(state.pidToCost, bucket.pidToCost || {});
            Object.assign(state.pidToName, bucket.pidToName || {});
            Object.assign(state.pidToSku, bucket.pidToSku || {});
            Object.assign(state.pidToVariant, bucket.pidToVariant || {});
            // The bucket's cost comes from /search (the catalog source of truth),
            // so mark these pids cost-resolved to skip the per-scan cost backfill
            // — that's the bulk of the legacy per-season product API calls.
            for (const pid of bucket.seasonPids) state.costDone[pid] = 1;
          }
        } catch (e) {}

        // 2. Collect handles for override products not already in the pid set
        //    (new products added to datatail since last scan)
        try {
          const indexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
          const vendorIndex = Array.isArray(indexRaw)
            ? indexRaw
            : indexRaw
              ? JSON.parse(indexRaw)
              : [];
          const vendorRaws = await Promise.all(
            vendorIndex.map((k) => kv.get(`scan:override:${season}:v:${k}`))
          );
          const handleSet = new Set();
          for (const raw of vendorRaws) {
            const v = !raw ? null : typeof raw === "object" ? raw : JSON.parse(raw);
            for (const p of (v && v.products) || []) {
              const sku = (p.style || "").toLowerCase().trim();
              if (sku) {
                state.skuToVendorOverride[sku] = {
                  id: v.vendorId || `${v.deptId || v.deptName || "override"}:${v.vendorName}`,
                  name: v.vendorName || "Imported Vendor",
                };
                if (state.skuToPid[sku]) {
                  state.pidToSupplier[state.skuToPid[sku]] = state.skuToVendorOverride[sku];
                }
              }
              // Fetch only SKUs not already mapped to a PID and not previously
              // found to be dead (no in-season LS product) — avoids re-fetching
              // hundreds of unresolved RMH handles on every scan.
              if (
                shouldFetchHandle(sku, {
                  skuToPid: state.skuToPid,
                  deadHandles: state.deadHandles,
                  catalogComplete: state._catalogSeeded,
                })
              )
                handleSet.add(handleForSku(sku));
            }
          }
          state._seedHandles = [...handleSet];
        } catch (e) {}

        // Always invert skuToPid so SKU/name columns populate instantly for any
        // prior pids, regardless of discovery mode.
        const recoveredFromSku = recoverSkuMetadata({
          skuToPid: state.skuToPid,
          pidToSku: state.pidToSku,
          pidToName: state.pidToName,
        });

        // Catalog mode: on a full rebuild with /search enabled, discover season
        // products by paginating the whole catalog (page_size 1000, ~5x cheaper
        // per record) and filtering by SKU. /search returns cost/price/supplier/
        // type per product (variants included), so this replaces the per-handle
        // lookups, the metadata backfill, AND the multi-scan cost backfill.
        //
        // With the shared catalog cache this is a disabled fallback: it only runs
        // when the season has no cached/prior pids to seed from (true cold edge
        // case) or when explicitly forced via ?catalog=1.
        state._catalogMode = shouldFullCatalogScan({
          searchEnabled: searchEnabled(),
          fullRebuild: fullRebuild(),
          priorPidCount: state.seasonPids.length,
          catalogSeeded: state._catalogSeeded,
          force: catalogForce,
        });

        if (state._catalogMode) {
          state._catalogOffset = 0;
          state._catalogDone = false;
          state._catalogMatched = 0;
          // Datatail handles / cost backfill are unnecessary in catalog mode.
          state._seedHandles = [];
          state._metaPids = [];
          state._costPids = [];
          console.warn(
            `[step] ${season} products_seed (catalog/search): restored ${state.seasonPids.length} prior pids, recovered ${recoveredFromSku} SKUs — scanning full catalog via /search`
          );
          state.progress = "Scanning product catalog via search…";
        } else {
          // Legacy mode (incremental scans or /search disabled): restore + new
          // datatail handles + bounded per-scan cost backfill.
          state._metaPids = pidsMissingSku(state.seasonPids, state.pidToSku);
          state._costPids = selectCostBackfillPids(
            state.seasonPids,
            { pidToPrice: state.pidToPrice, costDone: state.costDone },
            COST_BACKFILL_PER_SCAN
          );
          console.warn(
            `[step] ${season} products_seed: restored ${state.seasonPids.length} prior pids, recovered ${recoveredFromSku} SKUs from skuToPid, ${state._seedHandles.length} new handles, ${state._metaPids.length} missing SKU, ${state._costPids.length} cost backfill`
          );
          state.progress = `Seeding products (${state.seasonPids.length} from prior scan, ${state._seedHandles.length} new from datatail, ${state._costPids.length} cost lookups)…`;
        }
      }

      const pidSet = new Set(state.seasonPids);
      // Defensive: a scan whose state was initialized by an older deploy may
      // lack these maps when resumed after a deploy. The one-time setup guard
      // above is skipped on resume (_seedReady already set), so ensure they
      // exist here, where the loops below write to them every step.
      if (!state.deadHandles) state.deadHandles = {};
      if (!state.costDone) state.costDone = {};

      // Fetch only NEW override handles not covered by the prior scan
      while (state._handleIdx < state._seedHandles.length && Date.now() < deadline) {
        const handle = state._seedHandles[state._handleIdx];
        let fetchOk = false;
        let matchedSeason = false;
        try {
          const data = await lsFetch(
            "2.0/products?handle=" + encodeURIComponent(handle) + "&page_size=10"
          );
          fetchOk = true;
          for (const prod of data.data || []) {
            if (prod && skuMatchesSeason(prod.sku, season)) {
              matchedSeason = true;
              if (prod.id && !pidSet.has(prod.id)) {
                registerProduct(state, prod);
                pidSet.add(prod.id);
              }
            }
          }
        } catch (e) {}
        // Only record a handle as dead on a clean response with no in-season
        // product — never on a transient fetch error, which would drop a real
        // product permanently.
        if (fetchOk && !matchedSeason) state.deadHandles[handle] = 1;
        state._handleIdx++;
        if (state._handleIdx % 20 === 0)
          state.progress = `Fetching new datatail products (${state._handleIdx}/${state._seedHandles.length})…`;
      }

      while (
        state._handleIdx >= state._seedHandles.length &&
        state._metaIdx < state._metaPids.length &&
        Date.now() < deadline - 1500
      ) {
        const pid = state._metaPids[state._metaIdx];
        const product = await fetchProduct(pid, 1).catch(() => null);
        if (
          product?.id &&
          (skuMatchesSeason(product.sku, season) || skuMatchesSeason(product?._parent?.sku, season))
        ) {
          registerProduct(state, product);
        }
        state._metaIdx++;
        state.progress = `Backfilling product metadata (${state._metaIdx}/${state._metaPids.length})…`;
      }

      // Bounded cost backfill — runs only after SKU metadata is settled. Capped
      // per scan so finalize is never blocked; costDone marks every attempted
      // pid (even when LS reports $0) so it isn't re-fetched on the next scan.
      while (
        state._handleIdx >= state._seedHandles.length &&
        state._metaIdx >= state._metaPids.length &&
        state._costIdx < state._costPids.length &&
        Date.now() < deadline - 1500
      ) {
        const pid = state._costPids[state._costIdx];
        const product = await fetchProduct(pid, 1).catch(() => null);
        if (product?.id) {
          registerProduct(state, product);
          const c = productCost(product);
          if (c > 0) state.pidToCost[pid] = c;
        }
        state.costDone[pid] = 1;
        state._costIdx++;
        state.progress = `Backfilling product cost (${state._costIdx}/${state._costPids.length})…`;
      }

      // Catalog discovery via /search — page the whole catalog (1000/page) and
      // register season-matching products with their cost/price/supplier/type.
      // Resumable across steps via _catalogOffset.
      if (state._catalogMode && !state._catalogDone && Date.now() < deadline - 1000) {
        const result = await searchPages({
          lsFetch,
          type: "products",
          pageSize: SEARCH_PAGE_SIZE,
          startOffset: state._catalogOffset || 0,
          deadline: deadline - 500,
          onPage: (items) => {
            for (const p of items) {
              if (p && p.id && !pidSet.has(p.id) && skuMatchesSeason(p.sku, season)) {
                registerProduct(state, p);
                pidSet.add(p.id);
                state._catalogMatched = (state._catalogMatched || 0) + 1;
              }
            }
          },
        });
        state._catalogOffset = result.offset;
        state._catalogDone = result.done;
        state.progress = `Scanning catalog via search — ${state._catalogMatched || 0} matched (offset ${state._catalogOffset})…`;
      }

      const legacySeedDone =
        state._handleIdx >= state._seedHandles.length &&
        state._metaIdx >= state._metaPids.length &&
        state._costIdx >= state._costPids.length;
      const seedDone = state._catalogMode ? !!state._catalogDone : legacySeedDone;

      if (seedDone) {
        delete state._seedReady;
        delete state._seedHandles;
        delete state._handleIdx;
        delete state._metaPids;
        delete state._metaIdx;
        delete state._costPids;
        delete state._costIdx;
        delete state._catalogMode;
        delete state._catalogOffset;
        delete state._catalogDone;
        delete state._catalogMatched;
        console.warn(
          `[step] ${season} products_seed done: ${state.seasonPids.length} products found`
        );

        state.phase = "consignments";
        state.consigIdx = 0;
        state.progress = `Found ${state.seasonPids.length} products — preparing PO sync…`;
      }
    }

    // ── CONSIGNMENTS (store projection) ─────────────────────────────────────
    // When the shared consignment cache is built, read this season's projected
    // ordered/received/returned quantities from one key — no header paging and
    // no per-PO line-item fetches — and skip straight past the returns phase.
    if (
      state.phase === "consignments" &&
      ENABLE_CONSIGN_STORE &&
      !state.consignStoreUnavailable &&
      !state._consignReady &&
      Date.now() < deadline
    ) {
      try {
        const bucket = await kv.get(consignSeasonKey(season));
        if (bucket) {
          state.pidToQtyOrdered = bucket.pidToQtyOrdered || {};
          state.pidToQtyReceived = bucket.pidToQtyReceived || {};
          state.pidToQtyReturned = bucket.pidToQtyReturned || {};
          if (bucket.salesFloorDate) state.salesFloorDate = bucket.salesFloorDate;
          hydrateProductStatsFromQuantityMaps();
          const orderedCount = Object.values(state.pidToQtyOrdered).filter((q) => q > 0).length;
          const retCount = Object.values(state.pidToQtyReturned).filter((q) => q > 0).length;
          console.warn(
            `[step] ${season} CONSIGNMENTS (store projection): ${orderedCount} ordered, ${retCount} returned`
          );
          state.phase = "inventory";
          state.inventorySynced = false;
          state.salesPages = 0;
          state.saleCursor = null;
          state.progress = "Reconciling live inventory…";
        } else {
          state.consignStoreUnavailable = true;
        }
      } catch (e) {
        console.warn(`[step] ${season} consignment store projection failed, paging LS:`, e.message);
        state.consignStoreUnavailable = true;
      }
    }

    // ── CONSIGNMENTS: aggregate PO values by dept+vendor ────────────────────
    if (state.phase === "consignments" && Date.now() < deadline) {
      if (!state._consignReady) {
        state.consignmentState = await loadConsignmentState(kv, season);
        const priorPidSet = new Set(state.consignmentState.pidSet || []);
        const pidsChanged = state.seasonPids.some((pid) => !priorPidSet.has(pid));
        state.consignmentBackfill =
          fullRebuild() || !state.consignmentState.maxVersionByType?.SUPPLIER || pidsChanged;

        if (state.consignmentBackfill) {
          await clearConsignmentLedger(kv, season);
          state.consignmentState = await loadConsignmentState(kv, season);
        } else {
          applyConsignmentTotalsToMaps(state, state.consignmentState);
          hydrateProductStatsFromQuantityMaps();
        }

        state.consignments = await fetchConsignmentHeaders("SUPPLIER");
        state.consigIdx = state.consigIdx || 0;
        state._consignReady = true;
        state.progress = state.consignmentBackfill
          ? `Rebuilding PO ledger (0/${state.consignments.length})…`
          : `Syncing changed POs (0/${state.consignments.length})…`;
      }

      const seasonPidSet = new Set(state.seasonPids);

      while (state.consigIdx < state.consignments.length && Date.now() < deadline) {
        const c = state.consignments[state.consigIdx];
        const items = await lsFetchAll("2.0/consignments/" + c.id + "/products");
        await reconcileConsignment(
          kv,
          season,
          state.consignmentState,
          c,
          items,
          "SUPPLIER",
          seasonPidSet,
          ensureSeasonProduct
        );

        state.consigIdx++;
        state.progress = `${state.consignmentBackfill ? "Rebuilding" : "Syncing changed"} POs (${state.consigIdx}/${state.consignments.length})…`;
      }

      if (state.consigIdx >= state.consignments.length) {
        await saveConsignmentState(kv, season, state.consignmentState, new Set(state.seasonPids));
        applyConsignmentTotalsToMaps(state, state.consignmentState);
        hydrateProductStatsFromQuantityMaps();
        const orderedCount = Object.values(state.pidToQtyOrdered || {}).filter((q) => q > 0).length;
        console.warn(
          `[step] ${season} CONSIGNMENTS DONE: ${orderedCount} products with ordered qty, ${Object.keys(state.productStats).length} products with any stats`
        );
        delete state.consignments;
        delete state._consignReady;
        delete state.parentStore;

        state.phase = "returns";
        state.returnConsigIdx = 0;
        state.progress = "Preparing vendor return sync…";
      }
    }

    // ── RETURNS: aggregate vendor return values by dept+vendor ───────────────
    if (state.phase === "returns" && Date.now() < deadline) {
      if (!state._returnReady) {
        state.consignmentState = state.consignmentState || (await loadConsignmentState(kv, season));
        if (!state.consignmentBackfill && !state.consignmentState.maxVersionByType?.RETURN) {
          state.consignmentBackfill = true;
        }
        state.returnConsignments = await fetchConsignmentHeaders("RETURN");
        state.returnConsigIdx = state.returnConsigIdx || 0;
        state._returnReady = true;
        state.progress = state.consignmentBackfill
          ? `Rebuilding vendor return ledger (0/${state.returnConsignments.length})…`
          : `Syncing changed vendor returns (0/${state.returnConsignments.length})…`;
      }

      const seasonPidSet = new Set(state.seasonPids);

      while (state.returnConsigIdx < state.returnConsignments.length && Date.now() < deadline) {
        const c = state.returnConsignments[state.returnConsigIdx];
        const items = await lsFetchAll("2.0/consignments/" + c.id + "/products");
        await reconcileConsignment(
          kv,
          season,
          state.consignmentState,
          c,
          items,
          "RETURN",
          seasonPidSet,
          ensureSeasonProduct
        );

        state.returnConsigIdx++;
        state.progress = `${state.consignmentBackfill ? "Rebuilding" : "Syncing changed"} vendor returns (${state.returnConsigIdx}/${state.returnConsignments.length})…`;
      }

      if (state.returnConsigIdx >= state.returnConsignments.length) {
        await saveConsignmentState(kv, season, state.consignmentState, new Set(state.seasonPids));
        applyConsignmentTotalsToMaps(state, state.consignmentState);
        hydrateProductStatsFromQuantityMaps();
        // Summary log: total retVal / retCost across all products so we can confirm returns were captured
        let totalRetVal = 0,
          totalRetCost = 0,
          retProds = 0;
        for (const ps of Object.values(state.productStats)) {
          if (ps.retVal || ps.retCost) {
            totalRetVal += ps.retVal || 0;
            totalRetCost += ps.retCost || 0;
            retProds++;
          }
        }
        console.warn(
          `[step] ${season} RETURNS DONE: ${retProds} products with returns, totalRetVal=$${totalRetVal.toFixed(2)}, totalRetCost=$${totalRetCost.toFixed(2)}`
        );
        // Log any products with retQty but no retVal so we can diagnose missing prices
        for (const [pid, ps] of Object.entries(state.productStats)) {
          if ((ps.retQty || 0) > 0 && !ps.retVal) {
            const inSeason = seasonPidSet.has(pid);
            console.warn(
              `[step] ${season} RETURN-NO-PRICE: pid=${pid} retQty=${ps.retQty} inSeason=${inSeason} pidToPrice=${state.pidToPrice?.[pid]} ordered=${ps.ordered} pidToQtyOrdered=${state.pidToQtyOrdered?.[pid]}`
            );
          }
        }

        delete state.returnConsignments;
        delete state._returnReady;
        state.phase = "inventory";
        state.inventorySynced = false;
        state.salesPages = 0;
        state.saleCursor = null;
        state.progress = "Reconciling live inventory…";
      }
    }

    // ── INVENTORY: scan-time live inventory reconciliation (not used as primary)
    if (state.phase === "inventory" && Date.now() < deadline) {
      if (!state.inventorySynced) {
        if (!ENABLE_BULK_INVENTORY) {
          state.inventoryBulkFailed = true;
          state.inventoryIdx = state.inventoryIdx || 0;
        }

        if (ENABLE_BULK_INVENTORY && !state.inventoryBulkFailed) {
          try {
            // No reset: the store-wide cache is kept current by the version
            // cursor, so a full rebuild reuses it (and concurrent seasons share
            // one forward pull) instead of each season wiping and re-pulling.
            const result = await syncInventoryCache(kv, season, lsFetch, {
              reset: false,
              deadline,
            });
            state.inventoryResetDone = true;
            state.progress = result.done
              ? `Applying live inventory for ${state.seasonPids.length} products…`
              : `Syncing live inventory… (${result.pages} pages this step)`;

            if (result.done) {
              for (const pid of state.seasonPids) {
                const live = liveOnHandFromCache(result.cache, pid);
                if (live != null) getProductStats(pid).liveOnHand = live;
              }
              state.inventorySynced = true;
            }
          } catch (e) {
            state.inventoryBulkFailed = true;
            state.inventoryIdx = state.inventoryIdx || 0;
            console.warn(`[step] ${season} bulk inventory sync failed, falling back:`, e.message);
          }
        }

        while (
          state.inventoryBulkFailed &&
          state.inventoryIdx < state.seasonPids.length &&
          Date.now() < deadline
        ) {
          const batch = state.seasonPids.slice(state.inventoryIdx, state.inventoryIdx + 5);
          const liveValues = await Promise.all(
            batch.map((pid) => fetchLiveOnHand(pid).catch(() => null))
          );
          batch.forEach((pid, idx) => {
            const live = liveValues[idx];
            if (live != null) getProductStats(pid).liveOnHand = live;
          });
          state.inventoryIdx += batch.length;
          state.progress = `Reconciling live inventory fallback (${state.inventoryIdx}/${state.seasonPids.length})…`;
        }

        if (state.inventoryBulkFailed && state.inventoryIdx >= state.seasonPids.length) {
          state.inventorySynced = true;
        }
      }

      if (state.inventorySynced) {
        state.phase = "sales";
        state.salesPages = 0;
        state.saleCursor = null;
        state.progress = "Loading sales…";
      }
    }

    // Empty seasons (e.g. future 2027 seasons with no products) must not page
    // the entire sales history for nothing — skip straight to finalizing.
    if (state.phase === "sales" && (!state.seasonPids || state.seasonPids.length === 0)) {
      state.phase = "finalizing";
      state.progress = "No products in season — skipping sales.";
    }

    // ── SALES: aggregate sold $ (vendor) and sold units (product) ───────────
    if (state.phase === "sales" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      // Store-wide projection: the shared sales cache (built once by the cron
      // drive) holds a per-PID aggregate of every sale. Filtering it to this
      // season's pids reproduces the per-season sales totals with ZERO 2.0/sales
      // paging. Falls back to legacy paging if the cache isn't complete yet.
      if (ENABLE_SALES_STORE && !state.salesStoreUnavailable && !state.salesState) {
        try {
          const meta = await loadSalesStoreMeta(kv);
          if (meta && meta.complete) {
            const agg = await loadSalesAgg(kv);
            const perPid = projectSeasonSales(agg, state.seasonPids);
            state.salesState = {
              maxVersion: meta.version || null,
              perPid,
              pidSet: state.seasonPids,
            };
            await saveSalesState(kv, season, state.salesState, seasonPidSet);
            applySalesTotals(state.productStats, perPid);
            console.warn(
              `[step] ${season} SALES (store projection): ${Object.keys(perPid).length} pids with sales, version=${meta.version}`
            );
            state.phase = "finalizing";
          } else {
            state.salesStoreUnavailable = true;
          }
        } catch (e) {
          console.warn(`[step] ${season} sales store projection failed, paging LS:`, e.message);
          state.salesStoreUnavailable = true;
        }
      }
    }

    // Legacy per-season sales paging (fallback when the store cache is disabled
    // or not yet built). Skipped once the store projection set phase=finalizing.
    if (state.phase === "sales" && Date.now() < deadline) {
      const seasonPidSet = new Set(state.seasonPids);

      if (!state.salesState) {
        state.salesState = await loadSalesState(kv, season);
        const priorPidSet = new Set(state.salesState.pidSet || []);
        const pidsChanged = state.seasonPids.some((pid) => !priorPidSet.has(pid));
        // Backfill (full rebuild) when there is no ledger yet OR the product set
        // expanded — a newly-registered product may have sold before the prior
        // maxVersion and must be re-attributed against the current pid set.
        state.salesBackfill = fullRebuild() || !state.salesState.maxVersion || pidsChanged;
        state.salesDateFrom = state.salesBackfill
          ? dateMinusDays(state.salesFloorDate, 30) || seasonSalesFallbackDate(season) || ""
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

      const salesResult = await fetchSalesPages({
        lsFetch,
        deadline,
        initialCursor: state.saleCursor,
        dateFrom: state.salesDateFrom,
        onPage: async (saleItems) => {
          state.salesPages++;

          if (state.salesBackfill) {
            // Batched rebuild — no per-sale KV reads, one hset per page.
            await backfillSales(
              kv,
              season,
              state.salesState,
              saleItems,
              seasonPidSet,
              state.pidToPrice || {}
            );
          } else {
            // Incremental — small number of changed sales, read-modify-write each.
            for (const sale of saleItems) {
              await reconcileSale(
                kv,
                season,
                state.salesState,
                sale,
                seasonPidSet,
                state.pidToPrice || {}
              );
            }
          }

          state.progress = `${state.salesBackfill ? "Backfilling" : "Loading"} sales… (page ${state.salesPages})`;
        },
      });

      state.saleCursor = salesResult.cursor;
      if (salesResult.done) {
        await saveSalesState(kv, season, state.salesState, seasonPidSet);
        applySalesTotals(state.productStats, state.salesState.perPid);
        state.phase = "finalizing";
      }

      await saveSalesState(kv, season, state.salesState, seasonPidSet);
    }

    // ── FINALIZING: roll productStats up to vendor → dept → summary ────────────
    if (state.phase === "finalizing") {
      const pidToPrice = state.pidToPrice || {};
      const pidToCost = state.pidToCost || {};
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
                derivedPrice = parseFloat(
                  pard.price_excluding_tax || pard.price || pard.retail_price || 0
                );
              }
            } catch (e) {}
          }
          if (derivedPrice > 0) {
            ps.retVal = ps.retQty * derivedPrice;
            pidToPrice[pid] = derivedPrice; // keep in sync for vendor rollup below
          }
          console.warn(
            `[step] ${season} FINALIZING-RET: pid=${pid} retQty=${ps.retQty} retVal=${ps.retVal} derivedPrice=${derivedPrice}`
          );
        }
      }

      // Roll up productStats → deptVendorData
      const deptVendorData = {};
      for (const [pid, ps] of Object.entries(state.productStats)) {
        const cid = state.pidToType[pid] || "__none__";
        const sup = state.pidToSupplier[pid] || ps._sup;
        const price = pidToPrice[pid] || 0;
        const cost = pidToCost[pid] || 0;
        ps.qtyOrdered = ps.qtyOrdered || state.pidToQtyOrdered[pid] || 0;
        ps.qtyReceived = ps.qtyReceived || state.pidToQtyReceived[pid] || 0;
        ps.retQty = ps.retQty || state.pidToQtyReturned[pid] || 0;
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
        // Bucket by brand (normalized name), reading both supplier formats, so a
        // brand whose products carry the datatail numeric id and the LS uuid roll
        // into one vendor row instead of leaking into "Unassigned".
        const resolved = isResolvedSupplier(sup);
        const vendorKey = vendorBucketKey(sup);
        const vendorId = resolved ? supplierId(sup) : "__unassigned__";
        const vendorName = resolved ? supplierName(sup) : "Unassigned";
        if (!deptVendorData[cid][vendorKey]) {
          deptVendorData[cid][vendorKey] = {
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
        const v = deptVendorData[cid][vendorKey];
        v.ordered += netOrderedValue(ps, price);
        v.orderedCost += Math.max(0, ((ps.qtyOrdered || 0) - (ps.retQty || 0)) * cost);
        v.received += netReceivedRetail(ps, price);
        v.cost += netReceivedCost(ps, cost);
        v.returned += returnedRetailValue(ps, price);
        v.returnedCost += returnedCostValue(ps, cost);
        v.sold += (ps.sold || 0) * price;
      }

      // Build summary (dept-level) from deptVendorData
      const catMap = {};
      for (const cat of state.cats) {
        catMap[cat.id] = {
          id: cat.id,
          name: cat.name,
          ordered: 0,
          orderedCost: 0,
          received: 0,
          cost: 0,
          returned: 0,
          returnedCost: 0,
          sold: 0,
        };
      }
      for (const [deptId, vendors] of Object.entries(deptVendorData)) {
        if (!catMap[deptId])
          catMap[deptId] = {
            id: deptId,
            name: "Other",
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
      // summaryRows carries the department id→name map (and zero-filled totals
      // for legacy debug tools). The authoritative per-vendor/department totals
      // are rebuilt at request time by pages/api/scan/data.js from productStats +
      // the datatail override, so this scan no longer stores deptVendors.
      const summaryRows = Object.values(catMap).sort((a, b) => b.ordered - a.ordered);

      const result = {
        ts: Date.now(),
        season: state.season,
        summaryRows,
        productStats: state.productStats,
        seasonPids: state.seasonPids,
        pidToType: state.pidToType,
        pidToSupplier: state.pidToSupplier,
        pidToQtyOrdered: state.pidToQtyOrdered,
        pidToQtyReceived: state.pidToQtyReceived || {},
        pidToQtyReturned: state.pidToQtyReturned || {},
        skuToPid: state.skuToPid || {},
        pidToPrice,
        pidToCost,
        pidToName: state.pidToName || {},
        pidToSku: state.pidToSku || {},
        pidToVariant: state.pidToVariant || {},
        costDone: state.costDone || {},
        deadHandles: state.deadHandles || {},
        salesState: state.salesState
          ? { maxVersion: state.salesState.maxVersion, ts: state.salesState.ts }
          : null,
      };

      const doneTs = Date.now();
      await Promise.all([
        saveScanData(kv, state.season, result),
        saveScanPids(kv, state.season, {
          seasonPids: state.seasonPids,
          pidToType: state.pidToType,
          pidToSupplier: state.pidToSupplier,
          skuToPid: state.skuToPid || {},
          pidToPrice,
          pidToCost,
          pidToName: state.pidToName || {},
          pidToSku: state.pidToSku || {},
          pidToVariant: state.pidToVariant || {},
          costDone: state.costDone || {},
          deadHandles: state.deadHandles || {},
        }),
        // Keep job key with done+ts so cron/scan can check recency without loading scan:data.
        // Embed scanMode and (for full rebuilds) lastFull so a SINGLE scan:job read is
        // authoritative — the orchestrator must not re-restart a just-finished full season
        // just because the separate scan:lastFull key hasn't propagated yet.
        kv.set(
          jobKey,
          {
            phase: "done",
            season: state.season,
            ts: doneTs,
            scanMode: state.scanMode,
            ...(fullRebuild() ? { lastFull: doneTs } : {}),
          },
          { ex: 2 * 3600 }
        ),
        ...(fullRebuild()
          ? [kv.set(`scan:lastFull:${state.season}`, doneTs, { ex: 180 * 24 * 3600 })]
          : []),
      ]);
      await deleteScanBig(kv, state.season);

      const finalCounts = accumulateCalls();
      console.warn(
        `[step] ${state.season} DONE — LS calls total=${finalCounts.total} byFamily=${JSON.stringify(finalCounts.byFamily)}`
      );

      return res.json({
        phase: "done",
        season: state.season,
        ts: doneTs,
        mode: state.scanMode,
        progress: "Scan complete!",
        calls: finalCounts,
      });
    }

    // ── ERROR ────────────────────────────────────────────────────────────────
    if (state.phase === "error") {
      await kv.set(jobKey, { phase: "error", season, error: state.error }, { ex: 300 });
      return res.json({ phase: "error", error: state.error });
    }

    // Split state across two keys: small operational fields + big data blobs
    const SMALL_FIELDS = new Set([
      "phase",
      "season",
      "scanMode",
      "startedAt",
      "progress",
      "error",
      "consigIdx",
      "returnConsigIdx",
      "inventorySynced",
      "inventoryResetDone",
      "inventoryBulkFailed",
      "inventoryIdx",
      "salesPages",
      "saleCursor",
      "salesDateFrom",
      "salesBackfill",
      "salesLedgerCleared",
      "consignmentBackfill",
      "_seedReady",
      "_priorIdx",
      "_handleIdx",
      "_metaIdx",
      "_costIdx",
      "_catalogMode",
      "_catalogOffset",
      "_catalogDone",
      "_catalogMatched",
      "_consignReady",
      "_returnReady",
    ]);
    const cumulative = accumulateCalls();
    console.warn(
      `[step] ${season} phase=${state.phase} LS calls this step=${lsFetch.callStats.total} cumulative=${cumulative.total} byFamily=${JSON.stringify(cumulative.byFamily)}`
    );

    const small = {},
      big = {};
    for (const [k, v] of Object.entries(state)) {
      if (SMALL_FIELDS.has(k)) small[k] = v;
      else big[k] = v;
    }
    // 72h (not 24h) so a delayed/skipped nightly resumes in-progress state
    // instead of letting it expire and silently reinitializing.
    await Promise.all([
      kv.set(jobKey, small, { ex: 72 * 3600 }),
      saveScanBig(kv, season, big),
    ]);
    return res.json({
      phase: state.phase,
      mode: state.scanMode,
      progress: state.progress || "…",
      calls: cumulative,
    });
  } catch (e) {
    console.error(`[step] ${season} error:`, e.message);
    const errState = { phase: "error", season, error: e.message };
    await kv.set(jobKey, errState, { ex: 300 }).catch(() => {});
    return res.json({ phase: "error", season, error: e.message });
  }
}
