/*
 * MANUAL data-accuracy harness (NOT part of the normal test suite — the filename
 * is not *.test/*.spec and not under __tests__, so `npm test`/CI never runs it).
 *
 * It replays the REAL request-time rollup (lib/flow-rollup.js) against live Vercel
 * KV — exactly what pages/api/scan/data.js does — and diffs each RMH-era season
 * against RMH source-of-truth (tsql). This proves the actual report numbers (not
 * just the stored overrides) reconcile with RMH, without needing REPORT_PASSWORD.
 *
 * RUN (LAN only — RMH 172.16.2.4 is not reachable from Vercel):
 *   npx jest --runTestsByPath tools/recon-accuracy.js
 *
 * REQUIREMENTS: FreeTDS `tsql`; .env.rmh (HOST/USER/PASS/DATABASE/PORT);
 *   .env.local (KV_REST_API_URL + KV_REST_API_TOKEN).
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { kv } from "@vercel/kv";
import { loadScanData } from "../lib/scan-data-store";
import { buildAllRows, rollup } from "../lib/flow-rollup";

const ROOT = process.cwd();

function loadEnv(file) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env");
loadEnv(".env.rmh");

const SEASONS = ["spring25", "fall25", "spring26", "fall26"];

// Load RMH sold/on-sale truth from the newest frozen snapshot (scripts/out/
// rmh-snapshot-*/summary.json), produced by scripts/rmh-snapshot.mjs. Sales were
// migrated into LS, so the report's sold/on-sale should track RMH — a shortfall
// flags an LS migration-window gap (early-season RMH sales not migrated). Read
// from the snapshot (not a live re-query) to keep the harness fast + decoupled.
function loadSnapshotSales() {
  try {
    const base = path.join(ROOT, "scripts", "out");
    const dirs = readdirSync(base)
      .filter((d) => d.startsWith("rmh-snapshot-"))
      .sort();
    if (!dirs.length) return null;
    const summaryPath = path.join(base, dirs[dirs.length - 1], "summary.json");
    const j = JSON.parse(readFileSync(summaryPath, "utf8"));
    return { dir: dirs[dirs.length - 1], seasons: j.seasons || {} };
  } catch {
    return null;
  }
}

function seasonForSku(sku) {
  if (!sku || !sku.includes("/")) return null;
  const seg = sku.split("/")[1].toLowerCase();
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return null;
}

function parseKv(val) {
  if (!val) return null;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}

async function loadOverride(season) {
  const [storesRaw, indexRaw] = await Promise.all([
    kv.get(`scan:override:${season}:stores`),
    kv.get(`scan:override:${season}:vendorIndex`),
  ]);
  if (!indexRaw) return null;
  const vendorIndex = parseKv(indexRaw);
  const stores = parseKv(storesRaw) || {};
  if (!Array.isArray(vendorIndex)) return null;
  const vendorRaws = await Promise.all(
    vendorIndex.map((key) => kv.get(`scan:override:${season}:v:${key}`))
  );
  const vendors = {};
  vendorIndex.forEach((key, i) => {
    vendors[key] = parseKv(vendorRaws[i]);
  });
  return { stores, vendors };
}

const TAB = String.fromCharCode(9);
const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  CAST(PO.POType AS varchar(4)),
  I.ItemLookupCode,
  CAST(SUM(POE.QuantityOrdered) AS varchar(20)),
  CAST(SUM(POE.QuantityReceived) AS varchar(20)),
  CAST(SUM(POE.QuantityOrdered * I.Cost) AS varchar(20)),
  CAST(SUM(POE.QuantityOrdered * I.Price) AS varchar(20)))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
WHERE PO.POType IN (0,3) AND CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY PO.POType, I.ItemLookupCode;
go
quit
`;

function queryRmh() {
  const { HOST, USER, PASS, DATABASE, PORT } = process.env;
  const out = execFileSync(
    "tsql",
    ["-H", HOST, "-p", PORT || "1433", "-U", USER, "-P", PASS, "-D", DATABASE],
    { input: RMH_SQL, encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 * 1024 }
  );
  // bySeason[season] = { ordered:{u,c,r}, returns:{u,c,r}, received:{u} }
  // perSku[season][sku] = { ordered:{u}, received:{u}, returns:{u} } — needed for
  // the crossover-aware orders/received union (RMH pre-crossover + LS after).
  const bySeason = {};
  const perSku = {};
  for (const s of SEASONS) {
    bySeason[s] = {
      ordered: { u: 0, c: 0, r: 0 },
      received: { u: 0 },
      returns: { u: 0, c: 0, r: 0 },
    };
    perSku[s] = {};
  }
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 6) continue;
    const sku = f[1].trim().toLowerCase();
    const season = seasonForSku(sku);
    if (!season || !bySeason[season]) continue;
    const poType = parseInt(f[0], 10);
    const ordered = parseInt(f[2], 10) || 0;
    const received = parseInt(f[3], 10) || 0;
    const cost = parseFloat(f[4]) || 0;
    const retail = parseFloat(f[5]) || 0;
    const ps = (perSku[season][sku] = perSku[season][sku] || {
      ordered: { u: 0 },
      received: { u: 0 },
      returns: { u: 0 },
    });
    if (poType === 0) {
      bySeason[season].ordered.u += ordered;
      bySeason[season].ordered.c += cost;
      bySeason[season].ordered.r += retail;
      bySeason[season].received.u += received;
      ps.ordered.u += ordered;
      ps.received.u += received;
    } else if (poType === 3) {
      bySeason[season].returns.u += ordered;
      bySeason[season].returns.c += cost;
      bySeason[season].returns.r += retail;
      ps.returns.u += ordered;
    }
  }
  return { bySeason, perSku };
}

function sumReport(rows) {
  const t = {
    orderedU: 0,
    receivedU: 0,
    returnedU: 0,
    returnedR: 0,
    returnedC: 0,
    soldU: 0,
    onSaleU: 0,
    onHandU: 0,
  };
  for (const r of rows || []) {
    t.orderedU += Number(r.orderedQty) || 0;
    t.receivedU += Number(r.receivedRaw) || 0;
    t.returnedU += Number(r.retQty) || 0;
    t.returnedR += Number(r.retVal) || 0;
    t.returnedC += Number(r.retCost) || 0;
    t.soldU += Number(r.sold) || 0;
    t.onSaleU += Number(r.onSale) || 0;
    t.onHandU += Number(r.onHand) || 0;
  }
  return t;
}

const money = (n) => `$${Math.round(n).toLocaleString()}`;

test("RMH-season accuracy: report rollup reconciles with RMH", async () => {
  const { bySeason: rmh, perSku: rmhPerSku } = queryRmh();
  const snapSales = loadSnapshotSales();
  const lines = [];
  let returnsOk = true;
  let ordersOk = true;

  for (const season of SEASONS) {
    const scanData = await loadScanData(kv, season);
    const override = await loadOverride(season);
    const rows = buildAllRows(scanData, override, { season });
    const rep = sumReport(rows);
    // Ordered/Received/Returned DOLLARS come from the authoritative rollup (the
    // same path the live header/list/summary read) — NOT a raw row-unit sum.
    // Ordered $ folds in the vendor-level datatail combine, which row units miss.
    const { summaryRows } = rollup(rows, scanData, override, { season });
    const reportDollars = summaryRows.reduce(
      (a, s) => ({
        ordered: a.ordered + (Number(s.ordered) || 0),
        orderedCost: a.orderedCost + (Number(s.orderedCost) || 0),
        received: a.received + (Number(s.received) || 0),
        returned: a.returned + (Number(s.returned) || 0),
        sold: a.sold + (Number(s.sold) || 0),
      }),
      { ordered: 0, orderedCost: 0, received: 0, returned: 0, sold: 0 }
    );
    const r = rmh[season];
    const rmhSku = rmhPerSku[season] || {};

    // Returns-source breakdown: which row TYPE carries the returns, and which
    // SKUs are counted by more than one row (= double-count).
    let lsRet = 0;
    let datatailRet = 0;
    const skuRows = {};
    for (const row of rows) {
      const q = Number(row.retQty) || 0;
      if (q <= 0) continue;
      if (row.pid) lsRet += q;
      else datatailRet += q;
      const k = (row.sku || "").toLowerCase();
      (skuRows[k] = skuRows[k] || []).push(`${row.pid ? "pid" : "sku"}:${q}`);
    }
    const collisions = Object.entries(skuRows).filter(([, a]) => a.length > 1);
    const collisionUnits = collisions.reduce(
      (a, [, arr]) => a + arr.reduce((s, x) => s + Number(x.split(":")[1]), 0),
      0
    );

    // How much of the LS-row returns came from the LS SCAN itself (productStats
    // retQty) vs the override injection? The guard only uses override when LS
    // scan retQty === 0, so total = scanRet(pids with LS return) + overrideRet.
    const ps = (scanData && scanData.productStats) || {};
    const pidToQtyReturned = (scanData && scanData.pidToQtyReturned) || {};
    const seasonPids = (scanData && scanData.seasonPids) || [];
    const pidToSku = (scanData && scanData.pidToSku) || {};
    let psRetUnits = 0;
    let qtyRetUnits = 0;
    const samples = [];
    for (const pid of seasonPids) {
      const psRet = ps[pid] && ps[pid].retQty != null ? Number(ps[pid].retQty) : null;
      const qtyRet = Number(pidToQtyReturned[pid]) || 0;
      const q = psRet != null ? psRet : qtyRet;
      if (q > 0) {
        if (psRet != null && psRet > 0) psRetUnits += psRet;
        else qtyRetUnits += qtyRet;
        if (samples.length < 6)
          samples.push(`${pidToSku[pid] || pid}=${q}(ps.retQty=${psRet},pidToQtyRet=${qtyRet})`);
      }
    }
    const lsScanRetLine =
      `  LS-SCAN-RET[${season}] ps.retQty=${psRetUnits}u  pidToQtyReturned=${qtyRetUnits}u  ` +
      `samples: ${samples.join(" ")}`;

    // OVERLAP: LS returns (scan, type=RETURN) vs the RMH rmhret__ backfill, by SKU.
    // Tells us how much of the two return sources is the SAME SKU (potential
    // double-entry across systems) vs distinct.
    const lsRetBySku = {};
    for (const pid of seasonPids) {
      const q = ps[pid] && ps[pid].retQty != null ? Number(ps[pid].retQty) : 0;
      if (q > 0) lsRetBySku[(pidToSku[pid] || "").toLowerCase()] = q;
    }
    const rmhRetBySku = {};
    for (const [vkey, v] of Object.entries((override && override.vendors) || {})) {
      if (!String(vkey).startsWith("rmhret__")) continue;
      for (const p of (v && v.products) || []) {
        const q = Number(p.qtyReturned) || 0;
        if (q > 0) rmhRetBySku[(p.style || "").toLowerCase()] = q;
      }
    }
    let overlapSkus = 0;
    let overlapLsU = 0;
    let overlapRmhU = 0;
    for (const sku of Object.keys(lsRetBySku)) {
      if (rmhRetBySku[sku] != null) {
        overlapSkus += 1;
        overlapLsU += lsRetBySku[sku];
        overlapRmhU += rmhRetBySku[sku];
      }
    }
    const lsOnlyU = Object.entries(lsRetBySku)
      .filter(([s]) => rmhRetBySku[s] == null)
      .reduce((a, [, q]) => a + q, 0);
    const rmhOnlyU = Object.entries(rmhRetBySku)
      .filter(([s]) => lsRetBySku[s] == null)
      .reduce((a, [, q]) => a + q, 0);
    const overlapLine =
      `  OVERLAP[${season}] same-SKU in LS & RMH: ${overlapSkus} skus (LS ${overlapLsU}u / RMH ${overlapRmhU}u)  ` +
      `LS-only ${lsOnlyU}u  RMH-only ${rmhOnlyU}u`;

    // CORRECT GATE: the report's Returned column should equal the DEDUPED UNION
    // of LS returns + RMH-only returns (the per-pid LS-wins/max guard collapses
    // the transition overlap). Comparing to RMH-POType3-alone is wrong because
    // LS legitimately holds returns LS never had in RMH.
    const expectedUnion = psRetUnits + rmhOnlyU;
    const unionDelta = rep.returnedU - expectedUnion;
    // RMH-only seasons (no LS returns) must also match RMH POType=3 exactly.
    const rmhExactBad = psRetUnits === 0 && rep.returnedU !== r.returns.u;
    if (Math.abs(unionDelta) > 2 || rmhExactBad) returnsOk = false;

    // ---- CROSSOVER-AWARE ORDERS / RECEIVED -------------------------------
    // The report's Ordered = LS PO ordered (rows with a pid) + datatail-only
    // ordered (rows without a pid, sourced from the RMH-era datatailor import).
    // LS go-live for POs was 2025-12-19; RMH orders taper into Apr 2026, so the
    // two systems overlap. The report dedups by SKU (LS wins for matched SKUs),
    // so the correct RMH comparison is per-SKU, not a raw season total:
    //   1. datatail-only ordered should equal RMH POType=0 for those SKUs
    //      (validates the override is faithful AND current — catches stale/
    //      expired/duplicate-keyed overrides that would drop ordered qty).
    //   2. RMH SKUs present in NEITHER an LS row NOR a datatail row are orders
    //      the report shows nowhere = a genuine missed-order gap.
    //   3. LS-matched SKUs that ALSO have RMH POType=0 orders are the
    //      transition overlap; report uses LS-only (by design) — disclosed.
    const lsSkus = new Set();
    let datatailOrderedU = 0;
    const datatailOrderedBySku = {};
    for (const row of rows) {
      const sku = (row.sku || "").toLowerCase();
      if (row.pid) {
        lsSkus.add(sku);
      } else {
        const q = Number(row.orderedQty) || 0;
        datatailOrderedU += q;
        if (q > 0) datatailOrderedBySku[sku] = (datatailOrderedBySku[sku] || 0) + q;
      }
    }
    // RMH-only orders missed entirely (not in any report row)
    let missedOrderSkus = 0;
    let missedOrderU = 0;
    const missedSamples = [];
    for (const [sku, v] of Object.entries(rmhSku)) {
      const rmhU = v.ordered.u || 0;
      if (rmhU <= 0) continue;
      if (lsSkus.has(sku) || datatailOrderedBySku[sku] != null) continue;
      missedOrderSkus += 1;
      missedOrderU += rmhU;
      if (missedSamples.length < 8) missedSamples.push(`${sku}=${rmhU}`);
    }
    // transition overlap: LS-matched SKUs that RMH also ordered
    let overlapOrderSkus = 0;
    let overlapRmhOrderU = 0;
    for (const sku of lsSkus) {
      const rmhU = (rmhSku[sku] && rmhSku[sku].ordered.u) || 0;
      if (rmhU > 0) {
        overlapOrderSkus += 1;
        overlapRmhOrderU += rmhU;
      }
    }
    // Ordered $ reconciliation. spring25/fall25 are pure RMH-era seasons — LS has
    // NO purchase orders (the orders were never migrated; only the products were),
    // so the report's Ordered $ comes entirely from the datatail combine and must
    // reconcile to RMH POType=0 ordered retail $. spring26/fall26 are the crossover
    // (LS orders + RMH-only datatail, deduped) so a raw RMH comparison is expected
    // to differ — informational only.
    // The datatailor import carries ordered $ at TWO levels: a coarse vendor-level
    // total (v.ordered) AND per-product qtyOrdered. The rollup's combine uses the
    // vendor-level total. Measure both (season-gated like the rollup: a vendor is
    // included only if it has ≥1 product whose SKU folds into this season). If the
    // vendor-level total ≈ report but < RMH, the historical hard-pull is INCOMPLETE
    // (a data-source gap RMH can fill), not a code bug.
    let rawProductOrdered = 0;
    let vendorLevelOrdered = 0;
    for (const v of Object.values((override && override.vendors) || {})) {
      const products = (v && v.products) || [];
      const inSeason = products.some(
        (op) => seasonForSku((op.style || "").toLowerCase()) === season
      );
      if (!inSeason) continue;
      vendorLevelOrdered += Number(v.ordered) || 0;
      for (const op of products) {
        if (seasonForSku((op.style || "").toLowerCase()) !== season) continue;
        const q = Number(op.qtyOrdered) || 0;
        const p = Number(op.price) || 0;
        if (q > 0 && p > 0) rawProductOrdered += q * p;
      }
    }
    const lsOrderedUnits = rep.orderedU - datatailOrderedU;
    const isRmhOnlySeason = lsOrderedUnits === 0;
    const ordRetailDelta = reportDollars.ordered - r.ordered.r;
    const ordRetailPct = r.ordered.r > 0 ? Math.abs(ordRetailDelta) / r.ordered.r : 0;
    // CODE-CORRECTNESS gate (must pass): for an RMH-only season the report's
    // Ordered $ must surface the FULL datatail vendor-level total — i.e. the
    // combine/overlap logic must not silently DROP datatail ordered dollars. (This
    // is what the hasLsPoActivity fix restored: returns no longer flag overlap.)
    const combineOk = !isRmhOnlySeason || Math.abs(reportDollars.ordered - vendorLevelOrdered) <= 1;
    // It must also never EXCEED RMH for an RMH-only season (would mean double-count).
    const noDoubleCount = !isRmhOnlySeason || ordRetailDelta <= 5000;
    if (!combineOk || !noDoubleCount) ordersOk = false;
    // DATA-SOURCE completeness (warning, not a code failure): the datatailor
    // hard-pull may be short of RMH truth. Fixable only by an RMH ordered backfill.
    const sourceComplete = !isRmhOnlySeason || vendorLevelOrdered >= r.ordered.r * 0.95;

    lines.push(`\n[${season}]  rows=${rows.length}`);
    lines.push(lsScanRetLine);
    lines.push(overlapLine);
    lines.push(
      `  RETURN-SRC  ls-rows ${lsRet}u  datatail-only ${datatailRet}u  | ` +
        `${collisions.length} SKUs counted in >1 row (${collisionUnits}u): ` +
        collisions
          .slice(0, 6)
          .map(([k, a]) => `${k}[${a.join(",")}]`)
          .join(" ")
    );
    lines.push(
      `  RETURNED   report ${String(rep.returnedU).padStart(6)}u ${money(rep.returnedR).padStart(11)} retail   ` +
        `RMH POType3 ${String(r.returns.u).padStart(6)}u   union(LS+RMH-only)=${expectedUnion}u   ` +
        `Δvs-union=${unionDelta}  ${Math.abs(unionDelta) <= 2 && !rmhExactBad ? "OK" : "<-- CHECK"}`
    );
    lines.push(
      `  ORDERED $  report ${money(reportDollars.ordered).padStart(12)} retail   ` +
        `RMH POType0 ${money(r.ordered.r).padStart(12)} retail   ` +
        `Δ=${money(ordRetailDelta)} (${(ordRetailPct * 100).toFixed(1)}%)   ` +
        (isRmhOnlySeason
          ? `[RMH-only] combine ${combineOk && noDoubleCount ? "OK" : "<-- CODE CHECK"}; source ${sourceComplete ? "complete" : "INCOMPLETE (backfill)"}`
          : `[crossover: LS+datatail deduped — RMH comparison informational]`)
    );
    lines.push(
      `    datatail ordered $: vendor-level ${money(vendorLevelOrdered)}  per-product ${money(rawProductOrdered)}  ` +
        `vs RMH ${money(r.ordered.r)}  → ${vendorLevelOrdered >= r.ordered.r * 0.95 ? "import covers RMH" : "HARD-PULL INCOMPLETE (RMH-fillable)"}`
    );
    lines.push(
      `  ORDERED u  report ${String(rep.orderedU).padStart(6)}u (LS PO ${lsOrderedUnits}u + datatail-only-row ${datatailOrderedU}u)   ` +
        `RMH POType0 ${String(r.ordered.u).padStart(6)}u   ` +
        `(units shown for context; $ is the reconciled metric)`
    );
    lines.push(
      `    transition overlap (LS-matched SKUs RMH also ordered): ${overlapOrderSkus} skus / RMH ${overlapRmhOrderU}u; ` +
        `RMH-only-SKU orders in no row: ${missedOrderU}u/${missedOrderSkus}skus` +
        (missedSamples.length ? `  e.g. ${missedSamples.slice(0, 4).join(" ")}` : "")
    );
    lines.push(
      `  RECEIVED $ report ${money(reportDollars.received).padStart(12)} retail   ` +
        `(LS PO net + consignment/migrated fallback; RMH PO received qty is 0 → not reconcilable vs RMH)`
    );
    lines.push(
      `  SOLD ${String(rep.soldU).padStart(6)}u   ON-SALE ${String(rep.onSaleU).padStart(6)}u   ON-HAND ${String(rep.onHandU).padStart(7)}u`
    );
    const snap = snapSales && snapSales.seasons[season];
    if (snap) {
      const hasNetBuckets = !!(snap.soldNet || snap.onSaleNet);
      const rmhSoldGross = Math.round((snap.sold && snap.sold.u) || 0);
      const rmhOnSaleGross = Math.round((snap.onSale && snap.onSale.u) || 0);
      const rmhReturns = Math.round((snap.custReturns && snap.custReturns.u) || 0);
      const rmhSold = Math.round((snap.soldNet && snap.soldNet.u) || 0);
      const rmhOnSale = Math.round((snap.onSaleNet && snap.onSaleNet.u) || 0);
      const repTotal = rep.soldU + rep.onSaleU;
      const rmhTotal = hasNetBuckets
        ? rmhSold + rmhOnSale
        : rmhSoldGross + rmhOnSaleGross - rmhReturns;
      const pct = rmhTotal > 0 ? ((repTotal - rmhTotal) / rmhTotal) * 100 : 0;
      let soldNote = "OK";
      if (pct <= -5) soldNote = "← LS migration-window gap (early RMH sales not all migrated)";
      else if (pct >= 5)
        soldNote = "(report > RMH — current LS-era season, LS is the live source: expected)";
      lines.push(
        `    vs RMH snapshot  net sold+on-sale ${rmhTotal}u` +
          (hasNetBuckets
            ? ` (sold ${rmhSold}u / on-sale ${rmhOnSale}u)`
            : ` (gross ${rmhSoldGross + rmhOnSaleGross}u - customer returns ${rmhReturns}u)`) +
          `  | report sold+onsale ${repTotal}u (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)  ${soldNote}`
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    "\n=== RMH-season accuracy (report rollup replayed vs RMH) ===" +
      lines.join("\n") +
      "\n\nNOTE: RETURNED must equal the DEDUPED UNION of LS returns (type=RETURN," +
      "\ncaptured by the scan) + RMH-only returns (override backfill). It is NOT" +
      "\nexpected to equal RMH POType=3 alone — LS holds returns RMH never had, and" +
      "\nthe per-pid LS-wins/max guard collapses the transition overlap." +
      "\n\nORDERED is reconciled per-SKU (crossover-aware): datatail-only ordered must" +
      "\ntrack RMH POType=0 for the same SKUs (override integrity), RMH-only SKUs in" +
      "\nno report row are missed orders, and LS-matched SKUs RMH also ordered are the" +
      "\ntransition overlap (report uses LS by design). RECEIVED post-crossover is" +
      "\nsourced from LS POs (source of truth); RMH POType0 received shown for context." +
      (snapSales
        ? `\n\nSOLD/ON-SALE compared to the frozen RMH snapshot (${snapSales.dir}). Sales were` +
          "\nmigrated into LS; RMH comparison is NET of customer returns (new snapshots" +
          "\ncarry soldNet/onSaleNet; older snapshots fall back to gross minus returns)." +
          "\nA shortfall = LS migration-window gap. Closed seasons only."
        : "\n\n(no RMH snapshot found — run scripts/rmh-snapshot.mjs for sold reconciliation)") +
      "\n"
  );

  expect(returnsOk).toBe(true);
  expect(ordersOk).toBe(true);
}, 240000);
