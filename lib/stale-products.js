// Shared stale-product retirement rules used by the local script and the nightly worker.

export function isConsignmentSku(sku) {
  return String(sku || "")
    .trim()
    .toLowerCase()
    .startsWith("c");
}

// In split mode, consignment SKUs use the consignment cutoff; everything else the regular cutoff.
export function recencyCutoffMs(sku, { regularCutoffMs, consignmentCutoffMs }) {
  return isConsignmentSku(sku) ? consignmentCutoffMs : regularCutoffMs;
}

export function isSaleWithinWindow(lastSaleMs, cutoffMs) {
  return lastSaleMs != null && Number.isFinite(lastSaleMs) && lastSaleMs >= cutoffMs;
}

export function isActiveProduct(product) {
  return product?.active !== false && product?.is_active !== false;
}

export function isInventoryTracked(product) {
  return product?.has_inventory === true;
}

export function isDeleted(product) {
  return !!product?.deleted_at;
}

function isRecentlySoldGuarded(pid, sku, context) {
  const pidKey = String(pid);
  if (context.lastSaleByPid) {
    const last = context.lastSaleByPid.get(pidKey);
    return isSaleWithinWindow(last, recencyCutoffMs(sku, context));
  }
  return context.recentSalePids.has(pid) || context.recentSalePids.has(pidKey);
}

function onHandFor(context, pid) {
  const pidKey = String(pid);
  return context.onHand.get(pid) || context.onHand.get(pidKey) || 0;
}

function setHas(ids, pid) {
  const pidKey = String(pid);
  return ids.has(pid) || ids.has(pidKey);
}

export function candidateReasonFromProduct(product, context) {
  const pid = product?.id;
  const sku = product?.sku || "";
  if (context.consignmentOnly && !isConsignmentSku(sku)) return "nonConsignment";
  if (!isActiveProduct(product)) return "inactive";
  if (isDeleted(product)) return "deleted";
  if (!isInventoryTracked(product)) return "nonInventory";
  if (onHandFor(context, pid) > 0) return "inStock";
  if (isRecentlySoldGuarded(pid, sku, context)) return "recentSale";
  if (setHas(context.openConsignmentPids, pid)) return "openConsignment";
  if (setHas(context.activeSeasonPids, pid)) return "activeSeasonGuard";
  return "candidate";
}

export function candidateReasonFromMeta(pid, meta, context) {
  const sku = meta?.sku || "";
  if (context.consignmentOnly && !isConsignmentSku(sku)) return "nonConsignment";
  if (meta?.active === false) return "inactive";
  if (meta?.deletedAt) return "deleted";
  if (meta?.hasInventory !== true) return "nonInventory";
  if (onHandFor(context, pid) > 0) return "inStock";
  if (isRecentlySoldGuarded(pid, sku, context)) return "recentSale";
  if (setHas(context.openConsignmentPids, pid)) return "openConsignment";
  if (setHas(context.activeSeasonPids, pid)) return "activeSeasonGuard";
  return "candidate";
}
