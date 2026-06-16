#!/usr/bin/env node
/*
 * READ-ONLY diagnostic: compare RMH POType=0 (placed) ordered against the
 * datatail override baseline already in KV, per season. NO WRITES.
 *
 * Purpose: the spring25 Ordered column is ~34% under RMH truth because the
 * one-time datatailor scrape was incomplete. Before backfilling we need to know
 * the SHAPE of the gap so the fix can't double-count (the rollup sums override
 * records per vendor bucket):
 *   - Are whole SKUs missing from the override?  -> safe to ADD them.
 *   - Are the same SKUs present but undercounted? -> must REPLACE, not add.
 *
 * Output per season:
 *   - RMH POType=0 ordered retail/cost/units (all + placed-only), # SKUs.
 *   - Override total of the top-level vendor `ordered` $ (what the rollup shows
 *     for a no-LS season) AND the per-product sum(qtyOrdered*price).
 *   - SKU overlap: RMH SKUs missing from the override (+ their $), RMH SKUs
 *     present in the override, and the placed-ordered $ on each set.
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is unreachable from Vercel).
 * REQUIREMENTS: FreeTDS `tsql`; .env.rmh (HOST/USER/PASS/DATABASE/PORT);
 *   .env.local (KV_REST_API_URL + KV_REST_API_TOKEN).
 *
 * USAGE:
 *   node scripts/diff-rmh-ordered.mjs [--seasons spring25,fall25]
 *   node scripts/diff-rmh-ordered.mjs --seasons spring26 --crossover
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const CROSSOVER = argv.includes("--crossover");
const seasonsArg = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
})();
const SEASONS = seasonsArg || ["spring25", "fall25"];

const TAB = String.fromCharCode(9);
const SHARDED_OBJECT_VERSION = 1;

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
  CAST(SUM(POE.QuantityOrdered) AS varchar(20)),
  CAST(SUM(CASE WHEN PO.IsPlaced = 1 THEN POE.QuantityOrdered ELSE 0 END) AS varchar(20)),
  CAST(MAX(I.Price) AS varchar(20)),
  CAST(MAX(I.Cost) AS varchar(20)),
  ISNULL(CAST(I.SupplierID AS varchar(20)),''),
  ISNULL(REPLACE(S.SupplierName, CHAR(9), ' '),''))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
LEFT JOIN Supplier S ON S.ID = I.SupplierID
WHERE PO.POType = 0 AND CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY I.ItemLookupCode, I.SupplierID, S.SupplierName;
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
    { input: RMH_SQL, encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 }
  );
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 7) continue;
    if (!f[0].includes("/")) continue;
    rows.push({
      sku: f[0].trim().toLowerCase(),
      qtyAll: parseInt(f[1], 10) || 0,
      qtyPlaced: parseInt(f[2], 10) || 0,
      price: parseFloat(f[3]) || 0,
      cost: parseFloat(f[4]) || 0,
      supplierId: f[5].trim() || "0",
      supplierName: f[6].trim() || "Unknown",
    });
  }
  return rows;
}

async function loadOverrideSkus(season) {
  const { kv } = await import("@vercel/kv");
  const parse = (v) => (v ? (typeof v === "string" ? JSON.parse(v) : v) : null);
  const index = parse(await kv.get(`scan:override:${season}:vendorIndex`)) || [];
  const skuOrdered = new Map(); // sku -> per-product qtyOrdered*price
  const skuSet = new Set();
  let topLevelOrdered = 0;
  let records = 0;
  for (const key of index) {
    const rec = parse(await kv.get(`scan:override:${season}:v:${key}`));
    if (!rec) continue;
    records += 1;
    topLevelOrdered += Number(rec.ordered) || 0;
    for (const p of rec.products || []) {
      const sku = String(p.style || "")
        .toLowerCase()
        .trim();
      if (!sku) continue;
      skuSet.add(sku);
      const val = (Number(p.qtyOrdered) || 0) * (Number(p.price) || 0);
      skuOrdered.set(sku, (skuOrdered.get(sku) || 0) + val);
    }
  }
  return { index, records, topLevelOrdered, skuSet, skuOrdered };
}

async function loadOverrideRecords(kv, season) {
  const parse = (v) => (v ? (typeof v === "string" ? JSON.parse(v) : v) : null);
  const index = parse(await kv.get(`scan:override:${season}:vendorIndex`)) || [];
  const records = {};
  for (const key of index) {
    records[key] = parse(await kv.get(`scan:override:${season}:v:${key}`));
  }
  return { index, records };
}

async function loadShardedObject(kv, key) {
  const marker = await kv.get(key);
  if (!marker) return null;
  if (!(marker && marker.sharded === true && marker.version === SHARDED_OBJECT_VERSION)) {
    return typeof marker === "string" ? JSON.parse(marker) : marker;
  }
  const shards = await Promise.all(
    Array.from({ length: marker.shardCount || 16 }, (_, index) => kv.get(`${key}:shard:${index}`))
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

function isBackfillKey(key) {
  return /^rmh(cost|ret|ord|sold)__/.test(key);
}

function hasLsPoActivity(sku, scanData) {
  const pid = scanData?.skuToPid?.[sku];
  const ps = pid != null ? scanData?.productStats?.[pid] : null;
  return !!(ps && ((Number(ps.qtyOrdered) || 0) > 0 || (Number(ps.qtyReceived) || 0) > 0));
}

function lsOrderedRetail(scanData, season) {
  let total = 0;
  for (const pid of scanData?.seasonPids || []) {
    const sku = String(scanData?.pidToSku?.[pid] || "").toLowerCase();
    if (seasonForSku(sku) !== season) continue;
    const ps = scanData?.productStats?.[pid] || {};
    total += (Number(ps.qtyOrdered) || 0) * (Number(scanData?.pidToPrice?.[pid]) || 0);
  }
  return total;
}

async function printCrossoverDiagnostic(season, rmh) {
  const { kv } = await import("@vercel/kv");
  const [override, scanData] = await Promise.all([
    loadOverrideRecords(kv, season),
    loadShardedObject(kv, `scan:data:${season}`),
  ]);
  if (!scanData) throw new Error(`No scan:data found for ${season}`);

  const originalKeys = override.index.filter((key) => !isBackfillKey(key) && override.records[key]);
  const skuToKey = new Map();
  for (const key of originalKeys) {
    for (const product of override.records[key].products || []) {
      const sku = String(product.style || "")
        .toLowerCase()
        .trim();
      if (sku && seasonForSku(sku) === season && !skuToKey.has(sku)) skuToKey.set(sku, key);
    }
  }

  const byKey = new Map();
  let overlapSkus = 0;
  let overlapRetail = 0;
  let rmhOnlySkus = 0;
  let rmhOnlyRetail = 0;
  let residualSkus = 0;
  let residualRetail = 0;
  for (const r of rmh) {
    if ((Number(r.qtyPlaced) || 0) <= 0) continue;
    const retail = r.qtyPlaced * r.price;
    const key = skuToKey.get(r.sku);
    const entry = key
      ? byKey.get(key) || { overlapSkus: 0, overlapRetail: 0, rmhOnlySkus: 0, rmhOnlyRetail: 0 }
      : null;
    if (hasLsPoActivity(r.sku, scanData)) {
      overlapSkus += 1;
      overlapRetail += retail;
      if (entry) {
        entry.overlapSkus += 1;
        entry.overlapRetail += retail;
      }
    } else {
      rmhOnlySkus += 1;
      rmhOnlyRetail += retail;
      if (entry) {
        entry.rmhOnlySkus += 1;
        entry.rmhOnlyRetail += retail;
      } else {
        residualSkus += 1;
        residualRetail += retail;
      }
    }
    if (entry) byKey.set(key, entry);
  }

  let overlapBuckets = 0;
  let noOverlapBuckets = 0;
  for (const entry of byKey.values()) {
    if (entry.overlapSkus > 0) overlapBuckets += 1;
    else noOverlapBuckets += 1;
  }
  const lsOrdered = lsOrderedRetail(scanData, season);
  const target = lsOrdered + rmhOnlyRetail;
  const currentTopLevel = originalKeys.reduce(
    (sum, key) => sum + (Number(override.records[key].ordered) || 0),
    0
  );

  console.warn(`CROSSOVER diagnostic (${season})`);
  console.warn(`  Original override records:       ${originalKeys.length}`);
  console.warn(`  Buckets with LS PO overlap:      ${overlapBuckets}`);
  console.warn(`  Buckets with no LS PO overlap:   ${noOverlapBuckets}`);
  console.warn(`  RMH placed overlap SKUs/$:       ${overlapSkus} / ${money(overlapRetail)}`);
  console.warn(`  RMH-only SKUs/$:                 ${rmhOnlySkus} / ${money(rmhOnlyRetail)}`);
  console.warn(`  Residual RMH-only SKUs/$:        ${residualSkus} / ${money(residualRetail)}`);
  console.warn(`  LS ordered retail already kept:  ${money(lsOrdered)}`);
  console.warn(`  Current override top-level $:    ${money(currentTopLevel)}`);
  console.warn(`  Deduped union target $:          ${money(target)}`);
  console.warn(
    `  RMH placed truth $:              ${money(rmh.reduce((s, r) => s + r.qtyPlaced * r.price, 0))}`
  );
  console.warn("");
}

function money(n) {
  return "$" + Math.round(n).toLocaleString();
}

async function main() {
  const rmhAll = queryRmh();
  console.warn(`RMH POType=0 SKU rows (all seasons): ${rmhAll.length}\n`);

  for (const season of SEASONS) {
    const rmh = rmhAll.filter((r) => seasonForSku(r.sku) === season);
    const rmhRetailAll = rmh.reduce((s, r) => s + r.qtyAll * r.price, 0);
    const rmhRetailPlaced = rmh.reduce((s, r) => s + r.qtyPlaced * r.price, 0);
    const rmhCostPlaced = rmh.reduce((s, r) => s + r.qtyPlaced * r.cost, 0);
    const rmhUnitsPlaced = rmh.reduce((s, r) => s + r.qtyPlaced, 0);

    const ov = await loadOverrideSkus(season);

    // SKU overlap (placed RMH $).
    let missingSkus = 0;
    let missingRetail = 0;
    let presentSkus = 0;
    let presentRetail = 0;
    for (const r of rmh) {
      const placedRetail = r.qtyPlaced * r.price;
      if (ov.skuSet.has(r.sku)) {
        presentSkus += 1;
        presentRetail += placedRetail;
      } else {
        missingSkus += 1;
        missingRetail += placedRetail;
      }
    }

    console.warn(`================ ${season} ================`);
    console.warn(`RMH POType=0 SKUs:            ${rmh.length}`);
    console.warn(`RMH ordered retail (all):     ${money(rmhRetailAll)}`);
    console.warn(`RMH ordered retail (placed):  ${money(rmhRetailPlaced)}`);
    console.warn(`RMH ordered cost   (placed):  ${money(rmhCostPlaced)}`);
    console.warn(`RMH ordered units  (placed):  ${rmhUnitsPlaced.toLocaleString()}`);
    console.warn(`--`);
    console.warn(`Override vendor records:      ${ov.records}`);
    console.warn(
      `Override top-level ordered $: ${money(ov.topLevelOrdered)}  <- what the report shows (no-LS season)`
    );
    console.warn(
      `Override per-product ordered: ${money([...ov.skuOrdered.values()].reduce((s, v) => s + v, 0))}`
    );
    console.warn(`Override distinct SKUs:        ${ov.skuSet.size}`);
    console.warn(`--`);
    console.warn(
      `RMH SKUs ALREADY in override: ${presentSkus}  (${money(presentRetail)} placed retail)`
    );
    console.warn(
      `RMH SKUs MISSING from override: ${missingSkus}  (${money(missingRetail)} placed retail)`
    );
    console.warn(
      `Gap (RMH placed - override top-level): ${money(rmhRetailPlaced - ov.topLevelOrdered)}\n`
    );
    if (CROSSOVER) await printCrossoverDiagnostic(season, rmh);
  }

  console.warn("READ-ONLY diagnostic complete. No KV writes were made.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
