# SQL Migration Plan (Follow-up / Future Project)

Status: PROPOSED, not started. This is a documented follow-up to the KV
read-path caching work (see `scan:report:*` in `pages/api/scan/data.js`). The
caching layer is a tactical fix; this document describes the strategic option of
backing the app with a relational database.

Do not start this without a dedicated validation pass — it is a multi-day
project that touches the scan pipeline and the reconciliation harnesses.

## Why consider SQL

The current store is Vercel KV (Upstash Redis). KV cannot query or aggregate, so
the report endpoint must load an entire season's multi-MB blob (sharded across 16
keys via `lib/kv-sharded.js`) just to render a ~20 KB summary. Everything built
to work around that — pid sharding, the request-time rollup, and the new
`scan:report:*` write-through cache — exists only because KV is a key-value blob
store.

Measured today (live Vercel app, `/api/scan/data`): ~16.7s / 10 MB / 7,383 rows
for `spring25`; the `view=summary` (19 KB) and `since` notModified (122 B)
responses were also ~15s because the cost is the upfront KV load, not the
response.

A relational database removes the root cause:

- Summary = `SELECT dept_id, SUM(...) GROUP BY dept_id` (indexed, milliseconds).
- Vendor list = `GROUP BY vendor_id`.
- Product drilldown = `WHERE season = ? AND vendor_id = ?` with an index.
- No sharding, no whole-season loads, no request-time rollup, no write-through cache.

The data is small for SQL (~7k rows/season, a 261k-row catalog), so this is well
within a single small Postgres instance.

## Proposed data model (Postgres)

Normalize per-product, per-season stats into a table, materializing the existing
overlay logic at write time so the read path is pure aggregation.

```sql
-- One row per product per season (the canonical "productStats" unit).
CREATE TABLE product_season (
  season            TEXT NOT NULL,
  pid               TEXT NOT NULL,
  sku               TEXT,
  name              TEXT,
  dept_id           TEXT NOT NULL DEFAULT '__none__',
  vendor_id         TEXT,
  vendor_name       TEXT,
  price             NUMERIC NOT NULL DEFAULT 0,
  cost              NUMERIC NOT NULL DEFAULT 0,
  qty_ordered       INTEGER NOT NULL DEFAULT 0,
  qty_received      INTEGER NOT NULL DEFAULT 0,
  ret_qty           INTEGER NOT NULL DEFAULT 0,   -- vendor returns
  ret_val           NUMERIC NOT NULL DEFAULT 0,
  ret_cost          NUMERIC NOT NULL DEFAULT 0,
  sold              INTEGER NOT NULL DEFAULT 0,    -- full-price units
  on_sale           INTEGER NOT NULL DEFAULT 0,    -- discounted units
  sold_amt          NUMERIC NOT NULL DEFAULT 0,
  sale_amt          NUMERIC NOT NULL DEFAULT 0,
  returned          INTEGER NOT NULL DEFAULT 0,    -- customer returns (not displayed)
  live_on_hand      INTEGER NOT NULL DEFAULT 0,
  ordered_source    TEXT,                          -- 'ls' | 'datatail' | 'mixed'
  source_ts         BIGINT NOT NULL,               -- scan/delta ts that produced this row
  PRIMARY KEY (season, pid)
);
CREATE INDEX ON product_season (season, dept_id);
CREATE INDEX ON product_season (season, vendor_id);

-- Datatail/RMH vendor-level ordered dollars that have no per-product breakdown.
CREATE TABLE override_vendor (
  season       TEXT NOT NULL,
  vendor_key   TEXT NOT NULL,
  vendor_id    TEXT,
  vendor_name  TEXT,
  dept_name    TEXT,
  ordered      NUMERIC NOT NULL DEFAULT 0,
  ordered_cost NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (season, vendor_key)
);

-- Small operational state (replaces scan:job).
CREATE TABLE scan_job (
  season   TEXT PRIMARY KEY,
  phase    TEXT,
  progress TEXT,
  error    TEXT,
  ts       BIGINT
);
```

Key decision: the hard overlay logic in `lib/flow-rollup.js` /
`lib/flow-math.js` (RMH returns/sold overlays, datatail price/cost fallback,
LS-vs-datatail ordered overlap rules, season SKU gates) is applied ONCE at write
time when populating `product_season`, so the read path is plain SQL. The "Data
Flow — Bottom Up" rule in `CLAUDE.md` still holds: rows materialize first, then
`GROUP BY` rolls them up.

## Migration phases

1. Provision Postgres (Vercel Postgres / Neon / Supabase) and add a thin
   `lib/db.js` client. Keep KV in place.
2. Write the schema + a one-time backfill that reads the current KV
   `scan:data:{season}` + override and inserts `product_season` /
   `override_vendor` rows (reuse `lib/report-compute.js` to produce the rows,
   then insert instead of cache). This is the only "data rebuild" needed and it
   is derived from existing KV, so it is reversible.
3. Add SQL-backed read endpoints behind a feature flag; keep `data.js` KV path as
   fallback. Diff SQL output against the KV rollup using the existing
   `tools/recon-accuracy.js` harness until Δ = 0 on every season/column.
4. Switch the scan pipeline (`pages/api/scan/step.js` finalizing) and delta
   (`pages/api/scan/delta.js`) to UPSERT into `product_season` instead of
   writing KV blobs. Switch the datatail import (`pages/api/import/save.js`) to
   upsert `override_vendor`.
5. Flip the read flag to SQL, delete the `scan:report:*` cache code, then retire
   `lib/kv-sharded.js` and the KV scan keys after a soak period.

## What stays the same

- Lightspeed ingestion (the API paging in `step.js` / `delta.js`) is unchanged —
  only the destination of the parsed data changes.
- Auth (iron-session), the Next.js UI structure, and the bottom-up domain rules
  in `CLAUDE.md`.
- The reconciliation snapshots (`scripts/rmh-snapshot.mjs`) remain the
  source-of-truth backup for validating the migrated numbers.

## Risks

- Largest risk is regressing the hard-won RMH/datatail reconciliation. Mitigate
  by keeping the KV path as a parallel oracle and gating the switch on
  `tools/recon-accuracy.js` Δ = 0.
- Timing vs handoff: this is a project, not a patch. The KV caching layer already
  delivers sub-second summaries, so SQL can be scheduled deliberately rather than
  rushed.

## Effort estimate

Roughly 3-5 focused days: ~1 day schema + backfill, ~1-2 days dual-read
validation, ~1 day pipeline upserts, ~1 day cleanup/soak. Compare to the caching
layer (hours).
