import { delShardedObject, getShardedObjectByPid, setShardedObjectByPid } from "./kv-sharded";

const CACHE_TTL_SECONDS = 180 * 24 * 3600;
const DEFAULT_PAGE_SIZE = 500;

// Inventory is store-wide (every product across every season), so the cache is
// shared under one key rather than rebuilt per season. The version cursor keeps
// it current incrementally, so concurrent seasons paginate the same forward
// stream and converge instead of each doing a full per-season pull.
const STORE_CACHE_KEY = "scan:inv:store";
// Completeness signal for the store-wide inventory cache, mirroring the sales
// store meta (scan:sales:store:meta). cron/scan consults this to gate season
// stepping until the cache is built, and to SKIP re-driving an already-complete
// cache; step.js consults it to read on-hand from the cache instead of paging
// the full 2.0/inventory stream per season.
const STORE_META_KEY = "scan:inv:store:meta";

function cacheKey() {
  return STORE_CACHE_KEY;
}

export async function loadInventoryMeta(kv) {
  return (await kv.get(STORE_META_KEY)) || null;
}

export async function saveInventoryMeta(kv, meta) {
  const next = { version: null, complete: false, ...meta, ts: Date.now() };
  await kv.set(STORE_META_KEY, next, { ex: CACHE_TTL_SECONDS });
  return next;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function productIdOf(row) {
  return (
    row?.product_id ||
    row?.productId ||
    row?.product?.id ||
    row?.product?.product_id ||
    row?.product
  );
}

function outletIdOf(row) {
  return (
    row?.outlet_id ||
    row?.outletId ||
    row?.outlet?.id ||
    row?.store_id ||
    row?.location_id ||
    row?.inventory_location_id ||
    "__default__"
  );
}

function amountOf(row) {
  return numberValue(
    row?.current_amount ??
      row?.count ??
      row?.quantity ??
      row?.qty ??
      row?.on_hand ??
      row?.available ??
      row?.amount
  );
}

function cursorFrom(data, items) {
  const responseVersion =
    data?.version && typeof data.version === "object" ? data.version.max : null;
  const itemVersion = items.reduce((max, item) => Math.max(max, Number(item?.version || 0)), 0);
  return responseVersion ?? (itemVersion || null);
}

function emptyCache() {
  return { version: null, byOutlet: {}, onHand: {}, ts: null };
}

function cacheToStoredShape(cache) {
  const next = { ...emptyCache(), ...(cache || {}) };
  const byOutletByPid = {};
  for (const [key, amount] of Object.entries(next.byOutlet || {})) {
    const separator = key.indexOf(":");
    if (separator < 0) continue;
    const pid = key.slice(0, separator);
    const outlet = key.slice(separator + 1);
    if (!pid || !outlet) continue;
    if (!byOutletByPid[pid]) byOutletByPid[pid] = {};
    byOutletByPid[pid][outlet] = amount;
  }
  return {
    version: next.version,
    ts: next.ts,
    onHand: next.onHand || {},
    byOutletByPid,
  };
}

function cacheFromStoredShape(stored) {
  if (!stored) return emptyCache();
  if (!stored.byOutletByPid) return { ...emptyCache(), ...stored };

  const byOutlet = {};
  for (const [pid, outletMap] of Object.entries(stored.byOutletByPid || {})) {
    for (const [outlet, amount] of Object.entries(outletMap || {})) {
      byOutlet[`${pid}:${outlet}`] = amount;
    }
  }
  const { byOutletByPid: _byOutletByPid, ...rest } = stored;
  return {
    ...emptyCache(),
    ...rest,
    byOutlet,
    onHand: stored.onHand || {},
  };
}

function recomputeProductTotal(cache, pid) {
  let total = 0;
  const prefix = `${pid}:`;
  for (const [key, amount] of Object.entries(cache.byOutlet || {})) {
    if (key.startsWith(prefix)) total += Number(amount || 0);
  }
  cache.onHand[pid] = total;
}

export function applyInventoryRows(cache, rows) {
  const next = cache || emptyCache();
  if (!next.byOutlet) next.byOutlet = {};
  if (!next.onHand) next.onHand = {};

  const touchedPids = new Set();
  for (const row of rows || []) {
    const pid = productIdOf(row);
    const amount = amountOf(row);
    if (!pid || amount == null) continue;

    const outletId = outletIdOf(row);
    next.byOutlet[`${pid}:${outletId}`] = amount;
    touchedPids.add(String(pid));
  }

  for (const pid of touchedPids) recomputeProductTotal(next, pid);
  return next;
}

export async function loadInventoryCache(kv, season) {
  const stored = await getShardedObjectByPid(kv, cacheKey(season));
  return cacheFromStoredShape(stored);
}

export async function saveInventoryCache(kv, season, cache) {
  const next = { ...emptyCache(), ...(cache || {}), ts: Date.now() };
  await setShardedObjectByPid(kv, cacheKey(season), cacheToStoredShape(next), {
    ex: CACHE_TTL_SECONDS,
    pidFields: ["onHand", "byOutletByPid"],
  });
  return next;
}

export async function clearInventoryCache(kv, season) {
  await delShardedObject(kv, cacheKey(season));
  await kv.del(STORE_META_KEY);
}

export function liveOnHandFromCache(cache, pid) {
  const value = cache?.onHand?.[pid];
  return value == null ? null : value;
}

export async function syncInventoryCache(
  kv,
  season,
  lsFetch,
  { reset = false, deadline = Infinity, pageSize = DEFAULT_PAGE_SIZE } = {}
) {
  let cache = reset ? emptyCache() : await loadInventoryCache(kv, season);
  let cursor = reset ? null : cache.version || null;
  let pages = 0;
  let done = false;

  // A cold rebuild invalidates the prior completeness signal up front so a
  // concurrent reader (cron/scan gate, step.js) doesn't treat a half-rebuilt
  // cache as complete.
  if (reset) await saveInventoryMeta(kv, { version: null, complete: false });

  while (Date.now() < deadline) {
    const path =
      `2.0/inventory?size=${pageSize}&sort_direction=asc` +
      (cursor ? `&after=${encodeURIComponent(cursor)}` : "");
    const data = await lsFetch(path, { deadline });
    const rows = data?.data || [];
    applyInventoryRows(cache, rows);
    pages++;

    const nextCursor = cursorFrom(data, rows);
    if (!nextCursor || nextCursor === cursor) {
      done = true;
      break;
    }
    if (nextCursor) {
      cursor = nextCursor;
      cache.version = nextCursor;
      // Checkpoint after every page (mirrors the catalog cold-build per-page
      // checkpoint) so an interrupted chunk — e.g. a deadline-aware lsFetch soft
      // abort or a hard maxDuration kill — keeps this page's progress and the
      // advanced cursor instead of discarding the whole chunk.
      cache = await saveInventoryCache(kv, season, cache);
    }

    if (rows.length < pageSize) {
      done = true;
      break;
    }
  }

  cache = await saveInventoryCache(kv, season, cache);
  await saveInventoryMeta(kv, { version: cache.version || null, complete: done });
  return { cache, done, pages, version: cache.version || null };
}
