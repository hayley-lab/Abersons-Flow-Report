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
import { dateInRange } from "./flow-math";
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

async function fetchLineItems(lsFetch, id) {
  const results = [];
  let after = null;
  for (let p = 0; p < 200; p++) {
    const data = await lsFetch(
      `2.0/consignments/${id}/products?page_size=${LINE_ITEM_PAGE_SIZE}` +
        (after ? `&after=${encodeURIComponent(after)}` : "")
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

    let cursor = meta.versionByType[type] || null;
    let drained = false;

    while (Date.now() < deadline) {
      const params = [`type=${encodeURIComponent(type)}`, `page_size=${HEADER_PAGE_SIZE}`];
      if (backfill && dateFrom) params.push(`date_from=${encodeURIComponent(dateFrom)}`);
      if (cursor) params.push(`after=${encodeURIComponent(cursor)}`);
      const data = await lsFetch(`2.0/consignments?${params.join("&")}`);
      const headers = data?.data || [];

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
          if (version) cursor = version;
          continue;
        }

        if (isVoidedOrDeleted(h)) {
          if (prior) {
            delete shards[index][id];
            touched.add(index);
          }
        } else {
          const items = await fetchLineItems(lsFetch, id);
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
        if (version) cursor = version;
      }

      const pageCursor = cursorFrom(data, headers);
      // Persist the cursor reached so far so a resume picks up here.
      if (pageCursor) meta.versionByType[type] = pageCursor;
      else if (cursor) meta.versionByType[type] = cursor;
      await checkpoint();

      if (interrupted) break;
      if (!headers.length || !pageCursor || pageCursor === cursor) {
        drained = true;
        break;
      }
      if (headers.length < HEADER_PAGE_SIZE) {
        drained = true;
        break;
      }
      cursor = pageCursor;
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
export function seasonConsignmentBuckets(entries, { seasons, seasonPidSets, scanRanges }) {
  const buckets = {};
  for (const season of seasons) buckets[season] = emptyBucket();

  for (const entry of Object.values(entries || {})) {
    if (!entry) continue;
    const isReturn = entry.type === "RETURN" || entry.type === "SUPPLIER_RETURN";

    for (const season of seasons) {
      const range = scanRanges[season] || {};
      const pidSet = seasonPidSets[season];
      if (!pidSet) continue;

      if (isReturn) {
        if (entry.date && !dateInRange(entry.date, range)) continue;
      } else if (entry.date && range.start && entry.date < range.start) {
        continue;
      }

      const b = buckets[season];
      if (entry.date && (!b.salesFloorDate || entry.date < b.salesFloorDate)) {
        b.salesFloorDate = entry.date;
      }

      for (const [pid, t] of Object.entries(entry.perPid || {})) {
        if (!pidSet.has(pid)) continue;
        if (t.qtyOrdered) b.pidToQtyOrdered[pid] = (b.pidToQtyOrdered[pid] || 0) + t.qtyOrdered;
        if (t.qtyReceived) b.pidToQtyReceived[pid] = (b.pidToQtyReceived[pid] || 0) + t.qtyReceived;
        if (t.qtyReturned) b.pidToQtyReturned[pid] = (b.pidToQtyReturned[pid] || 0) + t.qtyReturned;
      }
    }
  }

  return buckets;
}

// Load + merge shards, project per season, and persist each season's bucket so a
// scan reads its consignment totals from one key with zero LS calls.
export async function writeSeasonConsignBuckets(
  kv,
  seasons,
  { seasonPidSets, scanRanges, shardCount = DEFAULT_SHARD_COUNT } = {}
) {
  const entries = await loadConsignEntries(kv, shardCount);
  const buckets = seasonConsignmentBuckets(entries, { seasons, seasonPidSets, scanRanges });
  await Promise.all(
    seasons.map((season) =>
      kv.set(consignSeasonKey(season), buckets[season], { ex: CACHE_TTL_SECONDS })
    )
  );
  return buckets;
}
