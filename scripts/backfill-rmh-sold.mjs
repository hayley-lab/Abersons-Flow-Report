#!/usr/bin/env node
/*
 * LOCAL backfill of authoritative RMH net sold/on-sale buckets into the durable
 * override baseline for closed RMH-era seasons (spring25/fall25).
 *
 * WHY: not every pre-cutover RMH sale was migrated into Lightspeed. The rollup
 * applies these rmhsold__ records as a whole-source overlay per pid/sku (RMH
 * replaces LS only when RMH has at least as many net sold/on-sale units), so the
 * backfill cannot double-count the subset that LS already carries.
 *
 * SAFETY / REVERSIBILITY:
 *   - Dry-run by default.
 *   - --write first dumps the FULL current override for each season
 *     (vendorIndex + every v:*) to scripts/out/override-backup-<season>-<ts>.json.
 *   - Stable key per (season, dept, supplier): rmhsold__{dept}__{supplier}.
 *   - --revert <backup.json> restores every record + vendorIndex verbatim.
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is unreachable from Vercel).
 *
 * USAGE:
 *   node scripts/backfill-rmh-sold.mjs
 *   node scripts/backfill-rmh-sold.mjs --write
 *   node scripts/backfill-rmh-sold.mjs --seasons spring25,fall25 --write
 *   node scripts/backfill-rmh-sold.mjs --revert scripts/out/override-backup-spring25-<ts>.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "scripts", "out");
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
const WRITE = argv.includes("--write");
const revertIdx = argv.indexOf("--revert");
const REVERT_FILE = revertIdx >= 0 ? argv[revertIdx + 1] : null;
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
  CAST(SUM(CASE WHEN TE.Price >= TE.FullPrice THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
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
    if (f.length < 13) continue;
    if (!f[0].includes("/")) continue;
    const sold = num(f[7]);
    const onSale = num(f[8]);
    const soldAmt = num(f[9]);
    const saleAmt = num(f[10]);
    if (sold === 0 && onSale === 0 && soldAmt === 0 && saleAmt === 0) continue;
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
      soldAmt,
      saleAmt,
      custReturnQty: num(f[11]),
      description: f[12].trim(),
    });
  }
  return rows;
}

function buildOverridesBySeason(rows) {
  const bySeason = {};
  for (const r of rows) {
    const season = seasonForSku(r.sku);
    if (!season || !SEASONS.includes(season)) continue;
    bySeason[season] = bySeason[season] || {};
    const key = `rmhsold__${r.deptId}__${r.supplierId}`;
    if (!bySeason[season][key]) {
      bySeason[season][key] = {
        vendorId: r.supplierId,
        vendorName: r.supplierName,
        deptId: r.deptId,
        deptName: r.deptName,
        ordered: 0,
        received: 0,
        sold: 0,
        source: "rmh-sold-backfill",
        products: [],
      };
    }
    const rec = bySeason[season][key];
    rec.sold += r.soldAmt;
    rec.products.push({
      style: r.sku,
      description: r.description,
      cost: r.cost,
      price: r.price,
      qtyOrdered: 0,
      qtyStock: 0,
      qtySold: r.sold,
      qtySale: r.onSale,
      qtyReturned: 0,
      soldAmt: r.soldAmt,
      saleAmt: r.saleAmt,
      custReturnQty: r.custReturnQty,
    });
  }
  return bySeason;
}

function summarize(bySeason) {
  for (const season of SEASONS) {
    const vendors = bySeason[season] || {};
    let skus = 0;
    let sold = 0;
    let onSale = 0;
    let saleAmt = 0;
    for (const v of Object.values(vendors)) {
      for (const p of v.products) {
        skus += 1;
        sold += p.qtySold || 0;
        onSale += p.qtySale || 0;
        saleAmt += p.saleAmt || 0;
      }
    }
    console.warn(
      `[${season}] vendors=${Object.keys(vendors).length} skus=${skus} ` +
        `sold=${Math.round(sold)}u onSale=${Math.round(onSale)}u saleAmt=$${Math.round(
          saleAmt
        ).toLocaleString()}`
    );
  }
}

const parse = (v) => (v ? (typeof v === "string" ? JSON.parse(v) : v) : null);

async function loadOverride(kv, season) {
  const index = parse(await kv.get(`scan:override:${season}:vendorIndex`)) || [];
  const records = {};
  for (const key of index) records[key] = parse(await kv.get(`scan:override:${season}:v:${key}`));
  return { index, records };
}

async function revert(file) {
  const { kv } = await import("@vercel/kv");
  const backup = JSON.parse(readFileSync(file, "utf8"));
  const { season, vendorIndex, records } = backup;
  for (const [key, rec] of Object.entries(records)) {
    await kv.set(`scan:override:${season}:v:${key}`, JSON.stringify(rec));
  }
  await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(vendorIndex));
  console.warn(
    `Reverted ${season}: restored ${Object.keys(records).length} records + vendorIndex from ${file}`
  );
}

async function writeOverrides(kv, bySeason) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const season of SEASONS) {
    const vendors = bySeason[season];
    if (!vendors || Object.keys(vendors).length === 0) continue;
    const override = await loadOverride(kv, season);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(OUT_DIR, `override-backup-${season}-${stamp}.json`);
    writeFileSync(
      backupPath,
      JSON.stringify({ season, vendorIndex: override.index, records: override.records }, null, 2)
    );
    console.warn(`[${season}] backup written: ${backupPath}`);

    const keys = Object.keys(vendors);
    for (const key of keys) {
      await kv.set(`scan:override:${season}:v:${key}`, JSON.stringify(vendors[key]));
    }
    const merged = Array.from(new Set([...override.index, ...keys]));
    await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(merged));
    console.warn(`[${season}] wrote ${keys.length} sold override record(s)`);
  }
}

async function main() {
  if (REVERT_FILE) {
    await revert(REVERT_FILE);
    return;
  }
  const rows = queryRmh();
  console.warn(`RMH net sales rows (SKU'd): ${rows.length}`);
  const bySeason = buildOverridesBySeason(rows);
  summarize(bySeason);
  if (!WRITE) {
    console.warn("\nDRY RUN - no KV writes. Re-run with --write to persist.");
    return;
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error("KV write env missing (need KV_REST_API_URL + KV_REST_API_TOKEN)");
  }
  const { kv } = await import("@vercel/kv");
  await writeOverrides(kv, bySeason);
  console.warn("\nDone. RMH sold/on-sale override baseline written.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
