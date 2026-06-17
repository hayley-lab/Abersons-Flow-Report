// Persistent, store-wide consignment cache (POs + vendor returns).
//
// Modeled on lib/catalog-store.js: every consignment header (SUPPLIER and
// RETURN) is paged ONCE for the whole store and its line items fetched once,
// instead of each season re-paging headers and re-fetching every PO's products.
// Each consignment's per-PID quantities are stored season-agnostically so any
// season buckets cleanly by filtering its pids (and, for RETURN, its date range).
//
// KV keys (180-day TTL, refreshed on write):
//   scan:consign:store:meta       — { versionByType, typeDone, complete, dateFrom, shardCount, ts }
//   scan:consign:store:shard:{i}  — { [consignmentId]: { id, type, version, date,
//                                     perPid: { pid: { qtyOrdered, qtyReceived, qtyReturned } } } }
//   scan:consign:season:{season}  — projected per-season qty maps + salesFloorDate
import { dateInRange, seasonScanDateRange, skuMatchesSeason } from "./flow-math";
import { buildConsignmentEntry } from "./consignment-ledger";
import { DEFAULT_SHARD_COUNT, shardForPid } from "./catalog-store";

const CACHE_TTL_SECONDS = 180 * 24 * 3600;
const HEADER_PAGE_SIZE = 200;
const LINE_ITEM_PAGE_SIZE = 200;
const TYPES = ["SUPPLIER", "RETURN"];

export const CONSIGN_META_KEY = "scan:consign:store:meta";

export function consignShardKey(index) {
  return `scan:consign:store:shard:${index}`;
}

export function consignSeasonKey(season) {
  return `scan:consign:season:${season}`;
}

// Reuse the per-season entry builder with an all-pids set so the store keeps
// every consignment line item — the per-season filter happens at projection.
const ALL_PIDS = { has: () => true };
const NOOP_ENSURE = async () => true;

function isVoidedOrDeleted(consignment) {
  const status = String(consignment?.status || "")
    .toUpperCase()
    .replace(/[\s,_-]/g, "");
  return status === "VOIDED" || status === "CANCELLED" || !!consignment?.deleted_at;
}

function cursorFrom(data, items) {
  const responseVersion =
    data?.version && typeof data.version === "object" ? data.version.max : null;
  const itemVersion = (items || []).reduce(
    (max, item) => Math.max(max, Number(item?.version || 0)),
    0
  );
  return responseVersion ?? (itemVersion || null);
}

function emptyMeta(shardCount) {
  return {
    versionByType: {},
    typeDone: {},
    complete: false,
    dateFrom: "",
    shardCount,
    ts: null,
  };
}

function newShardMaps(shardCount) {
  return Array.from({ length: shardCount }, () => ({}));
}

export async function loadConsignMeta(kv) {
  return (await kv.get(CONSIGN_META_KEY)) || null;
}

export async function saveConsignMeta(kv, meta) {
  const next = { ...meta, ts: Date.now() };
  await kv.set(CONSIGN_META_KEY, next, { ex: CACHE_TTL_SECONDS });
  return next;
}

export async function loadConsignShards(kv, shardCount) {
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => kv.get(consignShardKey(i)))
  );
  return shards.map((s) => s || {});
}

export async function loadConsignEntries(kv, shardCount = DEFAULT_SHARD_COUNT) {
  const meta = await loadConsignMeta(kv);
  const effectiveShardCount = meta?.shardCount || shardCount;
  const shards = await loadConsignShards(kv, effectiveShardCount);
  const entries = {};
  for (const shard of shards) Object.assign(entries, shard);
  return entries;
}

async function saveShards(kv, shards, touched) {
  await Promise.all(
    [...touched].map((index) =>
      kv.set(consignShardKey(index), shards[index], { ex: CACHE_TTL_SECONDS })
    )
  );
}

export async function clearConsignStore(kv, shardCount = DEFAULT_SHARD_COUNT) {
  const meta = await loadConsignMeta(kv);
  const effectiveShardCount = meta?.shardCount || shardCount;
  await Promise.all([
    kv.del(CONSIGN_META_KEY),
    ...Array.from({ length: effectiveShardCount }, (_, i) => kv.del(consignShardKey(i))),
  ]);
}

async function fetchLineItems(lsFetch, id, deadline = Infinity) {
  const results = [];
  let after = null;
  for (let p = 0; p < 200; p++) {
    const data = await lsFetch(
      `2.0/consignments/${id}/products?page_size=${LINE_ITEM_PAGE_SIZE}` +
        (after ? `&after=${encodeURIComponent(after)}` : ""),
      { deadline }
    );
    const items = data?.data || [];
    results.push(...items);
    if (items.length < LINE_ITEM_PAGE_SIZE) break;
    after = cursorFrom(data, items);
    if (!after) break;
  }
  return results;
}

// Advance the store-wide consignment cache by one deadline-bounded chunk.
// Cold build pages headers per type from `dateFrom` with a version cursor and
// fetches line items for each; incremental pages only headers after the cursor.
// Resumable across calls via meta.versionByType + meta.typeDone.
export async function syncConsignmentStore(
  kv,
  lsFetch,
  { reset = false, deadline = Infinity, dateFrom = "", shardCount = DEFAULT_SHARD_COUNT } = {}
) {
  const existing = reset ? null : await loadConsignMeta(kv);
  const effectiveShardCount = existing?.shardCount || shardCount;
  const meta = existing || emptyMeta(effectiveShardCount);
  if (reset) await clearConsignStore(kv, effectiveShardCount);
  const shards = existing
    ? await loadConsignShards(kv, effectiveShardCount)
    : newShardMaps(effectiveShardCount);

  const backfill = !meta.complete;
  if (!meta.versionByType) meta.versionByType = {};
  if (!meta.typeDone) meta.typeDone = {};
  const touched = new Set();
  let added = 0;

  async function checkpoint() {
    if (touched.size) await saveShards(kv, shards, touched);
    await saveConsignMeta(kv, {
      versionByType: meta.versionByType,
      typeDone: meta.typeDone,
      complete: TYPES.every((t) => meta.typeDone[t]),
      dateFrom: backfill ? dateFrom : meta.dateFrom || "",
      shardCount: effectiveShardCount,
    });
  }

  for (const type of TYPES) {
    if (Date.now() >= deadline) break;
    // On a cold build, skip a type already fully paged in a prior call.
    if (backfill && meta.typeDone[type]) continue;
    if (!backfill) meta.typeDone[type] = false; // re-evaluated each incremental pass

    // Two-cursor scheme (mirrors lib/catalog-store.js incremental()):
    //   requestCursor — drives the `after=` request and the drain comparison;
    //     advanced only to pageCursor after a fully-processed page.
    //   processedCursor — advanced per fully-processed header (incl. the
    //     idempotent-skip and voided branches); the checkpoint value on
    //     interrupt, so a mid-page deadline never skips the unprocessed tail.
    let requestCursor = meta.versionByType[type] || null;
    let drained = false;

    while (Date.now() < deadline) {
      const params = [`type=${encodeURIComponent(type)}`, `page_size=${HEADER_PAGE_SIZE}`];
      if (backfill && dateFrom) params.push(`date_from=${encodeURIComponent(dateFrom)}`);
      if (requestCursor) params.push(`after=${encodeURIComponent(requestCursor)}`);
      const data = await lsFetch(`2.0/consignments?${params.join("&")}`, { deadline });
      const headers = data?.data || [];

      let processedCursor = requestCursor;
      let interrupted = false;
      for (const h of headers) {
        if (Date.now() >= deadline) {
          interrupted = true;
          break;
        }
        const id = h?.id;
        if (!id) continue;
        const version = Number(h?.version || 0) || null;
        const index = shardForPid(String(id), effectiveShardCount);
        const prior = shards[index][id];

        // Idempotent: an unchanged, still-valid header needs no line-item refetch.
        if (prior && prior.version === version && !isVoidedOrDeleted(h)) {
          if (version) processedCursor = version;
          continue;
        }

        if (isVoidedOrDeleted(h)) {
          if (prior) {
            delete shards[index][id];
            touched.add(index);
          }
        } else {
          const items = await fetchLineItems(lsFetch, id, deadline);
          const entry = await buildConsignmentEntry(h, items, type, ALL_PIDS, NOOP_ENSURE);
          shards[index][id] = {
            id: entry.consignmentId,
            type,
            version,
            date: entry.date,
            perPid: entry.perPid,
          };
          touched.add(index);
          added++;
        }
        if (version) processedCursor = version;
      }

      const pageCursor = cursorFrom(data, headers);

      if (interrupted) {
        // Persist only fully-processed headers so resume re-requests from here.
        // If the deadline tripped before any header, processedCursor still equals
        // requestCursor, so the same page is re-requested (no gap).
        meta.versionByType[type] = processedCursor;
        await checkpoint();
        break;
      }

      meta.versionByType[type] = pageCursor || processedCursor;
      await checkpoint();

      if (
        !headers.length ||
        !pageCursor ||
        pageCursor === requestCursor ||
        headers.length < HEADER_PAGE_SIZE
      ) {
        drained = true;
        break;
      }
      requestCursor = pageCursor;
    }

    if (drained) meta.typeDone[type] = true;
    await checkpoint();
  }

  const complete = TYPES.every((t) => meta.typeDone[t]);
  await saveConsignMeta(kv, {
    versionByType: meta.versionByType,
    typeDone: meta.typeDone,
    complete,
    dateFrom: backfill ? dateFrom : meta.dateFrom || "",
    shardCount: effectiveShardCount,
  });

  return { complete, done: complete, added };
}

function emptyBucket() {
  return {
    pidToQtyOrdered: {},
    pidToQtyReceived: {},
    pidToQtyReturned: {},
    salesFloorDate: null,
  };
}

// Pure: project store-wide consignment entries into per-season qty maps.
//   - SUPPLIER entries count toward ordered/received when on/after the season's
//     scan-range start (mirrors the per-season date_from lower bound).
//   - RETURN entries count toward returned only when their date falls inside the
//     season's scan range (mirrors the per-season client-side date filter).
// salesFloorDate is the earliest in-window consignment date (any type), matching
// the per-season reconcile which records it for every reconciled consignment.
function addPidTotals(bucket, pid, t) {
  if (t.qtyOrdered) bucket.pidToQtyOrdered[pid] = (bucket.pidToQtyOrdered[pid] || 0) + t.qtyOrdered;
  if (t.qtyReceived)
    bucket.pidToQtyReceived[pid] = (bucket.pidToQtyReceived[pid] || 0) + t.qtyReceived;
  if (t.qtyReturned)
    bucket.pidToQtyReturned[pid] = (bucket.pidToQtyReturned[pid] || 0) + t.qtyReturned;
}

export function seasonConsignmentBuckets(
  entries,
  { seasons, seasonPidSets, scanRanges, pidToSku }
) {
  const buckets = {};
  for (const season of seasons) buckets[season] = emptyBucket();

  function pidMatchesSeason(pid, season) {
    const pidSet = seasonPidSets[season];
    if (!pidSet || !pidSet.has(pid)) return false;
    const sku = pidToSku?.[pid];
    return !sku || skuMatchesSeason(sku, season);
  }

  // For an undated consignment we cannot date-filter, so we attribute each of
  // its pids only to the UNIQUE season whose SKU set owns that pid. A pid shared
  // by more than one season's set is ambiguous and is excluded (counted), never
  // projected into every season (the bug that inflated Ordered/Received/Returned).
  function uniqueOwnerSeason(pid) {
    let owner = null;
    for (const season of seasons) {
      if (pidMatchesSeason(pid, season)) {
        if (owner) return undefined; // ambiguous: belongs to >1 season
        owner = season;
      }
    }
    return owner; // null when no active season owns the pid
  }

  let excludedUndatedPids = 0;

  for (const entry of Object.values(entries || {})) {
    if (!entry) continue;

    if (!entry.date) {
      for (const [pid, t] of Object.entries(entry.perPid || {})) {
        const owner = uniqueOwnerSeason(pid);
        if (owner === undefined) {
          excludedUndatedPids++; // shared across seasons — drop, don't inflate
          continue;
        }
        if (!owner) continue; // no active season owns this pid
        addPidTotals(buckets[owner], pid, t);
      }
      continue;
    }

    const isReturn = entry.type === "RETURN" || entry.type === "SUPPLIER_RETURN";
    for (const season of seasons) {
      const range = scanRanges[season] || {};
      if (!seasonPidSets[season]) continue;

      if (isReturn) {
        if (!dateInRange(entry.date, range)) continue;
      } else if (range.start && entry.date < range.start) {
        continue;
      }

      const b = buckets[season];
      if (!b.salesFloorDate || entry.date < b.salesFloorDate) {
        b.salesFloorDate = entry.date;
      }

      for (const [pid, t] of Object.entries(entry.perPid || {})) {
        if (!pidMatchesSeason(pid, season)) continue;
        addPidTotals(b, pid, t);
      }
    }
  }

  if (excludedUndatedPids > 0) {
    console.warn(
      `[consignment-store] excluded ${excludedUndatedPids} undated consignment pid(s) with ambiguous season membership`
    );
  }

  return buckets;
}

// Flatten a season bucket into a per-pid overlay { pid: { qtyOrdered,
// qtyReceived, qtyReturned } } — the shape the request-time rollup overlays on
// top of the baked scan:data values (see lib/flow-rollup.buildAllRows).
export function consignByPidFromBucket(bucket) {
  const overlay = {};
  const pids = new Set([
    ...Object.keys(bucket?.pidToQtyOrdered || {}),
    ...Object.keys(bucket?.pidToQtyReceived || {}),
    ...Object.keys(bucket?.pidToQtyReturned || {}),
  ]);
  for (const pid of pids) {
    overlay[pid] = {
      qtyOrdered: bucket?.pidToQtyOrdered?.[pid] || 0,
      qtyReceived: bucket?.pidToQtyReceived?.[pid] || 0,
      qtyReturned: bucket?.pidToQtyReturned?.[pid] || 0,
    };
  }
  return overlay;
}

// Request-time consignment overlay: load the store-wide entries and re-project
// THIS season's ordered/received/returned per pid, gated by the season's pid set
// + SKU + scan date range. Used by the read path (data.js) and the validation
// harness so the report's Ordered/Received/Returned always reflect the live LS
// consignment store, never a stale baked scan:data value (the per-season bucket
// the scan bakes can lag newly-entered, future-dated POs). Returns {} on any
// read/projection failure so the caller transparently falls back to scan:data.
export async function loadSeasonConsignOverlay(
  kv,
  season,
  { seasonPids = [], pidToSku = {}, shardCount = DEFAULT_SHARD_COUNT } = {}
) {
  const entries = await loadConsignEntries(kv, shardCount);
  const buckets = seasonConsignmentBuckets(entries, {
    seasons: [season],
    seasonPidSets: { [season]: new Set((seasonPids || []).map(String)) },
    scanRanges: { [season]: seasonScanDateRange(season) },
    pidToSku: pidToSku || {},
  });
  return consignByPidFromBucket(buckets[season]);
}

// Load + merge shards, project per season, and persist each season's bucket so a
// scan reads its consignment totals from one key with zero LS calls.
export async function writeSeasonConsignBuckets(
  kv,
  seasons,
  { seasonPidSets, scanRanges, pidToSku, shardCount = DEFAULT_SHARD_COUNT } = {}
) {
  const entries = await loadConsignEntries(kv, shardCount);
  const buckets = seasonConsignmentBuckets(entries, {
    seasons,
    seasonPidSets,
    scanRanges,
    pidToSku,
  });
  await Promise.all(
    seasons.map((season) =>
      kv.set(consignSeasonKey(season), buckets[season], { ex: CACHE_TTL_SECONDS })
    )
  );
  return buckets;
}
