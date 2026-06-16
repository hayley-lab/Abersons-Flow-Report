#!/usr/bin/env node
/*
 * READ-ONLY diagnostic: compare RMH net sold/on-sale sales against the current
 * report data in KV for the closed RMH-era seasons. NO WRITES.
 *
 * Purpose: spring25/fall25 Sold + On-Sale are low because not every RMH sale was
 * migrated into Lightspeed. Before backfilling, measure where the gap lands:
 *   - LS-matched pids, where the rollup will need a request-time overlay.
 *   - Datatail-only SKUs, where the existing override row path may need overlay.
 *   - SKUs with no report row at all.
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is unreachable from Vercel).
 *
 * USAGE:
 *   node scripts/diff-rmh-sold.mjs
 *   node scripts/diff-rmh-sold.mjs --seasons spring25,fall25
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAB = String.fromCharCode(9);

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
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env");
loadEnv(".env.rmh");

const argv = process.argv.slice(2);
const seasonsArg = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
})();
const SEASONS = seasonsArg || ["spring25", "fall25"];

function num(x) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

function seasonForSku(sku) {
  const seg = sku.includes("/") ? sku.split("/")[1].toLowerCase() : "";
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return null;
}

const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  ISNULL(CAST(I.SupplierID AS varchar(20)),''),
  ISNULL(REPLACE(S.SupplierName, CHAR(9), ' '),''),
  ISNULL(CAST(I.DepartmentID AS varchar(20)),''),
  ISNULL(REPLACE(D.Name, CHAR(9), ' '),''),
  ISNULL(CAST(I.Cost AS varchar(20)),'0'),
  ISNULL(CAST(I.Price AS varchar(20)),'0'),
  CAST(SUM(CASE WHEN TE.Price >= TE.FullPrice THEN TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Price < TE.FullPrice THEN TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Price < TE.FullPrice THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
  CAST(SUM(CASE WHEN TE.Quantity < 0 THEN -TE.Quantity ELSE 0 END) AS varchar(20)),
  ISNULL(REPLACE(REPLACE(I.Description, CHAR(9), ' '), CHAR(10), ' '),''))
FROM TransactionEntry TE
JOIN Item I ON I.ID = TE.ItemID
LEFT JOIN Supplier S ON S.ID = I.SupplierID
LEFT JOIN Department D ON D.ID = I.DepartmentID
WHERE CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY I.ItemLookupCode, I.SupplierID, S.SupplierName, I.DepartmentID, D.Name, I.Cost, I.Price, I.Description;
go
quit
`;

function queryRmh() {
  const { HOST, USER, PASS, DATABASE, PORT } = process.env;
  if (!HOST || !USER || !PASS || !DATABASE) {
    throw new Error("RMH connection env missing (need HOST, USER, PASS, DATABASE in .env.rmh)");
  }
  const out = execFileSync(
    "tsql",
    ["-H", HOST, "-p", PORT || "1433", "-U", USER, "-P", PASS, "-D", DATABASE],
    { input: RMH_SQL, encoding: "utf8", timeout: 180_000, maxBuffer: 256 * 1024 * 1024 }
  );
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 12) continue;
    if (!f[0].includes("/")) continue;
    const sold = num(f[7]);
    const onSale = num(f[8]);
    const saleAmt = num(f[9]);
    if (sold === 0 && onSale === 0 && saleAmt === 0) continue;
    rows.push({
      sku: f[0].trim().toLowerCase(),
      supplierId: f[1].trim() || "0",
      supplierName: f[2].trim() || "Unknown",
      deptId: f[3].trim() || "0",
      deptName: f[4].trim() || "",
      cost: num(f[5]),
      price: num(f[6]),
      sold,
      onSale,
      saleAmt,
      custReturnQty: num(f[10]),
      description: f[11].trim(),
    });
  }
  return rows;
}

const parse = (v) => (v ? (typeof v === "string" ? JSON.parse(v) : v) : null);
const isSharded = (v) => !!(v && typeof v === "object" && v.sharded === true && v.version === 1);

async function loadShardedKv(kv, baseKey) {
  const marker = await kv.get(baseKey);
  if (!marker) return null;
  if (!isSharded(marker)) return parse(marker);
  const shardCount = marker.shardCount || 16;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => kv.get(`${baseKey}:shard:${i}`))
  );
  const result = { ...(marker.scalar || {}) };
  for (const field of marker.pidFields || []) result[field] = result[field] || {};
  for (const field of marker.skuToPidFields || []) result[field] = result[field] || {};
  for (const shard of shards) {
    for (const [pid, record] of Object.entries(shard?.records || {})) {
      for (const [field, value] of Object.entries(record || {})) {
        if ((marker.skuToPidFields || []).includes(field)) {
          result[field] = { ...(result[field] || {}), ...(value || {}) };
        } else {
          result[field] = result[field] || {};
          result[field][pid] = value;
        }
      }
    }
  }
  return result;
}

async function loadOverride(kv, season) {
  const index = parse(await kv.get(`scan:override:${season}:vendorIndex`)) || [];
  const vendors = {};
  const skuSet = new Set();
  const datatailSalesBySku = {};
  for (const key of index) {
    const rec = parse(await kv.get(`scan:override:${season}:v:${key}`));
    if (!rec) continue;
    vendors[key] = rec;
    for (const op of rec.products || []) {
      const sku = String(op.style || "")
        .toLowerCase()
        .trim();
      if (!sku) continue;
      skuSet.add(sku);
      const sold = num(op.qtySold);
      const onSale = num(op.qtySale);
      if (sold || onSale) {
        datatailSalesBySku[sku] = {
          sold: (datatailSalesBySku[sku]?.sold || 0) + sold,
          onSale: (datatailSalesBySku[sku]?.onSale || 0) + onSale,
        };
      }
    }
  }
  return { vendors, skuSet, datatailSalesBySku };
}

function fmt(n) {
  return Math.round(n).toLocaleString();
}

function samplePush(samples, text) {
  if (samples.length < 8) samples.push(text);
}

async function main() {
  const { kv } = await import("@vercel/kv");
  const rmhAll = queryRmh();
  console.warn(`RMH net sales SKU rows (all seasons): ${rmhAll.length}\n`);

  for (const season of SEASONS) {
    const scanData = await loadShardedKv(kv, `scan:data:${season}`);
    const override = await loadOverride(kv, season);
    const skuToPid = scanData?.skuToPid || {};
    const productStats = scanData?.productStats || {};
    const seasonPids = new Set((scanData?.seasonPids || []).map(String));
    const rmhRows = rmhAll.filter((r) => seasonForSku(r.sku) === season);

    let rmhSold = 0;
    let rmhOnSale = 0;
    let rmhSaleAmt = 0;
    let reportSold = 0;
    let reportOnSale = 0;
    let matchedRmhUnits = 0;
    let matchedLsUnits = 0;
    let matchedGapUnits = 0;
    let lsGreaterPids = 0;
    let lsGreaterUnits = 0;
    let datatailOnlyUnits = 0;
    let noRowUnits = 0;
    const lsGreaterSamples = [];
    const noRowSamples = [];

    for (const pid of seasonPids) {
      const ps = productStats[pid] || {};
      reportSold += num(ps.sold);
      reportOnSale += num(ps.onSale);
    }
    for (const [sku, q] of Object.entries(override.datatailSalesBySku)) {
      if (skuToPid[sku] != null) continue;
      reportSold += q.sold || 0;
      reportOnSale += q.onSale || 0;
    }

    for (const r of rmhRows) {
      const rmhTotal = r.sold + r.onSale;
      rmhSold += r.sold;
      rmhOnSale += r.onSale;
      rmhSaleAmt += r.saleAmt;

      const pid = skuToPid[r.sku];
      if (pid != null) {
        const ps = productStats[pid] || {};
        const lsTotal = num(ps.sold) + num(ps.onSale);
        matchedRmhUnits += rmhTotal;
        matchedLsUnits += lsTotal;
        if (rmhTotal >= lsTotal) matchedGapUnits += rmhTotal - lsTotal;
        else {
          lsGreaterPids += 1;
          lsGreaterUnits += lsTotal - rmhTotal;
          samplePush(lsGreaterSamples, `${r.sku}: LS ${lsTotal} > RMH ${rmhTotal}`);
        }
      } else if (override.skuSet.has(r.sku)) {
        datatailOnlyUnits += rmhTotal;
      } else {
        noRowUnits += rmhTotal;
        samplePush(noRowSamples, `${r.sku}=${rmhTotal}`);
      }
    }

    const rmhTotal = rmhSold + rmhOnSale;
    const reportTotal = reportSold + reportOnSale;
    const pct = rmhTotal ? ((reportTotal - rmhTotal) / rmhTotal) * 100 : 0;
    console.warn(`================ ${season} ================`);
    console.warn(
      `RMH net sold/on-sale:      ${fmt(rmhTotal)}u (sold ${fmt(rmhSold)} / on-sale ${fmt(rmhOnSale)})`
    );
    console.warn(`RMH discounted saleAmt:    $${fmt(rmhSaleAmt)}`);
    console.warn(
      `Current report total:      ${fmt(reportTotal)}u (sold ${fmt(reportSold)} / on-sale ${fmt(reportOnSale)})`
    );
    console.warn(`Gap:                       ${fmt(reportTotal - rmhTotal)}u (${pct.toFixed(1)}%)`);
    console.warn(`--`);
    console.warn(`LS-matched RMH units:      ${fmt(matchedRmhUnits)}u`);
    console.warn(`LS current on same pids:   ${fmt(matchedLsUnits)}u`);
    console.warn(`Fillable matched gap:      ${fmt(matchedGapUnits)}u`);
    console.warn(`LS > RMH pids:             ${lsGreaterPids} (${fmt(lsGreaterUnits)}u)`);
    if (lsGreaterSamples.length) console.warn(`  e.g. ${lsGreaterSamples.join(" | ")}`);
    console.warn(`Datatail-only RMH units:   ${fmt(datatailOnlyUnits)}u`);
    console.warn(`No-report-row RMH units:   ${fmt(noRowUnits)}u`);
    if (noRowSamples.length) console.warn(`  e.g. ${noRowSamples.join(" | ")}`);
    console.warn("");
  }

  console.warn("READ-ONLY diagnostic complete. No KV writes were made.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
