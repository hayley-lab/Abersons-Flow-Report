// Persistent, store-wide full-catalog cache.
//
// Modeled on lib/inventory-ledger.js: the entire product catalog is cached once
// and kept current incrementally by a version cursor, so the catalog is never
// fully re-paged after the first build. Because every product is cached (not
// just active-season ones), a brand-new season is served by re-bucketing from
// cache instead of paging the catalog again.
//
// The catalog (~110k products) exceeds a safe single KV value, so it is sharded
// by a stable hash of the product id into a fixed number of shards. The version
// cursor is shared across all seasons.
//
// KV keys (all 180-day TTL, refreshed on every write):
//   scan:catalog:meta        — { version, ts, complete, buildOffset, shardCount }
//   scan:catalog:shard:{0..N} — { [pid]: { sku, name, variant, price, cost,
//                                           suppId, suppName, typeId, version } }
//   scan:catalog:season:{id}  — per-season scan:pids-shaped bucket (written on sync complete)
import {
  productCost,
  productName,
  productPrice,
  productVariant,
  skuMatchesSeason,
} from "./flow-math";
import {
  DEFAULT_KV_SHARD_COUNT,
  getShardedObjectByPid,
  setShardedObjectByPid,
  shardForPid,
} from "./kv-sharded";
import { searchPages, SEARCH_PAGE_SIZE } from "./ls-search";
import { vendorIdentityFromLs } from "./vendor-match";

const CACHE_TTL_SECONDS = 180 * 24 * 3600;
export const DEFAULT_SHARD_COUNT = DEFAULT_KV_SHARD_COUNT;
// Collection endpoint page size (max 200, version-cursor pagination), used for
// the incremental top-up. The cold build uses /search at SEARCH_PAGE_SIZE.
const INCREMENTAL_PAGE_SIZE = 200;

// Cold-build pacing. /search runs ~15s/page; keep a budget so a page is never
// started unless it can plausibly finish (plus its KV checkpoint) before the
// 60s function maxDuration, and cap retry backoff so one rate-limited page can't
// consume the whole budget mid-page.
const COLD_BUILD_PAGE_BUDGET_MS = 20000;
const COLD_BUILD_RETRIES = 3;

export const CATALOG_META_KEY = "scan:catalog:meta";

export function catalogShardKey(index) {
  return `scan:catalog:shard:${index}`;
}

export function seasonBucketKey(season) {
  return `scan:catalog:season:${season}`;
}

// Route a product id to its owning shard with a stable, pure FNV-1a hash so the
// same id always lands in the same shard regardless of process or call order.
export { shardForPid };

// Extract only the fields the pipeline needs, the same way step.js products_seed
// reads an LS product object. /search returns price/cost/vendor/type per product
// (variants included), so no parent fetch is required.
export function productMetaFromLs(p) {
  const vendor = vendorIdentityFromLs(p);
  const brandId = p?.brand?.id || p?.brand_id || null;
  const brandName = p?.brand?.name || p?.brand_name || "";
  const variantParentId = p?.variant_parent_id || p?.variantParentId || p?.parent_id || null;
  return {
    sku: p?.sku || "",
    name: productName(p),
    variant: productVariant(p),
    price: productPrice(p),
    cost: productCost(p),
    active: p?.active !== false && p?.is_active !== false,
    hasInventory: p?.has_inventory === true,
    deletedAt: p?.deleted_at || null,
    handle: p?.handle || "",
    createdAt: p?.created_at || p?.createdAt || null,
    updatedAt: p?.updated_at || p?.updatedAt || null,
    brandId,
    brandName,
    supplierCode: p?.supplier_code || p?.supplierCode || p?.supplier?.code || "",
    variantParentId,
    isVariant: p?.is_variant === true || !!variantParentId,
    suppId: vendor.id,
    suppName: vendor.name,
    typeId: p?.product_type_id || "__none__",
    version: Number(p?.version || 0) || null,
  };
}

function emptyMeta(shardCount) {
  return { version: null, ts: null, complete: false, buildOffset: 0, shardCount };
}

// Mirror inventory-ledger.cursorFrom: prefer the response-level max version,
// fall back to the max item version on the page.
function cursorFrom(data, items) {
  const responseVersion =
    data?.version && typeof data.version === "object" ? data.version.max : null;
  const itemVersion = (items || []).reduce(
    (max, item) => Math.max(max, Number(item?.version || 0)),
    0
  );
  return responseVersion ?? (itemVersion || null);
}

export async function loadCatalogMeta(kv) {
  return (await kv.get(CATALOG_META_KEY)) || null;
}

export async function saveCatalogMeta(kv, meta) {
  const next = { ...meta, ts: Date.now() };
  await kv.set(CATALOG_META_KEY, next, { ex: CACHE_TTL_SECONDS });
  return next;
}

// Load every shard map into an array indexed by shard number.
export async function loadShardMaps(kv, shardCount) {
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => kv.get(catalogShardKey(i)))
  );
  return shards.map((s) => s || {});
}

function newShardMaps(shardCount) {
  return Array.from({ length: shardCount }, () => ({}));
}

async function saveShards(kv, shards, touched) {
  await Promise.all(
    [...touched].map((index) =>
      kv.set(catalogShardKey(index), shards[index], { ex: CACHE_TTL_SECONDS })
    )
  );
}

// Merge every shard into a single { pid: meta } map for bucketing.
export async function loadCatalogProducts(kv, shardCount = DEFAULT_SHARD_COUNT) {
  const shards = await loadShardMaps(kv, shardCount);
  const products = {};
  for (const shard of shards) Object.assign(products, shard);
  return products;
}

// Lightweight { pid: price } map for callers (e.g. the sales store) that only
// need the retail price fallback, without holding the full meta objects.
export async function loadCatalogPriceMap(kv, shardCount = DEFAULT_SHARD_COUNT) {
  const meta = await loadCatalogMeta(kv);
  const effectiveShardCount = meta?.shardCount || shardCount;
  const shards = await loadShardMaps(kv, effectiveShardCount);
  const prices = {};
  for (const shard of shards) {
    for (const [pid, m] of Object.entries(shard)) {
      if (m && m.price) prices[pid] = m.price;
    }
  }
  return prices;
}

// One-time baseline so the first incremental top-up has a real cursor. Used only
// when /search product objects carry no per-item version.
async function probeMaxVersion(lsFetch) {
  const data = await lsFetch("2.0/products?page_size=1&sort_direction=desc");
  const items = data?.data || [];
  return cursorFrom(data, items);
}

async function coldBuild(kv, lsFetch, { meta, shards, shardCount, deadline }) {
  const startOffset = meta.buildOffset || 0;
  let maxVersion = meta.version || null;
  let added = 0;
  let durableOffset = startOffset;

  // Persist progress after every fully fetched page so a function timeout or an
  // aborted page (rate-limit retries exhausted) never discards a chunk's work.
  // The catalog is ~110k products and /search runs ~15s/page in production, so a
  // single 60s function cannot page it all — durable per-page progress is what
  // lets the cold build converge across many cron calls instead of restarting
  // from offset 0 every time and never completing.
  async function checkpoint(nextOffset, touched) {
    if (touched.size) await saveShards(kv, shards, touched);
    await saveCatalogMeta(kv, {
      version: maxVersion,
      complete: false,
      buildOffset: nextOffset,
      shardCount,
    });
    durableOffset = nextOffset;
  }

  let result = null;
  try {
    result = await searchPages({
      lsFetch,
      type: "products",
      pageSize: SEARCH_PAGE_SIZE,
      startOffset,
      deadline,
      minRemainingMs: COLD_BUILD_PAGE_BUDGET_MS,
      retries: COLD_BUILD_RETRIES,
      onPage: async (items, { offset }) => {
        const touched = new Set();
        for (const p of items) {
          if (!p || !p.id) continue;
          const index = shardForPid(p.id, shardCount);
          shards[index][p.id] = productMetaFromLs(p);
          touched.add(index);
          added++;
          const v = Number(p.version || 0);
          if (v && (maxVersion == null || v > maxVersion)) maxVersion = v;
        }
        if (items.length >= SEARCH_PAGE_SIZE) {
          // Full page: advance the durable cursor to the next page start.
          await checkpoint(offset + SEARCH_PAGE_SIZE, touched);
        } else if (touched.size) {
          // Final (short) page: persist its products; meta is finalized below.
          await saveShards(kv, shards, touched);
        }
      },
    });
  } catch (e) {
    // A page failed mid-chunk (e.g. LS rate-limit retries exhausted). Everything
    // through the last checkpoint is already durable; report incomplete so the
    // next call resumes from durableOffset rather than restarting the build.
    console.warn(`[catalog] cold build interrupted at offset ${durableOffset}: ${e.message}`);
    const partial = await saveCatalogMeta(kv, {
      version: maxVersion,
      complete: false,
      buildOffset: durableOffset,
      shardCount,
    });
    return { complete: false, done: false, version: partial.version, added, pages: 0 };
  }

  const complete = result.done;
  let version = maxVersion;
  // Seed the cursor from the collection endpoint when /search omits versions.
  if (complete && version == null) {
    version = await probeMaxVersion(lsFetch);
  }

  const nextMeta = await saveCatalogMeta(kv, {
    version,
    complete,
    buildOffset: complete ? 0 : result.offset,
    shardCount,
  });

  return { complete, done: complete, version: nextMeta.version, added, pages: result.pages };
}

async function incremental(kv, lsFetch, { meta, shards, shardCount, deadline }) {
  let cursor = meta.version || null;
  let added = 0;
  let pages = 0;
  let done = false;
  const touched = new Set();

  while (Date.now() < deadline) {
    const path =
      `2.0/products?page_size=${INCREMENTAL_PAGE_SIZE}&sort_direction=asc` +
      (cursor ? `&after=${encodeURIComponent(cursor)}` : "");
    const data = await lsFetch(path);
    const items = data?.data || [];
    pages++;

    for (const p of items) {
      if (!p || !p.id) continue;
      const index = shardForPid(p.id, shardCount);
      shards[index][p.id] = productMetaFromLs(p);
      touched.add(index);
      added++;
    }

    const nextCursor = cursorFrom(data, items);
    if (!nextCursor || nextCursor === cursor) {
      done = true;
      break;
    }
    cursor = nextCursor;
    if (items.length < INCREMENTAL_PAGE_SIZE) {
      done = true;
      break;
    }
  }

  await saveShards(kv, shards, touched);
  const nextMeta = await saveCatalogMeta(kv, {
    version: cursor,
    complete: true,
    buildOffset: 0,
    shardCount,
  });

  return { complete: true, done, version: nextMeta.version, added, pages };
}

// Advance the store-wide catalog cache by one deadline-bounded chunk.
//   - Cold build (meta missing or reset): page the whole catalog via /search,
//     resumable across calls via buildOffset, capturing the max version.
//   - Incremental (the normal path): forward-stream 2.0/products?after=<version>
//     and upsert only changed products. The full catalog is never re-paged.
export async function syncCatalogCache(
  kv,
  lsFetch,
  { reset = false, deadline = Infinity, shardCount = DEFAULT_SHARD_COUNT } = {}
) {
  const existing = reset ? null : await loadCatalogMeta(kv);
  const effectiveShardCount = existing?.shardCount || shardCount;
  const meta = existing || emptyMeta(effectiveShardCount);
  const shards =
    reset || !existing
      ? newShardMaps(effectiveShardCount)
      : await loadShardMaps(kv, effectiveShardCount);

  if (!meta.complete) {
    return coldBuild(kv, lsFetch, { meta, shards, shardCount: effectiveShardCount, deadline });
  }
  return incremental(kv, lsFetch, { meta, shards, shardCount: effectiveShardCount, deadline });
}

function emptyBucket() {
  return {
    seasonPids: [],
    skuToPid: {},
    pidToSku: {},
    pidToName: {},
    pidToVariant: {},
    pidToPrice: {},
    pidToCost: {},
    pidToSupplier: {},
    pidToType: {},
  };
}

const SEASON_BUCKET_PID_FIELDS = [
  "pidToSku",
  "pidToName",
  "pidToVariant",
  "pidToPrice",
  "pidToCost",
  "pidToSupplier",
  "pidToType",
];

export async function loadSeasonBucket(kv, season) {
  return getShardedObjectByPid(kv, seasonBucketKey(season));
}

export async function saveSeasonBucket(kv, season, bucket) {
  return setShardedObjectByPid(kv, seasonBucketKey(season), bucket, {
    ex: CACHE_TTL_SECONDS,
    pidFields: SEASON_BUCKET_PID_FIELDS,
    skuToPidFields: ["skuToPid"],
  });
}

// Pure: derive each active season's scan:pids-shaped maps from the merged
// catalog map. A product matching multiple active seasons lands in each; pids
// are deduplicated per season.
export function seasonBucketsFromCatalog(products, activeSeasons) {
  const buckets = {};
  for (const season of activeSeasons) buckets[season] = emptyBucket();

  for (const [pid, meta] of Object.entries(products || {})) {
    if (!meta) continue;
    const sku = meta.sku || "";
    const skuKey = sku.toLowerCase().trim();
    for (const season of activeSeasons) {
      if (!skuMatchesSeason(sku, season)) continue;
      const b = buckets[season];
      if (!b.pidToSku[pid]) b.seasonPids.push(pid);
      b.pidToSku[pid] = sku;
      b.pidToName[pid] = meta.name || "";
      b.pidToVariant[pid] = meta.variant || "";
      b.pidToPrice[pid] = meta.price || 0;
      b.pidToCost[pid] = meta.cost || 0;
      b.pidToSupplier[pid] = { i: meta.suppId || "__none__", n: meta.suppName || "Unknown" };
      b.pidToType[pid] = meta.typeId || "__none__";
      if (skuKey) b.skuToPid[skuKey] = pid;
    }
  }

  return buckets;
}

// Load + merge all shards, bucket by season, and persist a small per-season blob
// so each season seeds from one key instead of loading every shard.
export async function writeSeasonBuckets(kv, seasons, { shardCount = DEFAULT_SHARD_COUNT } = {}) {
  const meta = await loadCatalogMeta(kv);
  const effectiveShardCount = meta?.shardCount || shardCount;
  const products = await loadCatalogProducts(kv, effectiveShardCount);
  const buckets = seasonBucketsFromCatalog(products, seasons);
  await Promise.all(seasons.map((season) => saveSeasonBucket(kv, season, buckets[season])));
  return buckets;
}
