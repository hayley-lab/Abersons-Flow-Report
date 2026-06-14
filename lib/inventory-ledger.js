import {
  delShardedObject,
  getShardedObjectByPid,
  setShardedObjectByPid,
  setShardedObjectByPidShards,
} from "./kv-sharded";

const CACHE_TTL_SECONDS = 180 * 24 * 3600;
const DEFAULT_PAGE_SIZE = 500;
// How many inventory pages to accumulate before writing a checkpoint. Each
// checkpoint persists ONLY the shards touched since the last one (plus the
// marker carrying the advanced cursor). Over a few dozen pages of 500 rows the
// touched set already spans every shard, so each checkpoint rewrites all 16
// (multi-MB, growing) store shards — and on a large cache one such rewrite costs
// several seconds. So we checkpoint at most rarely WITHIN a chunk and rely on
// the always-run end-of-chunk checkpoint: this interval is sized so a normal
// rate-limited chunk writes once (at chunk end), bounding both per-chunk write
// time and crash loss to ~this many pages. The old code full-rewrote all 16
// shards after EVERY page (~220 pages on a cold build), which blew the timeout.
const DEFAULT_CHECKPOINT_EVERY_PAGES = 250;

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

// `touchedOut`, when provided, accumulates the pids changed by these rows so the
// caller can checkpoint only the affected shards. The return value (the cache)
// is unchanged for existing callers.
//
// On-hand is maintained INCREMENTALLY by per-outlet delta rather than rescanning
// the whole byOutlet map for each touched pid. The old recompute was O(total
// cache size) per touched pid per page (500 pids x ~110k entries), which made
// each inventory page take ~1s once the cache was large and was a major reason
// the cold build never finished a chunk in time. The result is identical: each
// pid's on-hand still equals the sum of its per-outlet amounts (inventory counts
// are integers, so the running delta cannot drift).
export function applyInventoryRows(cache, rows, touchedOut) {
  const next = cache || emptyCache();
  if (!next.byOutlet) next.byOutlet = {};
  if (!next.onHand) next.onHand = {};

  for (const row of rows || []) {
    const pid = productIdOf(row);
    const amount = amountOf(row);
    if (!pid || amount == null) continue;

    const outletId = outletIdOf(row);
    const outletKey = `${pid}:${outletId}`;
    const prev = next.byOutlet[outletKey];
    const prevAmount = prev == null ? 0 : Number(prev) || 0;
    next.byOutlet[outletKey] = amount;

    const pidKey = String(pid);
    const current = next.onHand[pidKey];
    next.onHand[pidKey] = (current == null ? 0 : Number(current) || 0) + (amount - prevAmount);
    if (touchedOut) touchedOut.add(pidKey);
  }

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

// Incremental checkpoint: persist only the shards touched since the previous
// checkpoint, plus the marker (which carries the advanced version cursor). An
// empty `touchedPids` set writes just the marker — cheap cursor persistence with
// no shard churn. Passing the live set keeps a checkpoint O(delta) instead of
// O(whole store) like the old per-page full saveInventoryCache.
async function checkpointInventoryCache(kv, season, cache, touchedPids) {
  cache.ts = Date.now();
  await setShardedObjectByPidShards(kv, cacheKey(season), cacheToStoredShape(cache), {
    ex: CACHE_TTL_SECONDS,
    pidFields: ["onHand", "byOutletByPid"],
    touchedPids,
  });
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
  {
    reset = false,
    deadline = Infinity,
    pageSize = DEFAULT_PAGE_SIZE,
    checkpointEvery = DEFAULT_CHECKPOINT_EVERY_PAGES,
  } = {}
) {
  const cache = reset ? emptyCache() : await loadInventoryCache(kv, season);
  let cursor = reset ? null : cache.version || null;
  let pages = 0;
  let done = false;

  // Pids touched since the last checkpoint — the set drives which shards get
  // rewritten at the next checkpoint, so checkpoints stay O(delta).
  let touchedSinceCheckpoint = new Set();
  let pagesSinceCheckpoint = 0;

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
    applyInventoryRows(cache, rows, touchedSinceCheckpoint);
    pages++;
    pagesSinceCheckpoint++;

    const nextCursor = cursorFrom(data, rows);
    if (!nextCursor || nextCursor === cursor) {
      done = true;
      break;
    }
    cursor = nextCursor;
    cache.version = nextCursor;

    if (rows.length < pageSize) {
      done = true;
      break;
    }

    // Periodic incremental checkpoint instead of full-saving every page. Writes
    // only the shards touched since the last checkpoint plus the marker (which
    // persists the advanced cursor), so an interrupted chunk loses at most
    // `checkpointEvery` pages while a chunk stays cheap enough to finish well
    // under the function timeout.
    if (pagesSinceCheckpoint >= checkpointEvery) {
      await checkpointInventoryCache(kv, season, cache, touchedSinceCheckpoint);
      touchedSinceCheckpoint = new Set();
      pagesSinceCheckpoint = 0;
    }
  }

  // Final checkpoint flushes whatever changed since the last one (including the
  // draining page that broke the loop) and persists the completeness signal.
  await checkpointInventoryCache(kv, season, cache, touchedSinceCheckpoint);
  await saveInventoryMeta(kv, { version: cache.version || null, complete: done });
  return { cache, done, pages, version: cache.version || null };
}
