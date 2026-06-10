import { SEASONS } from "./seasons";

export function seasonSkuCodes(seasonId) {
  const m = String(seasonId || "").match(/^(prefall|fall|spring|prespring)(\d+)$/);
  if (!m) return [];
  const yy = m[2].slice(-2);
  if (m[1] === "prespring") return ["/rs" + yy, "/ps" + yy];
  if (m[1] === "prefall") return ["/pf" + yy];
  if (m[1] === "fall") {
    const hasPreFall = SEASONS.some((s) => s.id === `prefall${yy}`);
    return hasPreFall ? ["/f" + yy] : ["/f" + yy, "/pf" + yy];
  }
  if (m[1] === "spring") {
    const hasPreSpring = SEASONS.some((s) => s.id === `prespring${yy}`);
    return hasPreSpring ? ["/s" + yy] : ["/s" + yy, "/rs" + yy, "/ps" + yy];
  }
  return [];
}

export function skuMatchesSeason(sku, seasonId) {
  const normalized = String(sku || "")
    .toLowerCase()
    .trim();
  if (!normalized) return false;
  return seasonSkuCodes(seasonId).some((code) => normalized.includes(code));
}

export function seasonSalesFallbackDate(seasonId) {
  const m = String(seasonId || "").match(/^(prefall|fall|prespring|spring)(\d{2})$/);
  if (!m) return null;
  const year = 2000 + parseInt(m[2], 10);
  const startMonth = m[1] === "fall" || m[1] === "prefall" ? 8 : 2;
  const fromDate = new Date(year, startMonth - 1 - 12, 1);
  return fromDate.toISOString().slice(0, 10);
}

export function dateMinusDays(isoDate, days) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function consignmentDate(c) {
  const raw =
    c?.due_at ||
    c?.received_at ||
    c?.created_at ||
    c?.updated_at ||
    c?.date ||
    c?.delivery_due_at ||
    c?.versioned_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function productPrice(p) {
  return (
    parseFloat(p?.price_excluding_tax || p?.price || p?.retail_price || p?.unit_price || 0) || 0
  );
}

export function productCost(p) {
  return parseFloat(p?.supply_price || p?.cost || p?.unit_cost || 0) || 0;
}

export function productName(p) {
  const description = p?.description
    ? String(p.description)
        .replace(/<[^>]*>/g, "")
        .trim()
    : "";
  return description || p?.name || "";
}

export function productVariant(p) {
  return (
    p?.variant_option_one_value ||
    p?.variant_name ||
    [p?.color, p?.fabric, p?.size].filter(Boolean).join(" / ") ||
    ""
  );
}

export function emptyProductStats() {
  return {
    ordered: 0,
    orderedCost: 0,
    received: 0,
    receivedCost: 0,
    retVal: 0,
    retCost: 0,
    retQty: 0,
    qtyOrdered: 0,
    qtyReceived: 0,
    soldAmt: 0,
    saleAmt: 0,
    sold: 0,
    onSale: 0,
    returned: 0,
  };
}

export function addContribution(target, contribution, sign = 1) {
  if (!target || !contribution) return target;
  for (const [pid, c] of Object.entries(contribution.perPid || {})) {
    if (!target[pid]) target[pid] = { sold: 0, onSale: 0, saleAmt: 0, soldAmt: 0, returned: 0 };
    target[pid].sold = (target[pid].sold || 0) + sign * (c.sold || 0);
    target[pid].onSale = (target[pid].onSale || 0) + sign * (c.onSale || 0);
    target[pid].saleAmt = (target[pid].saleAmt || 0) + sign * (c.saleAmt || 0);
    target[pid].soldAmt = (target[pid].soldAmt || 0) + sign * (c.soldAmt || 0);
    target[pid].returned = (target[pid].returned || 0) + sign * (c.returned || 0);
  }
  return target;
}

export function saleContribution(sale, seasonPidSet, pidToPrice = {}) {
  const contribution = {
    saleId: sale?.id || sale?.sale_id || sale?.invoice_number || null,
    version: sale?.version || 0,
    status: sale?.status || "",
    perPid: {},
  };
  const saleStatus = String(sale?.status || "")
    .toUpperCase()
    .replace(/[\s,_-]/g, "");
  if (
    saleStatus === "OPEN" ||
    saleStatus === "PARKED" ||
    saleStatus === "LAYBY" ||
    saleStatus === "LAYAWAY"
  )
    return contribution;

  for (const li of sale?.line_items || []) {
    if (!li?.product_id || li.status === "VOIDED") continue;
    const pid = li.product_id;
    if (!seasonPidSet.has(pid)) continue;

    const qty = parseInt(li.quantity == null ? 1 : li.quantity, 10);
    if (!qty) continue;
    const amount = li.total_price != null ? parseFloat(li.total_price) : parseFloat(li.price || 0);
    const unitPrice = qty !== 0 ? Math.abs(amount / qty) : 0;
    const retailPrice = pidToPrice[pid] || 0;
    const discounted =
      parseFloat(li.discount || li.line_discount || li.discount_total || 0) > 0 ||
      amount === 0 ||
      (retailPrice > 0 && unitPrice < retailPrice * 0.99);

    if (!contribution.perPid[pid])
      contribution.perPid[pid] = { sold: 0, onSale: 0, saleAmt: 0, soldAmt: 0, returned: 0 };
    const c = contribution.perPid[pid];
    c.soldAmt += amount;
    if (qty < 0) {
      if (discounted) c.onSale += qty;
      else c.sold += qty;
      c.returned += Math.abs(qty);
    } else if (discounted) {
      c.onSale += qty;
      c.saleAmt += amount;
    } else {
      c.sold += qty;
    }
  }

  return contribution;
}

export function applySalesTotals(productStats, perPidTotals = {}) {
  for (const [pid, totals] of Object.entries(perPidTotals || {})) {
    if (!productStats[pid]) productStats[pid] = emptyProductStats();
    const ps = productStats[pid];
    ps.sold = Math.max(0, totals.sold || 0);
    ps.onSale = Math.max(0, totals.onSale || 0);
    ps.saleAmt = totals.saleAmt || 0;
    ps.soldAmt = totals.soldAmt || 0;
    ps.returned = Math.max(0, totals.returned || 0);
  }
}

export function derivedOnHand(ps) {
  return Math.max(
    0,
    (ps?.qtyReceived || 0) - (ps?.sold || 0) - (ps?.onSale || 0) - (ps?.retQty || 0)
  );
}

export function onOrderQty(ps) {
  return Math.max(0, (ps?.qtyOrdered || 0) - (ps?.qtyReceived || 0));
}

export function netOrderedValue(ps, price) {
  return Math.max(0, ((ps?.qtyOrdered || 0) - (ps?.retQty || 0)) * (price || 0));
}

export function netReceivedValue(ps, price) {
  return Math.max(0, ((ps?.qtyReceived || 0) - (ps?.retQty || 0)) * (price || 0));
}
