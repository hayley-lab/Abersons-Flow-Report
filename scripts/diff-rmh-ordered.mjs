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
 * USAGE: node scripts/diff-rmh-ordered.mjs [--seasons spring25,fall25]
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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
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

const TAB = String.fromCharCode(9);

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
      const sku = String(p.style || "").toLowerCase().trim();
      if (!sku) continue;
      skuSet.add(sku);
      const val = (Number(p.qtyOrdered) || 0) * (Number(p.price) || 0);
      skuOrdered.set(sku, (skuOrdered.get(sku) || 0) + val);
    }
  }
  return { index, records, topLevelOrdered, skuSet, skuOrdered };
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
    console.warn(`Override top-level ordered $: ${money(ov.topLevelOrdered)}  <- what the report shows (no-LS season)`);
    console.warn(`Override per-product ordered: ${money([...ov.skuOrdered.values()].reduce((s, v) => s + v, 0))}`);
    console.warn(`Override distinct SKUs:        ${ov.skuSet.size}`);
    console.warn(`--`);
    console.warn(`RMH SKUs ALREADY in override: ${presentSkus}  (${money(presentRetail)} placed retail)`);
    console.warn(`RMH SKUs MISSING from override: ${missingSkus}  (${money(missingRetail)} placed retail)`);
    console.warn(
      `Gap (RMH placed - override top-level): ${money(rmhRetailPlaced - ov.topLevelOrdered)}\n`
    );
  }

  console.warn("READ-ONLY diagnostic complete. No KV writes were made.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
