import { getSql, hasSqlDatabase, sqlReadsEnabled, sqlWritesEnabled } from "./db";
import { computeReport } from "./report-compute";

const SQL_BATCH_SIZE = 250;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function productKey(row, index) {
  if (row?.pid != null && row.pid !== "") return String(row.pid);
  if (row?.sku) return `sku:${row.sku}`;
  return `row:${index}`;
}

function rowRecord(season, sourceTs, row, index) {
  return {
    season,
    productKey: productKey(row, index),
    pid: row?.pid == null ? null : String(row.pid),
    sku: row?.sku || "",
    name: row?.name || "",
    variant: row?.variant || "",
    deptId: row?.deptId || "__none__",
    deptName: row?.deptName || "",
    vendorId: row?.vendorId || "__unassigned__",
    vendorName: row?.vendorName || "Unassigned",
    price: num(row?.price),
    cost: num(row?.cost),
    qtyOrdered: num(row?.orderedQty),
    qtyReceived: num(row?.receivedRaw),
    retQty: num(row?.retQty),
    retVal: num(row?.retVal),
    retCost: num(row?.retCost),
    sold: num(row?.sold),
    onSale: num(row?.onSale),
    soldAmt: num(row?.soldAmt),
    saleAmt: num(row?.saleAmt),
    returned: num(row?.returned),
    liveOnHand: row?.liveOnHand == null ? null : num(row.liveOnHand),
    sourceTs: sourceTs || null,
    rowJson: row || {},
  };
}

function summaryData(season, rawData, report) {
  return {
    ts: rawData?.ts ?? null,
    season,
    summaryRows: report.summaryRows,
    deptVendors: report.deptVendors,
    health: report.health,
    isDelta: rawData?.isDelta || false,
    salesState: rawData?.salesState || null,
  };
}

export async function ensureSqlSchema(sql = getSql()) {
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS product_season (
      season TEXT NOT NULL,
      product_key TEXT NOT NULL,
      pid TEXT,
      sku TEXT,
      name TEXT,
      variant TEXT,
      dept_id TEXT NOT NULL DEFAULT '__none__',
      dept_name TEXT,
      vendor_id TEXT NOT NULL DEFAULT '__unassigned__',
      vendor_name TEXT NOT NULL DEFAULT 'Unassigned',
      price NUMERIC NOT NULL DEFAULT 0,
      cost NUMERIC NOT NULL DEFAULT 0,
      qty_ordered NUMERIC NOT NULL DEFAULT 0,
      qty_received NUMERIC NOT NULL DEFAULT 0,
      ret_qty NUMERIC NOT NULL DEFAULT 0,
      ret_val NUMERIC NOT NULL DEFAULT 0,
      ret_cost NUMERIC NOT NULL DEFAULT 0,
      sold NUMERIC NOT NULL DEFAULT 0,
      on_sale NUMERIC NOT NULL DEFAULT 0,
      sold_amt NUMERIC NOT NULL DEFAULT 0,
      sale_amt NUMERIC NOT NULL DEFAULT 0,
      returned NUMERIC NOT NULL DEFAULT 0,
      live_on_hand NUMERIC,
      source_ts BIGINT,
      row_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (season, product_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS product_season_season_dept_idx ON product_season (season, dept_id)`;
  await sql`CREATE INDEX IF NOT EXISTS product_season_season_vendor_idx ON product_season (season, vendor_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS report_summary (
      season TEXT PRIMARY KEY,
      source_ts BIGINT,
      summary_rows JSONB NOT NULL,
      dept_vendors JSONB NOT NULL,
      health JSONB,
      has_override BOOLEAN NOT NULL DEFAULT FALSE,
      is_delta BOOLEAN NOT NULL DEFAULT FALSE,
      sales_state JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE report_summary ADD COLUMN IF NOT EXISTS has_override BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`
    CREATE TABLE IF NOT EXISTS override_vendor (
      season TEXT NOT NULL,
      vendor_key TEXT NOT NULL,
      vendor_id TEXT,
      vendor_name TEXT,
      dept_name TEXT,
      ordered NUMERIC NOT NULL DEFAULT 0,
      ordered_cost NUMERIC NOT NULL DEFAULT 0,
      raw JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (season, vendor_key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS scan_job (
      season TEXT PRIMARY KEY,
      phase TEXT,
      progress TEXT,
      error TEXT,
      ts BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  return true;
}

async function insertProductBatch(sql, records) {
  if (!records.length) return;
  const params = [];
  const tuples = records.map((r) => {
    const start = params.length + 1;
    params.push(
      r.season,
      r.productKey,
      r.pid,
      r.sku,
      r.name,
      r.variant,
      r.deptId,
      r.deptName,
      r.vendorId,
      r.vendorName,
      r.price,
      r.cost,
      r.qtyOrdered,
      r.qtyReceived,
      r.retQty,
      r.retVal,
      r.retCost,
      r.sold,
      r.onSale,
      r.soldAmt,
      r.saleAmt,
      r.returned,
      r.liveOnHand,
      r.sourceTs,
      JSON.stringify(r.rowJson)
    );
    const placeholders = Array.from({ length: 25 }, (_, i) => `$${start + i}`);
    placeholders[24] = `${placeholders[24]}::jsonb`;
    return `(${placeholders.join(", ")})`;
  });

  await sql.query(
    `
      INSERT INTO product_season (
        season, product_key, pid, sku, name, variant, dept_id, dept_name,
        vendor_id, vendor_name, price, cost, qty_ordered, qty_received,
        ret_qty, ret_val, ret_cost, sold, on_sale, sold_amt, sale_amt,
        returned, live_on_hand, source_ts, row_json
      ) VALUES ${tuples.join(", ")}
      ON CONFLICT (season, product_key) DO UPDATE SET
        pid = EXCLUDED.pid,
        sku = EXCLUDED.sku,
        name = EXCLUDED.name,
        variant = EXCLUDED.variant,
        dept_id = EXCLUDED.dept_id,
        dept_name = EXCLUDED.dept_name,
        vendor_id = EXCLUDED.vendor_id,
        vendor_name = EXCLUDED.vendor_name,
        price = EXCLUDED.price,
        cost = EXCLUDED.cost,
        qty_ordered = EXCLUDED.qty_ordered,
        qty_received = EXCLUDED.qty_received,
        ret_qty = EXCLUDED.ret_qty,
        ret_val = EXCLUDED.ret_val,
        ret_cost = EXCLUDED.ret_cost,
        sold = EXCLUDED.sold,
        on_sale = EXCLUDED.on_sale,
        sold_amt = EXCLUDED.sold_amt,
        sale_amt = EXCLUDED.sale_amt,
        returned = EXCLUDED.returned,
        live_on_hand = EXCLUDED.live_on_hand,
        source_ts = EXCLUDED.source_ts,
        row_json = EXCLUDED.row_json,
        updated_at = NOW()
    `,
    params
  );
}

export async function upsertOverrideVendors(sql, season, override) {
  if (!sql || !override?.vendors) return;
  await ensureSqlSchema(sql);
  for (const [vendorKey, vendor] of Object.entries(override.vendors || {})) {
    if (!vendor) continue;
    await sql`
      INSERT INTO override_vendor (
        season, vendor_key, vendor_id, vendor_name, dept_name,
        ordered, ordered_cost, raw, updated_at
      ) VALUES (
        ${season}, ${vendorKey}, ${vendor.vendorId || null}, ${vendor.vendorName || null},
        ${vendor.deptName || null}, ${num(vendor.ordered)}, ${num(vendor.orderedCost)},
        ${JSON.stringify(vendor)}::jsonb, NOW()
      )
      ON CONFLICT (season, vendor_key) DO UPDATE SET
        vendor_id = EXCLUDED.vendor_id,
        vendor_name = EXCLUDED.vendor_name,
        dept_name = EXCLUDED.dept_name,
        ordered = EXCLUDED.ordered,
        ordered_cost = EXCLUDED.ordered_cost,
        raw = EXCLUDED.raw,
        updated_at = NOW()
    `;
  }
}

export async function maybeUpsertSqlOverrideVendors(season, override) {
  if (!hasSqlDatabase() || !sqlWritesEnabled()) return { ok: false, skipped: true };
  await upsertOverrideVendors(getSql(), season, override);
  return { ok: true };
}

export async function upsertSqlReport(sql, season, rawData, override, options = {}) {
  if (!sql || (!rawData && !override)) return { ok: false, skipped: true };
  await ensureSqlSchema(sql);
  const report = computeReport(rawData, override, season, {
    consignByPid: options.consignByPid || null,
  });
  const data = summaryData(season, rawData, report);
  const sourceTs = data.ts;
  const records = report.rows.map((row, index) => rowRecord(season, sourceTs, row, index));

  await sql`DELETE FROM product_season WHERE season = ${season}`;
  for (let index = 0; index < records.length; index += SQL_BATCH_SIZE) {
    await insertProductBatch(sql, records.slice(index, index + SQL_BATCH_SIZE));
  }
  await sql`
    INSERT INTO report_summary (
      season, source_ts, summary_rows, dept_vendors, health, has_override, is_delta, sales_state, updated_at
    ) VALUES (
      ${season}, ${sourceTs}, ${JSON.stringify(data.summaryRows)}::jsonb,
      ${JSON.stringify(data.deptVendors)}::jsonb, ${JSON.stringify(data.health)}::jsonb,
      ${!!override}, ${!!data.isDelta}, ${JSON.stringify(data.salesState || null)}::jsonb, NOW()
    )
    ON CONFLICT (season) DO UPDATE SET
      source_ts = EXCLUDED.source_ts,
      summary_rows = EXCLUDED.summary_rows,
      dept_vendors = EXCLUDED.dept_vendors,
      health = EXCLUDED.health,
      has_override = EXCLUDED.has_override,
      is_delta = EXCLUDED.is_delta,
      sales_state = EXCLUDED.sales_state,
      updated_at = NOW()
  `;
  await upsertOverrideVendors(sql, season, override);
  return { ok: true, season, ts: sourceTs, rows: records.length };
}

export async function maybeUpsertSqlReport(season, rawData, override, options = {}) {
  if (!hasSqlDatabase() || !sqlWritesEnabled()) return { ok: false, skipped: true };
  return upsertSqlReport(getSql(), season, rawData, override, options);
}

export async function readSqlSummary(sql, season) {
  if (!sql) return null;
  const rows = await sql`
    SELECT source_ts, summary_rows, dept_vendors, health, has_override, is_delta, sales_state
    FROM report_summary
    WHERE season = ${season}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ts: row.source_ts,
    season,
    summaryRows: row.summary_rows || [],
    deptVendors: row.dept_vendors || {},
    health: row.health || null,
    hasOverride: !!row.has_override,
    isDelta: !!row.is_delta,
    salesState: row.sales_state || null,
  };
}

export async function readSqlDeptRows(sql, season, deptId) {
  if (!sql) return null;
  const rows = await sql`
    SELECT row_json
    FROM product_season
    WHERE season = ${season} AND dept_id = ${String(deptId)}
    ORDER BY name, sku
  `;
  return rows.map((row) => row.row_json);
}

export async function readSqlFull(sql, season) {
  if (!sql) return null;
  const [summary, rows] = await Promise.all([
    readSqlSummary(sql, season),
    sql`SELECT row_json FROM product_season WHERE season = ${season} ORDER BY dept_id, name, sku`,
  ]);
  if (!summary) return null;
  return { ...summary, rows: rows.map((row) => row.row_json) };
}

export async function readSqlReportView({ season, view = "summary", deptId = null }) {
  if (!hasSqlDatabase() || !sqlReadsEnabled()) return null;
  const sql = getSql();
  if (view === "drows" && deptId != null) {
    const rows = await readSqlDeptRows(sql, season, deptId);
    if (!rows) return null;
    return { ts: null, season, deptId: String(deptId), rows };
  }
  if (view === "full") return readSqlFull(sql, season);
  return readSqlSummary(sql, season);
}
