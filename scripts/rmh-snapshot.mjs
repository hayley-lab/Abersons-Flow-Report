#!/usr/bin/env node
/*
 * Frozen RMH snapshot — LOCAL/LAN one-off (RMH 172.16.2.4 is not reachable from
 * Vercel). Captures the authoritative legacy POS data BEFORE handoff, when RMH
 * access goes away. This is the source-of-truth backup for any future
 * reconciliation or backfill (ordered/received/returns/sales) once RMH is gone.
 *
 * It writes raw per-SKU TSVs plus a season-level summary JSON to
 * scripts/out/rmh-snapshot-<UTC-date>/ (gitignored). COPY THIS SOMEWHERE SAFE
 * (it contains supplier names + costs — internal, do not commit).
 *
 * RUN:  node scripts/rmh-snapshot.mjs
 * REQUIRES: FreeTDS `tsql`; .env.rmh (HOST/USER/PASS/DATABASE/PORT).
 *
 * Captured:
 *   pos.tsv    — POType 0 (orders) + 3 (vendor returns) per SKU, with PO status,
 *                placed flag, ordered/received qty, item cost/price, supplier, dept.
 *   sales.tsv  — per SKU: gross and net full-price sold qty/$, discounted
 *                (on-sale) qty/$, customer-return qty, first/last sale date.
 *   summary.json — season-level totals (spring25/fall25/spring26/fall26 + other)
 *                  for ordered (u/cost/retail, placed only), received, returns,
 *                  sold, on-sale.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

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
loadEnv(".env.rmh");

const TAB = String.fromCharCode(9);

function seasonForSku(sku) {
  if (!sku || !sku.includes("/")) return "other";
  const seg = sku.split("/")[1].toLowerCase();
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return "other";
}

function rmh(sql) {
  const { HOST, USER, PASS, DATABASE, PORT } = process.env;
  if (!HOST || !USER || !PASS) {
    throw new Error("Missing RMH creds — populate .env.rmh (HOST/USER/PASS/DATABASE/PORT).");
  }
  return execFileSync(
    "tsql",
    ["-H", HOST, "-p", PORT || "1433", "-U", USER, "-P", PASS, "-D", DATABASE],
    { input: sql, encoding: "utf8", timeout: 300_000, maxBuffer: 512 * 1024 * 1024 }
  );
}

function rows(out, minFields) {
  return out
    .split(/\r?\n/)
    .filter((l) => l.includes(TAB) && l.split(TAB).length >= minFields)
    .map((l) => l.split(TAB));
}

const POS_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  CAST(PO.POType AS varchar(4)),
  I.ItemLookupCode,
  ISNULL(CAST(I.SupplierID AS varchar(20)),''),
  ISNULL(S.SupplierName,''),
  ISNULL(D.Name,''),
  CAST(PO.IsPlaced AS varchar(4)),
  CAST(PO.Status AS varchar(6)),
  CAST(SUM(POE.QuantityOrdered) AS varchar(20)),
  CAST(SUM(POE.QuantityReceived) AS varchar(20)),
  CAST(MAX(I.Cost) AS varchar(20)),
  CAST(MAX(I.Price) AS varchar(20)),
  REPLACE(ISNULL(I.Description,''), CHAR(9), ' '))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
LEFT JOIN Supplier S ON S.ID = I.SupplierID
LEFT JOIN Department D ON D.ID = I.DepartmentID
WHERE PO.POType IN (0,3) AND CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY PO.POType, I.ItemLookupCode, I.SupplierID, S.SupplierName, D.Name, PO.IsPlaced, PO.Status, I.Description;
go
quit
`;

const SALES_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  CAST(SUM(CASE WHEN TE.Quantity > 0 AND TE.Price >= TE.FullPrice THEN TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Quantity > 0 AND TE.Price < TE.FullPrice THEN TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Quantity < 0 THEN -TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Quantity > 0 THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
  CAST(SUM(CASE WHEN TE.Quantity > 0 AND TE.Price >= TE.FullPrice THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
  CAST(SUM(CASE WHEN TE.Quantity > 0 AND TE.Price < TE.FullPrice THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
  CAST(SUM(CASE WHEN TE.Price >= TE.FullPrice THEN TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Price < TE.FullPrice THEN TE.Quantity ELSE 0 END) AS varchar(20)),
  CAST(SUM(CASE WHEN TE.Price >= TE.FullPrice THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
  CAST(SUM(CASE WHEN TE.Price < TE.FullPrice THEN TE.Quantity * TE.Price ELSE 0 END) AS varchar(30)),
  CONVERT(varchar(10), MIN(TE.TransactionTime), 120),
  CONVERT(varchar(10), MAX(TE.TransactionTime), 120))
FROM TransactionEntry TE
JOIN Item I ON I.ID = TE.ItemID
WHERE CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY I.ItemLookupCode;
go
quit
`;

function emptySeason() {
  return {
    orderedPlaced: { u: 0, cost: 0, retail: 0 },
    orderedAll: { u: 0, cost: 0, retail: 0 },
    received: { u: 0 },
    returns: { u: 0, cost: 0, retail: 0 },
    sold: { u: 0, amt: 0 },
    onSale: { u: 0, amt: 0 },
    soldNet: { u: 0, amt: 0 },
    onSaleNet: { u: 0, amt: 0 },
    custReturns: { u: 0 },
    skus: 0,
  };
}

function main() {
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(ROOT, "scripts", "out", `rmh-snapshot-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  // eslint-disable-next-line no-console
  console.log("Querying RMH purchase orders (POType 0/3)…");
  const posOut = rmh(POS_SQL);
  const posRows = rows(posOut, 12);
  const posHeader =
    [
      "poType",
      "sku",
      "supplierId",
      "supplierName",
      "dept",
      "isPlaced",
      "status",
      "qtyOrdered",
      "qtyReceived",
      "cost",
      "price",
      "description",
    ].join("\t") + "\n";
  writeFileSync(
    path.join(outDir, "pos.tsv"),
    posHeader + posRows.map((f) => f.join("\t")).join("\n") + "\n"
  );

  // eslint-disable-next-line no-console
  console.log("Querying RMH sales (TransactionEntry)…");
  const salesOut = rmh(SALES_SQL);
  const salesRows = rows(salesOut, 13);
  const salesHeader =
    [
      "sku",
      "soldQty",
      "onSaleQty",
      "custReturnQty",
      "grossSalesAmt",
      "soldAmt",
      "onSaleAmt",
      "soldNetQty",
      "onSaleNetQty",
      "soldNetAmt",
      "onSaleNetAmt",
      "firstSale",
      "lastSale",
    ].join("\t") + "\n";
  writeFileSync(
    path.join(outDir, "sales.tsv"),
    salesHeader + salesRows.map((f) => f.join("\t")).join("\n") + "\n"
  );

  const summary = {};
  const ensure = (s) => (summary[s] = summary[s] || emptySeason());

  for (const f of posRows) {
    const poType = parseInt(f[0], 10);
    const season = seasonForSku(f[1].trim().toLowerCase());
    const isPlaced = f[5] === "1";
    const ordered = parseInt(f[7], 10) || 0;
    const received = parseInt(f[8], 10) || 0;
    const cost = parseFloat(f[9]) || 0;
    const price = parseFloat(f[10]) || 0;
    const s = ensure(season);
    if (poType === 0) {
      s.orderedAll.u += ordered;
      s.orderedAll.cost += ordered * cost;
      s.orderedAll.retail += ordered * price;
      if (isPlaced) {
        s.orderedPlaced.u += ordered;
        s.orderedPlaced.cost += ordered * cost;
        s.orderedPlaced.retail += ordered * price;
      }
      s.received.u += received;
    } else if (poType === 3) {
      s.returns.u += ordered;
      s.returns.cost += ordered * cost;
      s.returns.retail += ordered * price;
    }
  }

  for (const f of salesRows) {
    const season = seasonForSku(f[0].trim().toLowerCase());
    const s = ensure(season);
    s.sold.u += parseFloat(f[1]) || 0;
    s.onSale.u += parseFloat(f[2]) || 0;
    s.custReturns.u += parseFloat(f[3]) || 0;
    s.sold.amt += parseFloat(f[5]) || 0;
    s.onSale.amt += parseFloat(f[6]) || 0;
    s.soldNet.u += parseFloat(f[7]) || 0;
    s.onSaleNet.u += parseFloat(f[8]) || 0;
    s.soldNet.amt += parseFloat(f[9]) || 0;
    s.onSaleNet.amt += parseFloat(f[10]) || 0;
    s.skus += 1;
  }

  const round = (o) => {
    if (typeof o === "number") return Math.round(o * 100) / 100;
    if (o && typeof o === "object") {
      const r = {};
      for (const [k, v] of Object.entries(o)) r[k] = round(v);
      return r;
    }
    return o;
  };

  const manifest = {
    capturedAt: new Date().toISOString(),
    source: `RMH ${process.env.HOST}/${process.env.DATABASE}`,
    files: { pos: "pos.tsv", sales: "sales.tsv" },
    posSkuRows: posRows.length,
    salesSkuRows: salesRows.length,
    notes:
      "orderedPlaced = POType=0 IsPlaced=1 (what the old flow report counted). " +
      "returns = POType=3 (vendor returns). sold/onSale split by Price vs FullPrice. " +
      "soldNet/onSaleNet include negative customer-return lines in the original bucket. " +
      "Season folds rs/ps→spring, pf→fall for 2025/26.",
    seasons: round(summary),
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(manifest, null, 2) + "\n");

  // eslint-disable-next-line no-console
  console.log(`\nSnapshot written to ${outDir}`);
  // eslint-disable-next-line no-console
  console.log(`  pos.tsv    ${posRows.length} SKU rows`);
  // eslint-disable-next-line no-console
  console.log(`  sales.tsv  ${salesRows.length} SKU rows`);
  const money = (n) => `$${Math.round(n).toLocaleString()}`;
  for (const season of ["spring25", "fall25", "spring26", "fall26"]) {
    const s = summary[season];
    if (!s) continue;
    // eslint-disable-next-line no-console
    console.log(
      `  [${season}] ordered placed ${s.orderedPlaced.u}u ${money(s.orderedPlaced.retail)}ret/${money(
        s.orderedPlaced.cost
      )}cost  returns ${s.returns.u}u  gross sold ${Math.round(s.sold.u)}u ${money(
        s.sold.amt
      )}  gross on-sale ${Math.round(s.onSale.u)}u ${money(
        s.onSale.amt
      )}  net sold+on-sale ${Math.round(s.soldNet.u + s.onSaleNet.u)}u`
    );
  }
  // eslint-disable-next-line no-console
  console.log("\n>>> COPY this folder somewhere safe — RMH access ends at handoff. <<<");
}

main();
