# Flow Report Data Flows

These diagrams map the data paths that matter most for maintaining the report.
`CLAUDE.md` remains the authoritative domain spec; this file is a visual index.

## Old to New Data Lineage

The old RMH/datatailor report is imported as an override, while Lightspeed
provides the live operational data. The request-time rollup is the point where
the two sources are reconciled into one canonical set of rows.

```mermaid
flowchart LR
  rmh["RMH / datatailor flowFrom.sql"] --> importApi["api/import/datatail.js"]
  importApi --> overrideKv["KV scan:override season keys"]
  lsApi["Lightspeed Retail API v2"] --> scanPipeline["scan pipeline"]
  scanPipeline --> scanKv["KV scan:data and caches"]
  overrideKv --> rollup["lib/flow-rollup.js"]
  scanKv --> rollup
  rollup --> ui["pages/index.js"]
  rollup --> validation["api/scan/validate"]
  rollup --> reconciliation["api/scan/reconcile"]
```

## Scan Pipeline Phases

The full scan advances in small, restartable chunks through `pages/api/scan/step.js`.
Large intermediate and final values use sharded KV helpers so the scan can survive
Vercel and KV request-size limits.

```mermaid
flowchart TD
  init["init"] --> productsSeed["products_seed"]
  productsSeed --> consignments["consignments"]
  consignments --> returnsPhase["returns"]
  returnsPhase --> sales["sales"]
  sales --> finalizing["finalizing"]
  finalizing --> done["done"]

  init --> jobState["scan:job season"]
  productsSeed --> pidMaps["scan:pids season"]
  consignments --> bigState["scan:job:big season"]
  returnsPhase --> bigState
  sales --> bigState
  finalizing --> scanData["scan:data season"]
```

## Sync Mechanisms

The app has separate freshness paths because full LS scans are expensive and
sales need to update during the day. Delta sync is sales-only; it must not mutate
PO, return, or product-discovery behavior.

```mermaid
flowchart TD
  nightlyWorkflow["nightly-scan workflow"] --> cronScan["api/cron/scan"]
  weeklyWorkflow["weekly-full-scan workflow"] --> cronScan
  cronScan --> scanStep["api/scan/step"]
  scanStep --> fullData["scan:data and scan:pids"]

  deltaWorkflow["delta-scan workflow"] --> cronDelta["api/cron/delta"]
  cronDelta --> deltaRoute["api/scan/delta"]
  deltaRoute --> salesOnly["sales fields in scan:data"]

  browser["pages/index.js polling"] --> dataRoute["api/scan/data"]
  dataRoute --> browser
  fullData --> dataRoute
  salesOnly --> dataRoute
```

## Request-Time Rollup Merge

`buildAllRows` creates canonical product rows from LS scan data and datatail
override records. Ordered dollars can include datatail rows that never made it
into LS, but overlapping SKUs stay LS-only to avoid double-counting.

```mermaid
flowchart TD
  scanData["scan:data season"] --> buildRows["buildAllRows"]
  override["scan:override season"] --> buildRows
  buildRows --> skuGate["skuMatchesSeason gate"]
  skuGate --> lsRows["LS product rows"]
  skuGate --> datatailRows["datatail-only rows"]
  lsRows --> rowBySku["rowBySku overlap map"]
  datatailRows --> rowBySku
  rowBySku --> rollup["rollup rows"]
  rollup --> summary["summaryRows"]
  rollup --> vendors["deptVendors"]
  rollup --> drilldown["vendor drilldown rows"]
```

## Sale Classification Decision Tree

The old report split Sold vs SoldSale using `Price = FullPrice`. Lightspeed sale
lines do not always provide the same fields, so `saleContribution` applies the
same intent with discount markers, unit price vs retail price, and return-line
quantity signs.

```mermaid
flowchart TD
  line["Lightspeed sale line"] --> inSeason{"Product pid in season set?"}
  inSeason -->|No| ignore["Ignore line"]
  inSeason -->|Yes| voided{"Line voided or sale open?"}
  voided -->|Yes| ignore
  voided -->|No| qty{"Quantity below 0?"}
  qty -->|No| discounted{"Discount marker or unit below retail?"}
  qty -->|Yes| returnDiscounted{"Return line discounted?"}
  discounted -->|Yes| onSale["Add qty to On Sale and actual dollars to saleAmt"]
  discounted -->|No| sold["Add qty to Sold"]
  returnDiscounted -->|Yes| onSaleReturn["Subtract qty from On Sale and net saleAmt"]
  returnDiscounted -->|No| soldReturn["Subtract qty from Sold"]
  onSaleReturn --> customerReturned["Track customer returned for diagnostics only"]
  soldReturn --> customerReturned
```
