#!/usr/bin/env node
/*
 * LOCAL backfill of authoritative RMH per-item COST into the durable override
 * baseline, so the report can fill $0 ordered/received cost for migrated
 * products that Lightspeed never carried a cost for.
 *
 * WHY: the orderedCostGap KPI counts LS-matched rows that have an ordered qty
 * but $0 cost (the LS catalog returned no cost). RMH has authoritative
 * Item.Cost. We provide it as a per-SKU fallback the rollup already consumes
 * (lib/flow-rollup.js overridePricesByPid -> costByPid; lsRowFromPid cost =
 * preferPositive(pidToCost, overrideCostByPid)). NO code change is required.
 *
 * SAFETY (why this can't double-count or distort other columns):
 *   - Records carry NO qty (qtyOrdered/qtyStock/qtySold/qtySale/qtyReturned = 0),
 *     so they add ZERO ordered/received/returned units or dollars. They only
 *     supply a cost (and price) FALLBACK via preferPositive — existing LS or
 *     datatailor cost always wins.
 *   - Gated to SKUs that have a real RMH POType=0 ORDER (an actual purchase).
 *     Consignment / migrated goods have no POType=0 order, so they are excluded
 *     and keep their $0 received cost (per the consignment netting rule).
 *   - Idempotent: stable key per (season, dept, supplier); re-running overwrites.
 *
 * Crossover note: LS-native products ordered after the 2025-12-19 LS go-live
 * already carry LS cost (preferPositive keeps it); RMH only fills genuine $0s.
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is unreachable from Vercel).
 *
 * REQUIREMENTS: FreeTDS `tsql`; .env.rmh (HOST/USER/PASS/DATABASE/PORT);
 *   .env.local (KV_REST_API_URL + KV_REST_API_TOKEN).
 *
 * USAGE:
 *   node scripts/backfill-rmh-ordered-cost.mjs            # dry run (no writes)
 *   node scripts/backfill-rmh-ordered-cost.mjs --write    # persist override records
 *   node scripts/backfill-rmh-ordered-cost.mjs --seasons spring26 --write
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
const WRITE = argv.includes("--write");
const seasonsArg = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
})();
const ACTIVE_SEASONS = seasonsArg || ["spring25", "fall25", "spring26", "fall26"];

function seasonForSku(sku) {
  const seg = sku.includes("/") ? sku.split("/")[1].toLowerCase() : "";
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return null;
}

const TAB = String.fromCharCode(9);
// Only SKUs with a real POType=0 order and a positive cost. Item.Cost/Price are
// per-item, so MAX is just a deterministic pick.
const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  ISNULL(CAST(I.SupplierID AS varchar(20)),''),
  ISNULL(S.SupplierName,''),
  ISNULL(CAST(I.DepartmentID AS varchar(20)),''),
  ISNULL(D.Name,''),
  CAST(MAX(I.Cost) AS varchar(20)),
  CAST(MAX(I.Price) AS varchar(20)),
  CAST(SUM(POE.QuantityOrdered) AS varchar(20)),
  ISNULL(REPLACE(REPLACE(I.Description, CHAR(9), ' '), CHAR(10), ' '),''))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
LEFT JOIN Supplier S ON S.ID = I.SupplierID
LEFT JOIN Department D ON D.ID = I.DepartmentID
WHERE PO.POType = 0 AND CHARINDEX('/', I.ItemLookupCode) > 0 AND I.Cost > 0
GROUP BY I.ItemLookupCode, I.SupplierID, S.SupplierName, I.DepartmentID, D.Name, I.Description;
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
    { input: RMH_SQL, encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 * 1024 }
  );
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 9) continue;
    if (!f[0].includes("/")) continue;
    const cost = parseFloat(f[5]) || 0;
    if (cost <= 0) continue;
    rows.push({
      sku: f[0].trim().toLowerCase(),
      supplierId: f[1].trim() || "0",
      supplierName: f[2].trim() || "Unknown",
      deptId: f[3].trim() || "0",
      deptName: f[4].trim() || "",
      cost,
      price: parseFloat(f[6]) || 0,
      qtyOrdered: parseInt(f[7], 10) || 0,
      description: f[8].trim(),
    });
  }
  return rows;
}

function buildOverridesBySeason(rows) {
  const bySeason = {};
  for (const r of rows) {
    const season = seasonForSku(r.sku);
    if (!season || !ACTIVE_SEASONS.includes(season)) continue;
    if (!bySeason[season]) bySeason[season] = {};
    const key = `rmhcost__${r.deptId}__${r.supplierId}`;
    if (!bySeason[season][key]) {
      bySeason[season][key] = {
        vendorId: r.supplierId,
        vendorName: r.supplierName,
        deptId: r.deptId,
        deptName: r.deptName,
        ordered: 0,
        received: 0,
        sold: 0,
        source: "rmh-ordered-cost-backfill",
        products: [],
      };
    }
    // Cost/price ONLY — every qty is 0 so this record adds no units/dollars,
    // it just supplies the cost+price fallback the rollup reads.
    bySeason[season][key].products.push({
      style: r.sku,
      description: r.description,
      cost: r.cost,
      price: r.price,
      qtyOrdered: 0,
      qtyStock: 0,
      qtySold: 0,
      qtySale: 0,
      qtyReturned: 0,
    });
  }
  return bySeason;
}

function summarize(bySeason) {
  for (const season of ACTIVE_SEASONS) {
    const vendors = bySeason[season] || {};
    let skus = 0;
    let costSum = 0;
    for (const v of Object.values(vendors)) {
      for (const p of v.products) {
        skus += 1;
        costSum += p.cost;
      }
    }
    console.warn(
      `[${season}] vendors=${Object.keys(vendors).length} cost-skus=${skus} avg_cost=$${(skus ? costSum / skus : 0).toFixed(0)}`
    );
  }
}

async function writeOverrides(bySeason) {
  const { kv } = await import("@vercel/kv");
  for (const season of ACTIVE_SEASONS) {
    const vendors = bySeason[season];
    if (!vendors || Object.keys(vendors).length === 0) continue;
    const indexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
    const existing = indexRaw
      ? typeof indexRaw === "string"
        ? JSON.parse(indexRaw)
        : indexRaw
      : [];
    const keys = Object.keys(vendors);
    for (const key of keys) {
      await kv.set(`scan:override:${season}:v:${key}`, JSON.stringify(vendors[key]));
    }
    const merged = Array.from(new Set([...existing, ...keys]));
    await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(merged));
    console.warn(`[${season}] wrote ${keys.length} cost override record(s)`);
  }
}

async function main() {
  const rows = queryRmh();
  console.warn(`RMH POType=0 ordered SKUs with cost>0: ${rows.length}`);
  const bySeason = buildOverridesBySeason(rows);
  summarize(bySeason);
  if (!WRITE) {
    console.warn(
      "\nDRY RUN — no KV writes. These records carry cost/price only (no qty), so" +
        "\nthey fill $0 ordered/received cost via preferPositive without changing any" +
        "\nordered/received/returned quantities. Re-run with --write to persist."
    );
    return;
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error("KV write env missing (need KV_REST_API_URL + KV_REST_API_TOKEN in .env.local)");
  }
  await writeOverrides(bySeason);
  console.warn("\nDone. RMH cost fallback written to the durable override baseline.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
