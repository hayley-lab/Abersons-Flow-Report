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
  const seasonSegment = normalized.includes("/") ? normalized.split("/")[1] : "";
  if (!seasonSegment) return false;
  return seasonSkuCodes(seasonId).some((code) => seasonSegment.startsWith(code.slice(1)));
}

export function seasonSalesFallbackDate(seasonId) {
  const m = String(seasonId || "").match(/^(prefall|fall|prespring|spring)(\d{2})$/);
  if (!m) return null;
  const year = 2000 + parseInt(m[2], 10);
  const startMonth = m[1] === "fall" || m[1] === "prefall" ? 8 : 2;
  // Date.UTC, not the local-time constructor: the result is serialized with
  // toISOString, so a local midnight east of UTC lands on the previous day and
  // shifts every sales/consignment window by one day.
  const fromDate = new Date(Date.UTC(year, startMonth - 1 - 12, 1));
  return fromDate.toISOString().slice(0, 10);
}

export function seasonScanDateRange(seasonId) {
  const fallbackStart = seasonSalesFallbackDate(seasonId);
  const m = String(seasonId || "").match(/^(prefall|fall|prespring|spring)(\d{2})$/);
  if (!fallbackStart || !m) return { start: null, end: null };
  const start = dateMinusDays(fallbackStart, 365) || fallbackStart;
  const year = 2000 + parseInt(m[2], 10);
  const isFall = m[1] === "fall" || m[1] === "prefall";
  const endYear = isFall ? year + 1 : year;
  const endMonth = isFall ? "01" : "07";
  return { start, end: `${endYear}-${endMonth}-31` };
}

export function dateInRange(isoDate, range) {
  if (!isoDate) return false;
  if (range?.start && isoDate < range.start) return false;
  if (range?.end && isoDate > range.end) return false;
  return true;
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

// Upgrade rule for price/cost maps: never let a real (positive) value be
// overwritten by a missing/zero one, but always promote a stored 0/undefined to
// a positive incoming value. A product first registered at $0 (e.g. a variant
// seen before its parent, or a PO line-item fetch without a price) must pick up
// a later catalog price — otherwise its $0 poisons every dollar column for that
// pid (returned-retail, received-retail, sale classification).
export function preferPositive(current, incoming) {
  const cur = Number.isFinite(current) ? current : parseFloat(current) || 0;
  if (cur > 0) return cur;
  const inc = Number.isFinite(incoming) ? incoming : parseFloat(incoming) || 0;
  return inc > 0 ? inc : cur;
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

function hasDiscountMarker(li) {
  const directDiscount = [
    "discount",
    "line_discount",
    "discount_total",
    "discount_amount",
    "total_discount",
    "line_discount_amount",
    "total_discount_amount",
    "price_book_discount",
    "pricebook_discount",
  ].some((key) => parseFloat(li?.[key] || 0) > 0);
  if (directDiscount) return true;

  const pctDiscount = ["discount_percent", "discount_percentage", "discount_rate"].some(
    (key) => parseFloat(li?.[key] || 0) > 0
  );
  if (pctDiscount) return true;

  if (Array.isArray(li?.discounts)) {
    return li.discounts.some((d) => parseFloat(d?.amount || d?.value || 0) > 0);
  }

  return !!(
    li?.is_discounted ||
    li?.was_discounted ||
    li?.discount_reason ||
    li?.discount_rule_id ||
    li?.price_book_id ||
    li?.pricebook_id
  );
}

// The original-sale link carried on a customer-return sale. LS exposes it as
// `sale.return_for` (verified against the live API, Jun 2026); some payload
// shapes nest it differently, so check the known fallbacks too.
export function returnForId(sale) {
  return sale?.return_for || sale?.return?.original_sale_id || sale?.original_sale_id || null;
}

// Which bucket (full-price `sold` vs discounted `onSale`) a pid originally sold
// from, derived from the original sale's per-pid contribution. Returns null when
// the original is unknown or ambiguous (both buckets non-zero, or neither) so
// the caller falls back to the discount-marker heuristic.
export function returnBucketFromOriginal(originalPerPid, pid) {
  const o = originalPerPid && originalPerPid[pid];
  if (!o) return null;
  const onSale = Math.abs(o.onSale || 0);
  const sold = Math.abs(o.sold || 0);
  if (onSale > 0 && sold === 0) return "onSale";
  if (sold > 0 && onSale === 0) return "sold";
  return null;
}

export function saleContribution(sale, seasonPidSet, pidToPrice = {}, opts = {}) {
  // For a customer return, opts.originalPerPid is the original sale's per-pid
  // contribution (resolved via returnForId by the caller). When present it
  // overrides the discount heuristic for deciding sold vs onSale.
  const originalPerPid = opts.originalPerPid || null;
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
    // Derive the LINE total. total_price/price_total are already line totals;
    // li.price is a UNIT price, so multiply by qty (the old code used it as-is,
    // under-reporting multi-qty lines that lacked total_price).
    let amount;
    if (li.total_price != null) amount = parseFloat(li.total_price);
    else if (li.price_total != null) amount = parseFloat(li.price_total);
    else if (li.price != null) amount = parseFloat(li.price) * qty;
    else amount = 0;
    if (!Number.isFinite(amount)) amount = 0;
    const unitPrice = qty !== 0 ? Math.abs(amount / qty) : 0;
    const lineFullPrice = parseFloat(
      li.full_price ||
        li.original_price ||
        li.retail_price ||
        li.price_excluding_tax ||
        li.unit_full_price ||
        0
    );
    const retailPrice = lineFullPrice || pidToPrice[pid] || 0;
    const discounted =
      hasDiscountMarker(li) || amount === 0 || (retailPrice > 0 && unitPrice < retailPrice - 0.005);

    if (!contribution.perPid[pid])
      contribution.perPid[pid] = { sold: 0, onSale: 0, saleAmt: 0, soldAmt: 0, returned: 0 };
    const c = contribution.perPid[pid];
    c.soldAmt += amount;
    if (qty < 0) {
      // Customer return. Prefer the bucket the item ORIGINALLY sold from (via
      // sale.return_for → the original sale's ledger entry) over the discount
      // heuristic — a return line can lack the original's discount markers and
      // would otherwise be misfiled. Fall back to the heuristic when the
      // original is unknown or ambiguous.
      const origBucket = returnBucketFromOriginal(originalPerPid, pid);
      const toOnSale = origBucket ? origBucket === "onSale" : discounted;
      if (toOnSale) {
        c.onSale += qty;
        c.saleAmt += amount;
      } else c.sold += qty;
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
    ps.sold = totals.sold || 0;
    ps.onSale = totals.onSale || 0;
    ps.saleAmt = totals.saleAmt || 0;
    ps.soldAmt = totals.soldAmt || 0;
    ps.returned = totals.returned || 0;
  }
}

export function derivedOnHand(ps) {
  return Math.max(
    0,
    (ps?.qtyReceived || 0) - (ps?.sold || 0) - (ps?.onSale || 0) - (ps?.retQty || 0)
  );
}

export function displayOnHand(ps) {
  return ps?.liveOnHand != null ? ps.liveOnHand : derivedOnHand(ps);
}

// Predicted on-hand used ONLY for the manual-adjustment (`≠`) flag — the PO-math
// stock that live LS on-hand is compared against. For consignment / migrated
// goods with no LS PO record (qtyReceived === 0) there is nothing to predict, so
// the predicted stock tracks live on-hand (net of any vendor returns). This
// keeps those products from being falsely flagged as mismatches.
export function mismatchDerivedStock(ps) {
  if ((ps?.qtyReceived || 0) === 0) {
    const live = ps?.liveOnHand;
    return live == null ? 0 : Math.max(0, live - (ps?.retQty || 0));
  }
  return derivedOnHand(ps);
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

// Received units that drive the Received COLUMN and the Received%/Sold%
// denominators: net of vendor returns straight from the LS purchase order
// (qtyReceived − retQty). This is intentionally NOT derived from live on-hand,
// so a manual LS on-hand correction can never distort Received or sell-through.
//
// Consignment / migrated-goods fallback (critical): a product with no LS PO
// record (qtyReceived === 0 — consignment goods, or stock migrated from the old
// system) has no PO-received qty to read, so fall back to the live-derived
// received (on-hand + sold + on sale). Without this, every consignment product
// would show 0 received and would be falsely flagged as a mismatch.
export function netReceivedUnits(ps) {
  if ((ps?.qtyReceived || 0) === 0) {
    return Math.max(0, displayOnHand(ps) + (ps?.sold || 0) + (ps?.onSale || 0));
  }
  return Math.max(0, (ps?.qtyReceived || 0) - (ps?.retQty || 0));
}

export function netReceivedCost(ps, cost) {
  return Math.max(0, netReceivedUnits(ps) * (cost || 0));
}

export function netReceivedRetail(ps, price) {
  return Math.max(0, netReceivedUnits(ps) * (price || 0));
}

export function returnedRetailValue(ps, price) {
  return ps?.retVal > 0 ? ps.retVal : Math.max(0, (ps?.retQty || 0) * (price || 0));
}

export function returnedCostValue(ps, cost) {
  return ps?.retCost > 0 ? ps.retCost : Math.max(0, (ps?.retQty || 0) * (cost || 0));
}
