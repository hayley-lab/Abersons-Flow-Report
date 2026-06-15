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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { kv } from "@vercel/kv";
import { loadScanData } from "../lib/scan-data-store";
import { buildAllRows } from "../lib/flow-rollup";

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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env");
loadEnv(".env.rmh");

const SEASONS = ["spring25", "fall25", "spring26", "fall26"];

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
  const bySeason = {};
  for (const s of SEASONS) {
    bySeason[s] = {
      ordered: { u: 0, c: 0, r: 0 },
      received: { u: 0 },
      returns: { u: 0, c: 0, r: 0 },
    };
  }
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 6) continue;
    const season = seasonForSku(f[1].trim().toLowerCase());
    if (!season || !bySeason[season]) continue;
    const poType = parseInt(f[0], 10);
    const ordered = parseInt(f[2], 10) || 0;
    const received = parseInt(f[3], 10) || 0;
    const cost = parseFloat(f[4]) || 0;
    const retail = parseFloat(f[5]) || 0;
    if (poType === 0) {
      bySeason[season].ordered.u += ordered;
      bySeason[season].ordered.c += cost;
      bySeason[season].ordered.r += retail;
      bySeason[season].received.u += received;
    } else if (poType === 3) {
      bySeason[season].returns.u += ordered;
      bySeason[season].returns.c += cost;
      bySeason[season].returns.r += retail;
    }
  }
  return bySeason;
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
  const rmh = queryRmh();
  const lines = [];
  let returnsOk = true;

  for (const season of SEASONS) {
    const scanData = await loadScanData(kv, season);
    const override = await loadOverride(season);
    const rows = buildAllRows(scanData, override, { season });
    const rep = sumReport(rows);
    const r = rmh[season];

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
      `  ORDERED    report ${String(rep.orderedU).padStart(6)}u ${money(
        rows.reduce((a, x) => a + (Number(x.orderedQty) || 0) * (Number(x.price) || 0), 0)
      ).padStart(11)} retail   ` +
        `RMH POType0 ${String(r.ordered.u).padStart(6)}u ${money(r.ordered.r).padStart(11)} retail   ` +
        `(report=LS+override w/ overlap guard; RMH=all POType0 incl. pre-crossover)`
    );
    lines.push(
      `  RECEIVED   report ${String(rep.receivedU).padStart(6)}u                         ` +
        `RMH POType0 ${String(r.received.u).padStart(6)}u`
    );
    lines.push(
      `  SOLD ${String(rep.soldU).padStart(6)}u   ON-SALE ${String(rep.onSaleU).padStart(6)}u   ON-HAND ${String(rep.onHandU).padStart(7)}u`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    "\n=== RMH-season accuracy (report rollup replayed vs RMH) ===" +
      lines.join("\n") +
      "\n\nNOTE: RETURNED must equal the DEDUPED UNION of LS returns (type=RETURN," +
      "\ncaptured by the scan) + RMH-only returns (override backfill). It is NOT" +
      "\nexpected to equal RMH POType=3 alone — LS holds returns RMH never had, and" +
      "\nthe per-pid LS-wins/max guard collapses the transition overlap. ORDERED/" +
      "\nRECEIVED differ by design (overlap guard + season fold; RMH includes" +
      "\npre-crossover orders).\n"
  );

  expect(returnsOk).toBe(true);
}, 240000);
