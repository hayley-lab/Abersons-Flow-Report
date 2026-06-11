const CACHE_TTL_SECONDS = 180 * 24 * 3600;
const DEFAULT_PAGE_SIZE = 500;

// Inventory is store-wide (every product across every season), so the cache is
// shared under one key rather than rebuilt per season. The version cursor keeps
// it current incrementally, so concurrent seasons paginate the same forward
// stream and converge instead of each doing a full per-season pull.
const STORE_CACHE_KEY = "scan:inv:store";

function cacheKey() {
  return STORE_CACHE_KEY;
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
  return (await kv.get(cacheKey(season))) || emptyCache();
}

export async function saveInventoryCache(kv, season, cache) {
  const next = { ...emptyCache(), ...(cache || {}), ts: Date.now() };
  await kv.set(cacheKey(season), next, { ex: CACHE_TTL_SECONDS });
  return next;
}

export async function clearInventoryCache(kv, season) {
  await kv.del(cacheKey(season));
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

  while (Date.now() < deadline) {
    const path =
      `2.0/inventory?size=${pageSize}&sort_direction=asc` +
      (cursor ? `&after=${encodeURIComponent(cursor)}` : "");
    const data = await lsFetch(path);
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
    }

    if (rows.length < pageSize) {
      done = true;
      break;
    }
  }

  cache = await saveInventoryCache(kv, season, cache);
  return { cache, done, pages, version: cache.version || null };
}
