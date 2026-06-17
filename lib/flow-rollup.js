// Single source of truth for flow-report rollups.
//
// All totals on every page (store summary, department, vendor drilldown) are
// derived from one canonical set of per-product rows plus the datatail import:
//
//   product row → vendor → department → store summary
//
// This replaces the old split where the summary/department tables read
// scan-time dollar aggregates merged by lib/override-merge.js while the vendor
// drilldown recomputed live in pages/index.js. Those two paths disagreed (e.g.
// datatail "received" was added on top of LS-live received for the SAME goods,
// doubling the Received column for consignment brands).
//
// Domain rules encoded here (see CLAUDE.md):
//   - Received / Sold / Returned / On-hand: bottom-up from LS productStats —
//     Received = netReceivedUnits = liveOnHand + sold + onSale. Datatail
//     "received" is redundant with LS live inventory (goods were migrated into
//     LS) and is NEVER added. Datatail stock is used only as a fallback for a
//     SKU with no LS product at all.
//   - Ordered: datatail POs never made it into LS. For mixed vendors, add
//     datatail ordered dollars only for SKUs with no LS PO/return activity;
//     overlapping SKUs stay LS-only to avoid double-counting. If an old override
//     lacks usable per-product retail dollars, fall back to the guarded
//     vendor-level combine rule. Ordered cost follows the same overlap rule, but
//     only when product-level qty + cost are available (never fabricated).
//   - Vendor-return attribution is encoded per-pid (the scan overwrites
//     pidToSupplier with the datatail brand for override SKUs), so grouping by
//     vendorBucketKey splits brands that share one LS supplier id correctly.

import {
  displayOnHand,
  mismatchDerivedStock,
  netOrderedValue,
  netReceivedCost,
  netReceivedRetail,
  preferPositive,
  returnedCostValue,
  returnedRetailValue,
  skuMatchesSeason,
} from "./flow-math";
import {
  isResolvedSupplier,
  normVendorName,
  sameVendorBucket,
  supplierId,
  supplierName,
  vendorBucketKey,
} from "./vendor-match";

export function decodeHtml(s) {
  return (s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'");
}

function num(x) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

function skuOf(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

// Hard pull adds to LS, but when the same PO exists in both sources keep the
// larger of the two instead of summing (avoids double-counting).
function combineDollarValue(lsValue, overrideValue, overlap) {
  const a = num(lsValue);
  const b = num(overrideValue);
  return overlap ? Math.max(a, b) : a + b;
}

function overrideProductOrderedValue(op) {
  const explicit = num(
    op?.orderedRetail ?? op?.orderedValue ?? op?.orderedAmount ?? op?.ordered ?? op?.orderValue
  );
  if (explicit > 0) return explicit;
  return Math.max(0, num(op?.qtyOrdered) * num(op?.price));
}

function overrideProductOrderedUnits(op, rowBySku) {
  const qty = num(op?.qtyOrdered);
  if (qty > 0) return qty;
  const sku = skuOf(op?.style);
  const row = sku ? rowBySku.get(sku) : null;
  const price = preferPositive(op?.price, row?.price);
  const orderedRetail = overrideProductOrderedValue(op);
  return price > 0 && orderedRetail > 0 ? orderedRetail / price : 0;
}

function overrideProductOrderedCost(op, rowBySku) {
  const sku = skuOf(op?.style);
  const row = sku ? rowBySku.get(sku) : null;
  const cost = preferPositive(op?.cost, row?.cost);
  const units = overrideProductOrderedUnits(op, rowBySku);
  return cost > 0 && units > 0 ? units * cost : 0;
}

function displaySupplierName(sup) {
  return decodeHtml(supplierName(sup));
}

// Map each LS-matched pid to the datatail retail/cost it carries, so an LS row
// whose catalog price is $0 can fall back to the import's price (request-time,
// no live LS fetch). Keyed by pid via skuToPid so only this season's products
// (the ones the scan actually registered) are included.
function overridePricesByPid(override, skuToPid) {
  const priceByPid = {};
  const costByPid = {};
  for (const v of Object.values((override && override.vendors) || {})) {
    for (const op of (v && v.products) || []) {
      const pid = skuToPid[skuOf(op.style)];
      if (pid == null) continue;
      if (!(priceByPid[pid] > 0) && num(op.price) > 0) priceByPid[pid] = num(op.price);
      if (!(costByPid[pid] > 0) && num(op.cost) > 0) costByPid[pid] = num(op.cost);
    }
  }
  return { priceByPid, costByPid };
}

// Map each LS-matched pid to the vendor-return qty/dollars carried by the
// datatail import — RMH-era vendor returns that were never entered into LS, so
// the LS scan shows 0 returned for these products and they look like they are
// still in stock ("not showing out of the new report"). Keyed by pid via
// skuToPid and season-gated. We take the MAX per pid rather than summing: the
// datatailor hard pull and any RMH-returns backfill both derive from the same
// RMH source, so summing would double-count the same physical return.
function overrideReturnsByPid(override, skuToPid, season) {
  const byPid = {};
  for (const v of Object.values((override && override.vendors) || {})) {
    for (const op of (v && v.products) || []) {
      const qty = num(op.qtyReturned);
      if (qty <= 0) continue;
      const sku = skuOf(op.style);
      if (!sku) continue;
      if (season && !skuMatchesSeason(sku, season)) continue;
      const pid = skuToPid[sku];
      if (pid == null) continue;
      const prev = byPid[pid];
      if (!prev || qty > prev.qty) {
        byPid[pid] = {
          qty,
          retVal: Math.max(0, qty * num(op.price)),
          retCost: Math.max(0, qty * num(op.cost)),
        };
      }
    }
  }
  return byPid;
}

function addOverrideSale(target, key, op) {
  if (!key) return;
  const sold = num(op.qtySold);
  const onSale = num(op.qtySale);
  const saleAmt = num(op.saleAmt);
  const soldAmt = num(op.soldAmt);
  if (sold === 0 && onSale === 0 && saleAmt === 0 && soldAmt === 0) return;
  if (!target[key]) target[key] = { sold: 0, onSale: 0, saleAmt: 0, soldAmt: 0 };
  target[key].sold += sold;
  target[key].onSale += onSale;
  target[key].saleAmt += saleAmt;
  target[key].soldAmt += soldAmt;
}

// RMH-era sales were migrated into LS, but spring25/fall25 are closed seasons
// where a small migration-window gap can remain. The rmhsold__ backfill carries
// authoritative RMH *net* sold/on-sale buckets; apply it as a whole-source
// overlay (not additive) so already-migrated LS sales are never double-counted.
function overrideSoldByProduct(override, skuToPid, season) {
  const byPid = {};
  const bySku = {};
  for (const v of Object.values((override && override.vendors) || {})) {
    if (!v || v.source !== "rmh-sold-backfill") continue;
    for (const op of v.products || []) {
      const sku = skuOf(op.style);
      if (!sku) continue;
      if (season && !skuMatchesSeason(sku, season)) continue;
      addOverrideSale(bySku, sku, op);
      const pid = skuToPid[sku];
      if (pid != null) addOverrideSale(byPid, pid, op);
    }
  }
  return { byPid, bySku };
}

function shouldUseOverrideSale(overrideSale, sold, onSale) {
  if (!overrideSale) return false;
  const overrideUnits = num(overrideSale.sold) + num(overrideSale.onSale);
  const lsUnits = num(sold) + num(onSale);
  return overrideUnits >= lsUnits;
}

// Build a canonical row and its derived fields from raw per-product inputs.
function makeRow({
  pid,
  sku,
  name,
  variant,
  deptId,
  deptName,
  sup,
  price,
  cost,
  lsOrderedQty,
  displayOrderedQty,
  receivedRaw,
  liveOnHand,
  sold,
  onSale,
  retQty,
  retVal,
  retCost,
  saleAmt,
  overrideFields,
}) {
  const lsOrdered = num(lsOrderedQty);
  const orderedQty = displayOrderedQty != null ? num(displayOrderedQty) : lsOrdered;
  const received = num(receivedRaw);
  const ps = {
    qtyOrdered: orderedQty,
    qtyReceived: received,
    retQty: num(retQty),
    sold: num(sold),
    onSale: num(onSale),
    liveOnHand: liveOnHand == null ? null : num(liveOnHand),
    retVal: num(retVal),
    retCost: num(retCost),
  };
  const onHand = displayOnHand(ps);
  // Consignment / migrated no-PO products (qtyReceived === 0) can't be derived
  // from PO math, so mismatchDerivedStock tracks live on-hand for them and they
  // are never flagged as a mismatch.
  const derivedStock = mismatchDerivedStock(ps);
  const resolved = isResolvedSupplier(sup);
  const row = {
    pid: pid || null,
    sku: sku || "",
    name: name || "",
    variant: variant || "",
    deptId: deptId || "__none__",
    deptName: deptName || "",
    vendorId: resolved ? supplierId(sup) : "__unassigned__",
    vendorName: resolved ? displaySupplierName(sup) : "Unassigned",
    sup,
    price: num(price),
    cost: num(cost),
    // lsOrderedQty feeds the bottom-up LS ordered rollup; orderedQty/onOrderQty
    // drive the product table only (datatail ordered is a vendor-level figure).
    lsOrderedQty: lsOrdered,
    orderedQty,
    onOrderQty: Math.max(0, orderedQty - received),
    receivedRaw: received,
    liveOnHand: ps.liveOnHand,
    onHand,
    sold: ps.sold,
    onSale: ps.onSale,
    retQty: ps.retQty,
    retVal: ps.retVal,
    retCost: ps.retCost,
    saleAmt: num(saleAmt),
    inventoryMismatch: ps.liveOnHand != null && ps.liveOnHand !== derivedStock,
  };
  // Fields whose value came from the RMH/datatail override overlay (not LS).
  // These are NOT LS-verifiable — the validation harness re-derives expected
  // values from Lightspeed alone, so it must skip these instead of flagging
  // them as drift. Only set when present to keep the row shape lean.
  if (overrideFields && overrideFields.length) row.overrideFields = overrideFields;
  return row;
}

// Resolve a department id/name. LS-matched products carry an LS category id via
// pidToType; datatail-only products resolve their datatail dept name to the LS
// department when the names match, else fall back to a synthetic id.
function makeDeptResolver(scanData) {
  const nameById = {};
  const idByNorm = {};
  for (const r of (scanData && scanData.summaryRows) || []) {
    nameById[String(r.id)] = r.name;
    const norm = normVendorName(r.name);
    if (norm) idByNorm[norm] = String(r.id);
  }
  return {
    nameForId(deptId) {
      if (deptId == null || deptId === "__none__") return "Other";
      return nameById[String(deptId)] || String(deptId);
    },
    resolveDatatailDept(deptName) {
      const norm = normVendorName(deptName);
      if (norm && idByNorm[norm]) {
        const id = idByNorm[norm];
        return { deptId: id, deptName: nameById[id] };
      }
      return { deptId: norm ? `ov:${norm}` : "__none__", deptName: decodeHtml(deptName) };
    },
  };
}

// True when at least one of the override vendor's SKUs already has LS PO or
// return activity — meaning the same PO exists in both sources.
// Overlap test for the ORDERED combine: does LS already carry this SKU's
// purchase-order ordered dollars (so adding the datatail ordered would
// double-count)? This must key off LS *PO* activity only — qtyOrdered or
// qtyReceived. A vendor RETURN (retQty) does NOT imply the PO was migrated into
// LS: for RMH-era products LS often holds the return but has zero ordered/
// received, so counting retQty as overlap would WRONGLY drop the datatail
// ordered dollars (they aren't in lsOrdered either). Returned dollars are
// reconciled separately by the returns path, not here.
function hasLsPoActivity(op, productStats, skuToPid, consignByPid) {
  const pid = skuToPid[skuOf(op?.style)];
  if (pid == null) return false;
  const ps = productStats[pid];
  if (ps && ((ps.qtyOrdered || 0) > 0 || (ps.qtyReceived || 0) > 0)) return true;
  // The live consignment overlay can carry LS PO activity that the baked
  // productStats does not yet reflect (newly-entered POs). Treat that as overlap
  // too, so the datatail ordered combine never double-counts a SKU LS now owns.
  const ov = consignByPid ? consignByPid[String(pid)] : null;
  return !!(ov && ((ov.qtyOrdered || 0) > 0 || (ov.qtyReceived || 0) > 0));
}

// Produce one canonical row per product across LS pids and datatail SKUs,
// deduped by pid (LS) / sku (datatail-only). Tolerates null scanData
// (override-only season) and null override (LS-only season).
export function buildAllRows(scanData, override, options = {}) {
  const data = scanData || {};
  const productStats = data.productStats || {};
  const pidToType = data.pidToType || {};
  const pidToSupplier = data.pidToSupplier || {};
  const pidToQtyOrdered = data.pidToQtyOrdered || {};
  const pidToQtyReceived = data.pidToQtyReceived || {};
  const pidToQtyReturned = data.pidToQtyReturned || {};
  const pidToPrice = data.pidToPrice || {};
  const pidToCost = data.pidToCost || {};
  const pidToName = data.pidToName || {};
  const pidToSku = data.pidToSku || {};
  const pidToVariant = data.pidToVariant || {};
  const skuToPid = data.skuToPid || {};
  const seasonPids = data.seasonPids || [];
  const season = options.season || (scanData && scanData.season) || null;
  const dept = makeDeptResolver(scanData);

  // Datatail price/cost fallback for LS-matched rows. When the catalog price is
  // $0 (the LS API never returned a retail price for that product) but the
  // datatail import carries one, use it so returned/received retail and the
  // color key are not stuck at $0. No live LS fetch in the request path.
  const { priceByPid: overridePriceByPid, costByPid: overrideCostByPid } = overridePricesByPid(
    override,
    skuToPid
  );
  const overrideReturns = overrideReturnsByPid(override, skuToPid, season);
  const overrideSales = overrideSoldByProduct(override, skuToPid, season);

  // Request-time consignment overlay (lib/consignment-store.loadSeasonConsignOverlay):
  // a freshly re-projected { pid -> { qtyOrdered, qtyReceived, qtyReturned } } from
  // the live LS consignment store. When present it SUPERSEDES the baked scan:data
  // ordered/received/return qty so the report reflects the current store even when
  // the nightly scan baked stale values (newly-entered, future-dated POs lag the
  // per-season bucket the scan reads). Absent -> baked scan:data values are used.
  const consignByPid = options.consignByPid || null;

  const rowByKey = new Map();

  function lsRowFromPid(pid) {
    const stats = productStats[pid] || {};
    const deptId = pidToType[pid] || "__none__";
    const price = preferPositive(pidToPrice[pid], overridePriceByPid[pid]);
    const cost = preferPositive(pidToCost[pid], overrideCostByPid[pid]);

    const bakedOrderedQty = stats.qtyOrdered != null ? stats.qtyOrdered : pidToQtyOrdered[pid] || 0;
    const bakedReceivedQty =
      stats.qtyReceived != null ? stats.qtyReceived : pidToQtyReceived[pid] || 0;
    const bakedRetQty = stats.retQty != null ? stats.retQty : pidToQtyReturned[pid] || 0;

    // When the overlay is active it is AUTHORITATIVE for every LS pid: a pid with
    // no overlay entry means the live store has no PO/return for it (0), not
    // "keep the baked value". LS ordered/received/return qty come only from the
    // consignment store, so the fresh projection fully supersedes scan:data.
    const overlayActive = !!consignByPid;
    const overlay = overlayActive ? consignByPid[String(pid)] : null;
    const lsOrderedQty = overlayActive ? num(overlay?.qtyOrdered) : bakedOrderedQty;
    const receivedRaw = overlayActive ? num(overlay?.qtyReceived) : bakedReceivedQty;
    const lsRetQty = overlayActive ? num(overlay?.qtyReturned) : bakedRetQty;

    let retQty = lsRetQty;
    let retVal = stats.retVal || 0;
    let retCost = stats.retCost || 0;
    // When the live overlay changes the LS return qty, the baked retail/cost
    // dollars no longer correspond to it — re-derive from price/cost (mirrors the
    // returnedRetailValue qty×price fallback) so the Returned column stays
    // consistent with the overlaid quantity.
    if (overlayActive && lsRetQty !== bakedRetQty) {
      retVal = lsRetQty * price;
      retCost = lsRetQty * cost;
    }
    // Hard-pull (RMH) vendor return that never reached LS: surface it on the
    // matched LS product, but ONLY when LS has no return of its own for this pid
    // (lsRetQty === 0). Going forward returns are entered in LS, so once a return
    // lands in LS its qty wins and the RMH baseline is ignored — never summed.
    const overrideFields = [];
    const ovr = overrideReturns[pid];
    if (lsRetQty === 0 && ovr && ovr.qty > 0) {
      retQty = ovr.qty;
      retVal = ovr.retVal;
      retCost = ovr.retCost;
      overrideFields.push("retQty");
    }
    let sold = stats.sold || 0;
    let onSale = stats.onSale || 0;
    let saleAmt = stats.saleAmt || 0;
    const saleOvr = overrideSales.byPid[pid];
    if (shouldUseOverrideSale(saleOvr, sold, onSale)) {
      sold = saleOvr.sold;
      onSale = saleOvr.onSale;
      saleAmt = saleOvr.saleAmt;
      overrideFields.push("sold", "onSale", "saleAmt");
    }
    return makeRow({
      pid,
      sku: pidToSku[pid] || "",
      name: pidToName[pid] || "",
      variant: pidToVariant[pid] || "",
      deptId,
      deptName: dept.nameForId(deptId),
      sup: pidToSupplier[pid] || stats._sup,
      price,
      cost,
      lsOrderedQty,
      receivedRaw,
      liveOnHand: stats.liveOnHand,
      sold,
      onSale,
      retQty,
      retVal,
      retCost,
      saleAmt,
      overrideFields,
    });
  }

  // 1. LS rows — one per season pid.
  for (const pid of seasonPids) {
    rowByKey.set(String(pid), lsRowFromPid(pid));
  }

  // 2. Datatail (override) products — register override products whose pid was
  //    outside seasonPids, and create rows for datatail-only SKUs with no LS
  //    product. (Ordered is handled at the vendor level in rollup, so matched
  //    LS rows need no per-row ordered merge here.)
  const vendors = (override && override.vendors) || {};
  for (const v of Object.values(vendors)) {
    if (!v) continue;
    const sup = {
      id: v.vendorId || `${v.deptId || v.deptName || "override"}:${v.vendorName}`,
      name: decodeHtml(v.vendorName || "Imported Vendor"),
    };
    for (const op of v.products || []) {
      const sku = skuOf(op.style);
      if (!sku) continue;
      // Season gate: a datatail import done while on the wrong datatail season
      // must not pollute this season's totals. Skip override products whose SKU
      // season segment doesn't fold into this season (rs/ps→spring, pf→fall for
      // 2025/26). Only applied when the season is known (scanData present).
      if (season && !skuMatchesSeason(sku, season)) continue;
      const pid = skuToPid[sku];

      if (pid != null && rowByKey.has(String(pid))) continue; // already an LS row
      if (pid != null && productStats[pid]) {
        rowByKey.set(String(pid), lsRowFromPid(pid));
        continue;
      }

      // Datatail-only product (no LS pid). Use datatail stock/sold as the live
      // signal so it flows through the same received formula; in practice these
      // carry zero stock, but keep the fallback for correctness.
      const key = `sku:${sku}`;
      if (rowByKey.has(key)) continue;
      const resolvedDept = dept.resolveDatatailDept(v.deptName);
      const saleOvr = overrideSales.bySku[sku];
      let sold = num(op.qtySold);
      let onSale = num(op.qtySale);
      let saleAmt = num(op.saleAmt);
      if (shouldUseOverrideSale(saleOvr, sold, onSale)) {
        sold = saleOvr.sold;
        onSale = saleOvr.onSale;
        saleAmt = saleOvr.saleAmt;
      }
      rowByKey.set(
        key,
        makeRow({
          pid: null,
          sku,
          name: decodeHtml(op.description || ""),
          variant: [op.color, op.fabric, op.size].filter(Boolean).join(" / "),
          deptId: resolvedDept.deptId,
          deptName: resolvedDept.deptName,
          sup,
          price: op.price,
          cost: op.cost,
          // Datatail-only rows have no LS ordered; their ordered is part of the
          // vendor-level datatail total, so keep lsOrderedQty 0 to avoid double
          // counting. Show the per-product datatail qty in the table only.
          lsOrderedQty: 0,
          displayOrderedQty: num(op.qtyOrdered),
          receivedRaw: 0,
          liveOnHand: num(op.qtyStock),
          sold,
          onSale,
          retQty: num(op.qtyReturned),
          retVal: 0,
          retCost: 0,
          saleAmt,
        })
      );
    }
  }

  return Array.from(rowByKey.values());
}

function statsFromRow(row) {
  return {
    qtyOrdered: row.lsOrderedQty,
    qtyReceived: row.receivedRaw,
    retQty: row.retQty,
    sold: row.sold,
    onSale: row.onSale,
    liveOnHand: row.liveOnHand,
    retVal: row.retVal,
    retCost: row.retCost,
  };
}

function emptyVendorTotals(id, name) {
  return {
    id,
    name: decodeHtml(name),
    ordered: 0,
    orderedCost: 0,
    received: 0,
    cost: 0,
    returned: 0,
    returnedCost: 0,
    sold: 0,
    lsOrdered: 0, // internal: LS-only ordered, before datatail combine
  };
}

// Roll canonical rows up to { summaryRows, deptVendors }. This is the ONLY
// rollup — server (data.js) and client (drilldown header) both read it so the
// three pages can never disagree. Received/Sold/Returned are bottom-up from the
// rows; Ordered combines the bottom-up LS ordered with the vendor-level
// datatail ordered (per the data reality — see file header).
export function rollup(rows, scanData, override, options = {}) {
  const deptVendorMap = {}; // deptId -> { vendorKey -> totals }
  const deptNameById = {};
  const dept = makeDeptResolver(scanData);
  const rowBySku = new Map();
  for (const row of rows || []) {
    const sku = skuOf(row?.sku);
    if (sku && !rowBySku.has(sku)) rowBySku.set(sku, row);
  }

  function bucket(deptId, vkey, id, name) {
    if (!deptVendorMap[deptId]) deptVendorMap[deptId] = {};
    if (!deptVendorMap[deptId][vkey]) deptVendorMap[deptId][vkey] = emptyVendorTotals(id, name);
    return deptVendorMap[deptId][vkey];
  }

  // Pass 1: bottom-up totals from rows (LS ordered, received, sold, returned).
  for (const row of rows || []) {
    const deptId = row.deptId || "__none__";
    if (!deptNameById[deptId])
      deptNameById[deptId] = row.deptName || (deptId === "__none__" ? "Other" : deptId);
    const vkey = vendorBucketKey(row.sup);
    const v = bucket(deptId, vkey, row.vendorId, row.vendorName);
    const ps = statsFromRow(row);
    v.lsOrdered += netOrderedValue(ps, row.price);
    v.orderedCost += Math.max(0, (row.lsOrderedQty - row.retQty) * row.cost);
    v.received += netReceivedRetail(ps, row.price);
    v.cost += netReceivedCost(ps, row.cost);
    v.returned += returnedRetailValue(ps, row.price);
    v.returnedCost += returnedCostValue(ps, row.cost);
    v.sold += row.sold * row.price;
  }

  // Pass 2: fold the vendor-level datatail ordered into each matching bucket.
  const productStats = (scanData && scanData.productStats) || {};
  const skuToPid = (scanData && scanData.skuToPid) || {};
  const season = options.season || (scanData && scanData.season) || null;
  const consignByPid = options.consignByPid || null;
  const datatailByBucket = {}; // deptId|vkey -> ordered merge inputs
  for (const v of Object.values((override && override.vendors) || {})) {
    if (!v) continue;
    const products = (v.products || []).filter((op) => {
      const sku = skuOf(op?.style);
      return sku && (!season || skuMatchesSeason(sku, season));
    });
    // Season gate (mirrors buildAllRows): a vendor whose datatail SKUs all
    // belong to another season is a wrong-season import — don't fold its
    // ordered dollars into this season.
    if (season && products.length === 0) continue;
    const sup = {
      id: v.vendorId || `${v.deptId || v.deptName || "override"}:${v.vendorName}`,
      name: decodeHtml(v.vendorName || "Imported Vendor"),
    };
    const resolvedDept = dept.resolveDatatailDept(v.deptName);
    const vkey = vendorBucketKey(sup);
    const k = `${resolvedDept.deptId}|${vkey}`;
    if (!datatailByBucket[k]) {
      datatailByBucket[k] = {
        ordered: 0,
        overlap: false,
        id: supplierId(sup),
        name: supplierName(sup),
        deptId: resolvedDept.deptId,
        deptName: resolvedDept.deptName,
        vkey,
        productOrdered: 0,
        productOrderedCost: 0,
        uniqueProductOrdered: 0,
        uniqueProductOrderedCost: 0,
        hasProductOrdered: false,
        hasProductOrderedCost: false,
      };
    }
    const bucket = datatailByBucket[k];
    bucket.ordered += num(v.ordered);
    for (const op of products) {
      const value = overrideProductOrderedValue(op);
      const cost = overrideProductOrderedCost(op, rowBySku);
      if (value > 0) bucket.hasProductOrdered = true;
      if (cost > 0) bucket.hasProductOrderedCost = true;
      bucket.productOrdered += value;
      bucket.productOrderedCost += cost;
      const overlap = hasLsPoActivity(op, productStats, skuToPid, consignByPid);
      bucket.overlap = bucket.overlap || overlap;
      if (!overlap) {
        bucket.uniqueProductOrdered += value;
        bucket.uniqueProductOrderedCost += cost;
      }
    }
  }

  for (const dt of Object.values(datatailByBucket)) {
    if (!deptNameById[dt.deptId]) deptNameById[dt.deptId] = dt.deptName;
    const v = bucket(dt.deptId, dt.vkey, dt.id, dt.name);
    if (dt.overlap && (dt.hasProductOrdered || dt.hasProductOrderedCost)) {
      v.ordered = dt.hasProductOrdered
        ? v.lsOrdered + dt.uniqueProductOrdered
        : combineDollarValue(v.lsOrdered, dt.ordered, dt.overlap);
      v.orderedCost += dt.uniqueProductOrderedCost;
    } else {
      v.ordered = combineDollarValue(v.lsOrdered, dt.ordered, dt.overlap);
      v.orderedCost = combineDollarValue(v.orderedCost, dt.productOrderedCost, dt.overlap);
    }
  }

  // Any bucket without a datatail entry keeps its LS-only ordered.
  const deptVendors = {};
  const summaryRows = [];
  for (const [deptId, vendorMap] of Object.entries(deptVendorMap)) {
    const vendorRows = Object.values(vendorMap).map((v) => {
      if (!v.ordered) v.ordered = v.lsOrdered;
      const { lsOrdered: _ls, ...rest } = v;
      return rest;
    });
    vendorRows.sort((a, b) => b.ordered - a.ordered);
    deptVendors[deptId] = vendorRows;
    const summary = emptyVendorTotals(deptId, deptNameById[deptId]);
    delete summary.lsOrdered;
    for (const v of vendorRows) {
      summary.ordered += v.ordered;
      summary.orderedCost += v.orderedCost;
      summary.received += v.received;
      summary.cost += v.cost;
      summary.returned += v.returned;
      summary.returnedCost += v.returnedCost;
      summary.sold += v.sold;
    }
    summaryRows.push(summary);
  }

  // Preserve any LS departments that ended up with no rows so the category list
  // stays stable (the UI hides zero rows, but this avoids dropping names).
  for (const r of (scanData && scanData.summaryRows) || []) {
    if (!deptVendors[String(r.id)]) {
      deptVendors[String(r.id)] = [];
      if (!summaryRows.some((s) => String(s.id) === String(r.id))) {
        const empty = emptyVendorTotals(r.id, r.name);
        delete empty.lsOrdered;
        summaryRows.push(empty);
      }
    }
  }

  summaryRows.sort((a, b) => b.ordered - a.ordered);
  return { summaryRows, deptVendors };
}

// Convenience: rows belonging to a vendor, optionally scoped to a department.
// Mirrors the drilldown filters (dept view restricts to the dept + unassigned;
// the all-departments view spans every dept).
export function rowsForVendor(rows, vendor, dept) {
  return (rows || []).filter((row) => {
    if (!sameVendorBucket(row.sup, vendor)) return false;
    if (!dept) return true;
    return String(row.deptId) === String(dept.id) || row.deptId === "__none__";
  });
}

// Vendor drilldown header totals — read straight from the authoritative rollup
// (scanData.deptVendors) so the header always equals the vendor list row. When
// dept is null (all-departments view) the vendor's rows across every department
// are summed.
export function vendorRollupTotals(deptVendors, vendor, dept) {
  const t = {
    orderedRetail: 0,
    orderedCost: 0,
    receivedRetail: 0,
    receivedCost: 0,
    returnedRetail: 0,
    returnedCost: 0,
    soldRetail: 0,
  };
  const depts = dept
    ? Array.from(
        new Set([String(dept.id), String(dept.id) === "__none__" ? null : "__none__"])
      ).filter(Boolean)
    : Object.keys(deptVendors || {});
  for (const deptId of depts) {
    for (const v of (deptVendors && deptVendors[deptId]) || []) {
      if (!sameVendorBucket({ id: v.id, name: v.name }, vendor)) continue;
      t.orderedRetail += v.ordered || 0;
      t.orderedCost += v.orderedCost || 0;
      t.receivedRetail += v.received || 0;
      t.receivedCost += v.cost || 0;
      t.returnedRetail += v.returned || 0;
      t.returnedCost += v.returnedCost || 0;
      t.soldRetail += v.sold || 0;
    }
  }
  return t;
}

// Sum bottom-up totals directly from a set of product rows (received, sold,
// returned). Used for tests/assertions where the row-level invariant matters;
// note Ordered here is LS-only (the datatail vendor-level ordered lives in the
// rollup), so use vendorRollupTotals for header Ordered.
export function vendorHeaderTotals(rows) {
  const t = {
    orderedRetail: 0,
    orderedCost: 0,
    receivedRetail: 0,
    receivedCost: 0,
    returnedRetail: 0,
    returnedCost: 0,
    soldRetail: 0,
  };
  for (const row of rows || []) {
    const ps = statsFromRow(row);
    t.orderedRetail += netOrderedValue(ps, row.price);
    t.orderedCost += Math.max(0, (row.lsOrderedQty - row.retQty) * row.cost);
    t.receivedRetail += netReceivedRetail(ps, row.price);
    t.receivedCost += netReceivedCost(ps, row.cost);
    t.returnedRetail += returnedRetailValue(ps, row.price);
    t.returnedCost += returnedCostValue(ps, row.cost);
    t.soldRetail += row.sold * row.price;
  }
  return t;
}
