import { addContribution, saleContribution } from "./flow-math";

function ledgerKey(season) {
  return `scan:sales:ledger:${season}`;
}

function stateKey(season) {
  return `scan:sales:state:${season}`;
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

function isVoidedOrDeleted(sale) {
  const status = String(sale?.status || "")
    .toUpperCase()
    .replace(/[\s,_-]/g, "");
  return status === "VOIDED" || !!sale?.deleted_at;
}

function saleIdOf(sale) {
  return sale?.id || sale?.sale_id || sale?.invoice_number || null;
}

function bumpVersion(state, version) {
  if (version && (!state.maxVersion || version > state.maxVersion)) state.maxVersion = version;
}

export async function loadSalesState(kv, season) {
  const state = await kv.get(stateKey(season));
  return state || { maxVersion: null, perPid: {}, pidSet: [] };
}

export async function saveSalesState(kv, season, state, pidSet) {
  const next = {
    maxVersion: state?.maxVersion || null,
    perPid: state?.perPid || {},
    pidSet: Array.from(pidSet || []),
    ts: Date.now(),
  };
  await kv.set(stateKey(season), next, { ex: 180 * 24 * 3600 });
  return next;
}

// Delete the entire ledger hash. Call once at the start of a backfill so the
// rebuilt ledger never carries stale entries from a previous product universe.
export async function clearLedger(kv, season) {
  await kv.del(ledgerKey(season));
}

// Backfill path — rebuilds the ledger from scratch with NO per-sale reads.
//
// Used when there is no prior ledger OR the season's product set expanded (a
// newly-registered product may have sold before the prior maxVersion, so its
// history must be re-attributed against the current seasonPidSet). The caller
// is responsible for resetting state.perPid = {} and calling clearLedger once
// before the first page. Each call processes one page of sales and flushes its
// ledger entries with a single batched hset, keeping KV I/O to ~1 round-trip
// per page instead of two per sale.
export async function backfillSales(kv, season, state, sales, seasonPidSet, pidToPrice = {}) {
  const writes = {};
  for (const sale of sales || []) {
    const saleId = saleIdOf(sale);
    bumpVersion(state, sale?.version || 0);
    if (!saleId || isVoidedOrDeleted(sale)) continue;

    const contribution = saleContribution(sale, seasonPidSet, pidToPrice);
    if (!hasContribution(contribution)) continue;
    contribution.saleId = saleId;
    contribution.version = sale?.version || 0;
    addContribution(state.perPid, contribution, 1);
    writes[String(saleId)] = contribution;
  }
  if (Object.keys(writes).length) await kv.hset(ledgerKey(season), writes);
  return state;
}

export async function rebuildSalesState(kv, season) {
  const entries = (await kv.hgetall(ledgerKey(season))) || {};
  const rebuilt = { maxVersion: null, perPid: {}, pidSet: [] };
  for (const raw of Object.values(entries)) {
    const entry = parseEntry(raw);
    if (!entry) continue;
    addContribution(rebuilt.perPid, entry, 1);
    if (entry.version && (!rebuilt.maxVersion || entry.version > rebuilt.maxVersion))
      rebuilt.maxVersion = entry.version;
  }
  await saveSalesState(kv, season, rebuilt, rebuilt.pidSet);
  return rebuilt;
}

export async function reconcileSale(kv, season, state, sale, seasonPidSet, pidToPrice = {}) {
  const saleId = sale?.id || sale?.sale_id || sale?.invoice_number;
  if (!saleId) return { changed: false, version: sale?.version || null };

  const key = ledgerKey(season);
  const oldEntry = parseEntry(await kv.hget(key, String(saleId)));
  const version = sale?.version || 0;

  if (oldEntry && oldEntry.version === version) {
    return { changed: false, version };
  }

  if (oldEntry) {
    addContribution(state.perPid, oldEntry, -1);
  }

  if (isVoidedOrDeleted(sale)) {
    if (oldEntry) await kv.hdel(key, String(saleId));
    if (version && (!state.maxVersion || version > state.maxVersion)) state.maxVersion = version;
    return { changed: !!oldEntry, version };
  }

  const contribution = saleContribution(sale, seasonPidSet, pidToPrice);
  contribution.saleId = saleId;
  contribution.version = version;

  if (!hasContribution(contribution)) {
    if (oldEntry) await kv.hdel(key, String(saleId));
    if (version && (!state.maxVersion || version > state.maxVersion)) state.maxVersion = version;
    return { changed: !!oldEntry, version };
  }

  addContribution(state.perPid, contribution, 1);
  await kv.hset(key, { [String(saleId)]: contribution });
  if (version && (!state.maxVersion || version > state.maxVersion)) state.maxVersion = version;
  return { changed: true, version };
}
