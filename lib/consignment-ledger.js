import { consignmentDate } from "./flow-math";

const CACHE_TTL_SECONDS = 180 * 24 * 3600;

function ledgerKey(season) {
  return `scan:consign:ledger:${season}`;
}

function stateKey(season) {
  return `scan:consign:state:${season}`;
}

function emptyState() {
  return {
    maxVersionByType: {},
    perPid: {},
    pidSet: [],
    salesFloorDate: null,
    ts: null,
  };
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

function isVoidedOrDeleted(consignment) {
  const status = String(consignment?.status || "")
    .toUpperCase()
    .replace(/[\s,_-]/g, "");
  return status === "VOIDED" || status === "CANCELLED" || !!consignment?.deleted_at;
}

function consignmentIdOf(consignment) {
  return consignment?.id || consignment?.consignment_id || null;
}

function bumpVersion(state, type, version) {
  if (!version) return;
  if (!state.maxVersionByType) state.maxVersionByType = {};
  if (!state.maxVersionByType[type] || version > state.maxVersionByType[type]) {
    state.maxVersionByType[type] = version;
  }
}

function addQty(target, field, value) {
  const amount = Number(value || 0);
  if (!amount) return;
  target[field] = (target[field] || 0) + amount;
}

function normalizeTotals(totals) {
  return {
    qtyOrdered: totals.qtyOrdered || 0,
    qtyReceived: totals.qtyReceived || 0,
    qtyReturned: totals.qtyReturned || 0,
  };
}

export function addConsignmentEntryTotals(perPid, entry, sign = 1) {
  for (const [pid, totals] of Object.entries(entry?.perPid || {})) {
    if (!perPid[pid]) perPid[pid] = { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 0 };
    addQty(perPid[pid], "qtyOrdered", sign * (totals.qtyOrdered || 0));
    addQty(perPid[pid], "qtyReceived", sign * (totals.qtyReceived || 0));
    addQty(perPid[pid], "qtyReturned", sign * (totals.qtyReturned || 0));

    if (!perPid[pid].qtyOrdered && !perPid[pid].qtyReceived && !perPid[pid].qtyReturned) {
      delete perPid[pid];
    }
  }
}

export async function buildConsignmentEntry(
  consignment,
  items,
  type,
  seasonPidSet,
  ensureSeasonProduct
) {
  const perPid = {};
  for (const item of items || []) {
    const pid = item?.product_id;
    if (!pid) continue;

    if (!seasonPidSet.has(pid)) {
      const registered = await ensureSeasonProduct(pid);
      if (!registered) continue;
      seasonPidSet.add(pid);
    }

    if (type === "RETURN" || type === "SUPPLIER_RETURN") {
      const qtyReturned = Math.abs(Number(item.count || 0));
      if (!perPid[pid]) perPid[pid] = { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 0 };
      addQty(perPid[pid], "qtyReturned", qtyReturned);
    } else {
      const qtyOrdered = Math.max(0, Number(item.count || 0));
      if (!qtyOrdered && Number(item.count || 0) < 0) continue;
      if (!perPid[pid]) perPid[pid] = { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 0 };
      addQty(perPid[pid], "qtyOrdered", qtyOrdered);
      addQty(perPid[pid], "qtyReceived", Math.max(0, Number(item.received || 0)));
    }
  }

  const version = Number(consignment?.version || 0) || null;
  return {
    consignmentId: consignmentIdOf(consignment),
    type,
    version,
    date: consignmentDate(consignment),
    perPid: Object.fromEntries(
      Object.entries(perPid).map(([pid, totals]) => [pid, normalizeTotals(totals)])
    ),
  };
}

export async function loadConsignmentState(kv, season) {
  const state = await kv.get(stateKey(season));
  return state || emptyState();
}

export async function saveConsignmentState(kv, season, state, pidSet) {
  const next = {
    ...emptyState(),
    ...(state || {}),
    pidSet: Array.from(pidSet || []),
    ts: Date.now(),
  };
  await kv.set(stateKey(season), next, { ex: CACHE_TTL_SECONDS });
  return next;
}

export async function clearConsignmentLedger(kv, season) {
  await Promise.all([kv.del(ledgerKey(season)), kv.del(stateKey(season))]);
}

export async function reconcileConsignment(
  kv,
  season,
  state,
  consignment,
  items,
  type,
  seasonPidSet,
  ensureSeasonProduct
) {
  const id = consignmentIdOf(consignment);
  if (!id) return { changed: false, version: null };

  if (!state.maxVersionByType) state.maxVersionByType = {};
  if (!state.perPid) state.perPid = {};

  const key = ledgerKey(season);
  const oldEntry = parseEntry(await kv.hget(key, String(id)));
  const version = Number(consignment?.version || 0) || null;

  if (
    oldEntry &&
    oldEntry.version === version &&
    (state.maxVersionByType[type] || 0) >= (version || 0)
  ) {
    return { changed: false, version };
  }

  if (oldEntry) addConsignmentEntryTotals(state.perPid, oldEntry, -1);

  if (isVoidedOrDeleted(consignment)) {
    if (oldEntry) await kv.hdel(key, String(id));
    bumpVersion(state, type, version);
    return { changed: !!oldEntry, version };
  }

  const entry = await buildConsignmentEntry(
    consignment,
    items,
    type,
    seasonPidSet,
    ensureSeasonProduct
  );

  addConsignmentEntryTotals(state.perPid, entry, 1);
  if (entry.date && (!state.salesFloorDate || entry.date < state.salesFloorDate)) {
    state.salesFloorDate = entry.date;
  }
  await kv.hset(key, { [String(id)]: entry });
  bumpVersion(state, type, version);
  return { changed: true, version };
}

export function applyConsignmentTotalsToMaps(state, totals) {
  state.pidToQtyOrdered = {};
  state.pidToQtyReceived = {};
  state.pidToQtyReturned = {};

  for (const [pid, qty] of Object.entries(totals?.perPid || {})) {
    if (qty.qtyOrdered) state.pidToQtyOrdered[pid] = qty.qtyOrdered;
    if (qty.qtyReceived) state.pidToQtyReceived[pid] = qty.qtyReceived;
    if (qty.qtyReturned) state.pidToQtyReturned[pid] = qty.qtyReturned;
  }

  if (totals?.salesFloorDate) state.salesFloorDate = totals.salesFloorDate;
}
