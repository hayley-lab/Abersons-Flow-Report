# Abersons Flow Report — Project Context

## Background
Abersons switched POS systems from RMH (old) to Lightspeed Retail / LS (new). The old flow report was connected to RMH. This new app connects to LS and replaces it. Sales history was transferred into LS, but not all POs were — some older POs were hard-pulled from the old flow report.

## Tech Stack
- Next.js 14 pages router
- Vercel KV (Redis/Upstash) for scan state and cached results
- Iron-session for auth
- Lightspeed Retail API v2 (`https://{LS_DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0/`)

## How The Data Is Supposed To Work (Hayley's Spec)

### 1. Hard Pull (datatail import)
Old PO ordered/received data that never made it into LS was imported directly into the app (via `pages/api/import/datatail.js`). This covers ordered & received quantities and dollars from the RMH era. These amounts must ADD to any matching LS POs — they must not be double-counted or overwritten.
- **Pending:** Carrie had a vendor return entered in the wrong season — need to check Staud in spring26.

### 2. LS POs (consignments in LS API, type=SUPPLIER)
Pull ordered and received quantities and dollars from LS purchase orders. These go into the Ordered and Received columns. Must not collide with the hard pull data.
- Ordered/Received qty in designated columns (qty, not dollars)
- Retail $ summed into color key and pushed to header
- Cost $ also shown in header
- When a product is received, it adds to both the Received column AND the On Hand column

**On Hand formula:** `received qty − vendor returns − sold qty − on sale qty + customer returns`
(Customer returns add back to on hand because the item is back in stock. Vendor returns reduce on hand because the item left the store.)

### 3. Vendor Returns (consignments in LS API, type=SUPPLIER_RETURN)
Vendor returns reduce received inventory and go into the Returned column.
- Qty goes into Returned column
- Retail $ summed into color key
- Returned retail $ is deducted from the Received (retail) header total

### 4. Sales (LS sales API)
- **Full-price sale:** qty removed from stock, placed in Sold column, retail $ in color key
- **Discounted sale (any discount, including 100% off):** qty goes into On Sale column (NOT Sold), color key uses the ACTUAL sold dollar amount (e.g. 50% off → half price; 100% off → $0)
- **Customer return of full-price item:** qty removed from Sold column, added back to on-hand
- **Customer return of discounted item:** qty removed from On Sale column, added back to on-hand
- Sold and On Sale columns are mutually exclusive — an item is in one or the other, never both

## Sync Schedule
Three separate mechanisms keep data current:

1. **Nightly full scan** — rescans EVERYTHING (products, POs, vendor returns, sales). Runs in the middle of the night via Vercel cron (`/api/cron/scan`).
2. **Delta sync** — sales-only update, runs every ~10 minutes via Vercel cron (`/api/cron/delta`). Does NOT re-scan products, POs, or vendor returns — only sales.
3. **Page auto-refresh** — the UI polls in the background and automatically refreshes the display when new delta sync data is available. Users never need to manually refresh the page to see new sales.

## Key Architecture

### Scan Pipeline (step.js)
Each POST to `/api/scan/step` does ~6 seconds of work and saves state to KV. Client loops until done.

Phases in order:
`init` → `products` (fast-path SKU search, always finds 0) → `products_slow` (full 83k catalog scan, matches by SKU) → `products_slow_done` → `products_fix` (variant parent fixup) → `consignments` → `returns` → `sales` → `finalizing`

KV keys:
- `scan:job:{season}` — small operational state (phase, cursors), 6h TTL
- `scan:job:big:{season}` — large data blobs (pidMaps, productStats), 6h TTL
- `scan:data:{season}` — final report, 48h TTL

### SKU Structure
Every product SKU follows this format: `{item_number}/{season_code}`

Examples: `1234/s26`, `5678/f26`, `9999/rs26`

Season codes:
- `/s26` — Spring 2026
- `/f26` — Fall 2026
- `/rs26` or `/ps26` — Pre-Spring (2027+)
- `/pf26` — Pre-Fall (2027+)

The slash comes AFTER the item number and BEFORE the season code. The season code is always at the end.

### Product Identification — CRITICAL
Products in LS are identified by season using their SKU format: `{item_number}/{season_code}` e.g. `1234/s26`

Season codes: `/s26` (spring26), `/f26` (fall26), `/rs26` or `/ps26` (prespring), `/pf26` (prefall)

The `seasonSkuCodes()` function generates these. The products_slow scan checks both `sku` and `custom_sku` fields for the season code. **AS OF THE LAST SESSION, products_slow was finding 0 products for ALL seasons including active ones.** A debug log was added to the first page of products_slow to show what fields the LS API actually returns — this needs to be checked in Vercel logs after a sync runs.

**DO NOT change the product-matching strategy without first checking those logs.** The SKU format `1234/s26` SHOULD match the check for `/s26` — the issue is likely that `sku`/`custom_sku` fields aren't returned by the list API, or are named differently.

### Data Flow — Bottom Up (CRITICAL)
All totals are calculated at the individual product/SKU level first, then flowed up through each report level. Never calculate totals top-down.

Flow: **individual product SKU → vendor total → department total → season summary**

Each level's numbers are the sum of the level below it. If a number looks wrong at the vendor or department level, the root cause is always at the product level. Fix it there and it propagates up automatically.

### productStats — single source of truth
`productStats[pid] = { ordered, orderedCost, received, receivedCost, retVal, retCost, soldAmt, saleAmt, sold, onSale, returned }`

- `sold` and `onSale` are mutually exclusive (discounted sales go ONLY to onSale, not both)
- Customer returns subtract from whichever bucket the item sold from (discounted → onSale, full price → sold)
- `saleAmt` = actual discounted sale dollars (used in color key, NOT retail price × qty)
- `soldAmt` = net sale dollars (can be negative for net-return products)

### Cron / Scan Loop
- `vercel.json` cron fires nightly: `GET /api/cron/scan`
- UI "Sync from LS" button POSTs to `/api/cron/scan` in a loop
- First call: `?force=1&restart=1` — restarts all seasons fresh
- Subsequent calls: `?force=1` — advances in-progress seasons, SKIPS seasons completed within 1 hour
- Concurrency: 3 seasons at a time (avoids LS rate limits)
- 429/503 from LS: exponential backoff, up to 4 retries (2s, 4s, 8s, 16s)
- cron/scan and cron/delta maxDuration: 300s; step.js: 60s

### Delta Sync
Separate sales-only sync at `/api/cron/delta`, runs ~every 10 minutes. Only updates sales — does NOT re-scan products, POs, or returns. DO NOT break this when changing the product scan logic.

## Seasons
Generated in `lib/seasons.js`. Current year + 1 ahead, back to 2025.
- 2025: fall25, spring25 (no pre-seasons)
- 2026: fall26, spring26 (no pre-seasons — transition year)
- 2027+: fall, prefall, spring, prespring

**2027 seasons have no orders yet** — they should complete quickly with empty data (not error).

Active seasons for scanning: current year, next year, prior year.

## Known Data Facts
- Not all POs are in LS — some were imported from the old flow report (datatail import). The scan must work for products that may not have LS consignments.
- Judi Powers spring26 consignment returns not pulling in correctly — not yet fixed.
- Some vendor returns were entered in both old and new systems during transition — minor overlap expected.
- Staud spring26 may have a return entered in the wrong season (Carrie entered it) — needs investigation.

## UI Behavior
- Season navigation: changing seasons keeps the user on the same drilldown view (dept or vendor). Falls back to dept list if vendor doesn't exist in new season, falls back to summary if dept doesn't exist.
- Color key uses actual `saleAmt` for on-sale items (not retail price × qty).
- Sold column: full-price sales only. On Sale column: discounted sales only.
- **On-sale visual highlighting** (DEFERRED): in the old RMH system, items on sale had different font color in the product list. We will replicate this in LS using pricebooks — come back to this once the pricebook workflow is settled in LS.

## What's Currently Broken / In Progress
1. **products_slow finding 0 products** — debug log added to step.js, need to check Vercel runtime logs after a sync runs to see actual LS API field names on product objects. This is blocking everything — all scan data is empty until this is fixed.
2. **Judi Powers spring26 returns** — not investigated yet.
3. **Staud spring26 return** — may be in wrong season, needs checking.

## What NOT To Do
- Do not remove the 6h KV TTL (was 1h before, caused state loss on long scans)
- Do not use `force=1` to bypass the 1-hour rescan interval on completed seasons (use `restart=1` on first call only)
- Do not scan all 83k products for 2027 seasons and error — complete gracefully with empty data
- Do not put discounted items in both Sold and On Sale columns
- Do not use retail price in the color key for on-sale items — use actual saleAmt
- Do not break the delta sync when modifying the full scan logic
- Do not assume all POs are in LS — some came from the datatail import
