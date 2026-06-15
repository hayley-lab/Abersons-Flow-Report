// Persistent, store-wide sales aggregate.
//
// Modeled on lib/inventory-ledger.js + lib/catalog-store.js: every sale across
// the whole store is paged ONCE and kept current by a version cursor, instead of
// each season paging the full 2.0/sales history independently. Because sale
// attribution is already PID-level (saleContribution in lib/flow-math.js), a
// store-wide per-PID aggregate buckets cleanly to any season by filtering its
// pids — no per-season LS paging.
//
// Two structures back the cache:
//   scan:sales:store:ledger        — KV hash { saleId: { perPid, version } }.
//                                    Per-sale entries enable idempotent
//                                    incremental reconcile (subtract the old
//                                    contribution, add the new). Read/written
//                                    one field at a time (hget/hset/hdel), never
//                                    loaded whole on the incremental path.
//   scan:sales:store:agg:{0..N}    — sharded { pid: { sold, onSale, saleAmt,
//                                    soldAmt, returned } }. The running per-PID
//                                    aggregate, sharded by a stable hash of pid.
//   scan:sales:store:meta          — { version, ts, complete, dateFrom, shardCount }.
//
// The cold build pages from the global earliest date_from (min across active
// seasons) with a version cursor and is resumable across calls. The incremental
// top-up pages only sales after the cursor (no date_from, so an edited old sale
// is still captured by its new version).
import { returnForId, saleContribution } from "./flow-math";
import { fetchSalesPages, SALES_PAGE_SIZE } from "./ls-sales-pagination";
import { DEFAULT_SHARD_COUNT, shardForPid } from "./catalog-store";

const CACHE_TTL_SECONDS = 180 * 24 * 3600;

export const SALES_STORE_META_KEY = "scan:sales:store:meta";
export const SALES_STORE_LEDGER_KEY = "scan:sales:store:ledger";

export function salesAggShardKey(index) {
  return `scan:sales:store:agg:${index}`;
}

// Matches every product id — the store aggregate is season-agnostic, so
// saleContribution must consider every line item rather than a season subset.
const ALL_PIDS = { has: () => true };

function isVoidedOrDeleted(sale) {
  const status = String(sale?.status || "")
    .toUpperCase()
    .replace(/[\s,_-]/g, "");
  return status === "VOIDED" || !!sale?.deleted_at;
}

function saleIdOf(sale) {
  return sale?.id || sale?.sale_id || sale?.invoice_number || null;
}

function parseEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") {
    try {
      return JSON.parse(entry);
    } catch {
      return null;
    }
  }
  return entry;
}

function hasContribution(contribution) {
  return Object.keys(contribution?.perPid || {}).length > 0;
}

// Resolve a customer return's original-sale per-pid buckets (via return_for) so
// saleContribution buckets the return into the column it sold from. Checks the
// in-flight page map first, then the persisted store ledger. Only return sales
// ever read KV; everything else short-circuits to null (heuristic fallback).
async function originalPerPidFor(kv, ledgerKey, sale, pageById) {
  const origId = returnForId(sale);
  if (!origId) return null;
  const idStr = String(origId);
  const local = pageById && pageById[idStr];
  if (local && local.perPid) return local.perPid;
  const orig = parseEntry(await kv.hget(ledgerKey, idStr));
  return orig?.perPid || null;
}

function emptyMeta(shardCount) {
  return { version: null, ts: null, complete: false, dateFrom: "", shardCount };
}

function newAggShards(shardCount) {
  return Array.from({ length: shardCount }, () => ({}));
}

export async function loadSalesStoreMeta(kv) {
  return (await kv.get(SALES_STORE_META_KEY)) || null;
}

export async function saveSalesStoreMeta(kv, meta) {
  const next = { ...meta, ts: Date.now() };
  await kv.set(SALES_STORE_META_KEY, next, { ex: CACHE_TTL_SECONDS });
  return next;
}

export async function loadSalesAggShards(kv, shardCount) {
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => kv.get(salesAggShardKey(i)))
  );
  return shards.map((s) => s || {});
}

// Merge every shard into one { pid: totals } map for season projection.
export async function loadSalesAgg(kv, shardCount = DEFAULT_SHARD_COUNT) {
  const meta = await loadSalesStoreMeta(kv);
  const effectiveShardCount = meta?.shardCount || shardCount;
  const shards = await loadSalesAggShards(kv, effectiveShardCount);
  const agg = {};
  for (const shard of shards) Object.assign(agg, shard);
  return agg;
}

async function saveAggShards(kv, shards, touched) {
  await Promise.all(
    [...touched].map((index) =>
      kv.set(salesAggShardKey(index), shards[index], { ex: CACHE_TTL_SECONDS })
    )
  );
}

export async function clearSalesStore(kv, shardCount = DEFAULT_SHARD_COUNT) {
  const meta = await loadSalesStoreMeta(kv);
  const effectiveShardCount = meta?.shardCount || shardCount;
  await Promise.all([
    kv.del(SALES_STORE_META_KEY),
    kv.del(SALES_STORE_LEDGER_KEY),
    ...Array.from({ length: effectiveShardCount }, (_, i) => kv.del(salesAggShardKey(i))),
  ]);
}

// Add a single sale's contribution into the sharded aggregate (routing each pid
// to its shard), recording which shards were touched so only those are saved.
function applyContributionToAggShards(shards, contribution, sign, shardCount, touched) {
  for (const [pid, c] of Object.entries(contribution?.perPid || {})) {
    const index = shardForPid(pid, shardCount);
    const shard = shards[index];
    if (!shard[pid]) shard[pid] = { sold: 0, onSale: 0, saleAmt: 0, soldAmt: 0, returned: 0 };
    const t = shard[pid];
    t.sold += sign * (c.sold || 0);
    t.onSale += sign * (c.onSale || 0);
    t.saleAmt += sign * (c.saleAmt || 0);
    t.soldAmt += sign * (c.soldAmt || 0);
    t.returned += sign * (c.returned || 0);
    touched.add(index);
  }
}

// Filter the store-wide aggregate down to one season's pids. Returns the same
// { pid: totals } shape applySalesTotals already consumes.
export function projectSeasonSales(agg, seasonPids) {
  const perPid = {};
  for (const pid of seasonPids || []) {
    if (agg && agg[pid]) perPid[pid] = agg[pid];
  }
  return perPid;
}

// Advance the store-wide sales cache by one deadline-bounded chunk.
//   - Cold build (meta missing/incomplete): page 2.0/sales from `dateFrom` with a
//     version cursor, resumable across calls. Builds the ledger + aggregate from
//     scratch (no per-sale reads — one hset per sale).
//   - Incremental (meta complete): page only sales after the cursor (no
//     date_from) and reconcile each (subtract old entry, add new) idempotently.
export async function syncSalesStore(
  kv,
  lsFetch,
  { reset = false, deadline = Infinity, dateFrom = "", priceMap = {}, shardCount = DEFAULT_SHARD_COUNT } = {}
) {
  const existing = reset ? null : await loadSalesStoreMeta(kv);
  const effectiveShardCount = existing?.shardCount || shardCount;
  const meta = existing || emptyMeta(effectiveShardCount);
  if (reset) await clearSalesStore(kv, effectiveShardCount);

  const shards = existing ? await loadSalesAggShards(kv, effectiveShardCount) : newAggShards(effectiveShardCount);
  const ledgerKey = SALES_STORE_LEDGER_KEY;
  const backfillMode = !meta.complete;
  let maxVersion = meta.version || null;
  const touched = new Set();

  function bump(version) {
    const v = Number(version || 0);
    if (v && (maxVersion == null || v > maxVersion)) maxVersion = v;
  }

  async function checkpoint(complete) {
    if (touched.size) await saveAggShards(kv, shards, touched);
    await saveSalesStoreMeta(kv, {
      version: maxVersion,
      complete,
      dateFrom: backfillMode ? dateFrom : meta.dateFrom || "",
      shardCount: effectiveShardCount,
    });
  }

  const result = await fetchSalesPages({
    lsFetch,
    deadline,
    initialCursor: maxVersion,
    dateFrom: backfillMode ? dateFrom : "",
    pageSize: SALES_PAGE_SIZE,
    onPage: async (saleItems) => {
      const writes = {};
      for (const sale of saleItems || []) {
        const saleId = saleIdOf(sale);
        bump(sale?.version || 0);
        if (!saleId) continue;

        if (backfillMode) {
          // Cold build: the ledger starts empty for this build, so a clean
          // upsert (no read) is correct and idempotent across resumes — already
          // processed sales fall below the resume cursor and are never refetched.
          if (isVoidedOrDeleted(sale)) continue;
          const originalPerPid = await originalPerPidFor(kv, ledgerKey, sale, writes);
          const contribution = saleContribution(sale, ALL_PIDS, priceMap, { originalPerPid });
          if (!hasContribution(contribution)) continue;
          const entry = { perPid: contribution.perPid, version: sale?.version || 0 };
          writes[String(saleId)] = entry;
          applyContributionToAggShards(shards, entry, 1, effectiveShardCount, touched);
        } else {
          // Incremental: reconcile against the existing ledger entry.
          const version = sale?.version || 0;
          const oldEntry = parseEntry(await kv.hget(ledgerKey, String(saleId)));
          if (oldEntry && oldEntry.version === version) continue;
          if (oldEntry) applyContributionToAggShards(shards, oldEntry, -1, effectiveShardCount, touched);

          if (isVoidedOrDeleted(sale)) {
            if (oldEntry) await kv.hdel(ledgerKey, String(saleId));
            continue;
          }
          const originalPerPid = await originalPerPidFor(kv, ledgerKey, sale, null);
          const contribution = saleContribution(sale, ALL_PIDS, priceMap, { originalPerPid });
          if (!hasContribution(contribution)) {
            if (oldEntry) await kv.hdel(ledgerKey, String(saleId));
            continue;
          }
          const entry = { perPid: contribution.perPid, version };
          await kv.hset(ledgerKey, { [String(saleId)]: entry });
          applyContributionToAggShards(shards, entry, 1, effectiveShardCount, touched);
        }
      }
      if (Object.keys(writes).length) await kv.hset(ledgerKey, writes);
      // Persist per-page progress so a function timeout never discards a chunk.
      await checkpoint(false);
    },
  });

  await checkpoint(result.done);
  return { complete: result.done, done: result.done, version: maxVersion, pages: result.pages };
}
