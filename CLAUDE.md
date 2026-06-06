# Abersons Flow Report — Project Context

## What This Is
A Next.js app on Vercel that replaces Abersons' old spreadsheet-based "flow report." It pulls data from Lightspeed Retail (X-Series / Vend) via their API and shows ordered, received, sold, on-sale, and returned totals by season → department → vendor → product.

## Tech Stack
- Next.js 14 pages router
- Vercel KV (Redis/Upstash) for scan state and cached results
- Iron-session for auth
- Lightspeed Retail API v2 (`https://{LS_DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0/`)

## Key Architecture

### Scan Pipeline (step.js)
Each POST to `/api/scan/step` does ~6 seconds of work and saves state to KV. Client loops until done.

Phases in order:
`init` → `products` (fast-path SKU search, always finds 0) → `products_slow` (full 83k catalog scan, matches by SKU) → `products_slow_done` → `products_fix` (variant parent fixup) → `consignments` → `returns` → `sales` → `finalizing`

KV keys:
- `scan:job:{season}` — small operational state (phase, cursors), 6h TTL
- `scan:job:big:{season}` — large data blobs (pidMaps, productStats), 6h TTL
- `scan:data:{season}` — final report, 48h TTL

### Product Identification — CRITICAL
Products in LS are identified by season using their SKU format: `{item_number}/{season_code}` e.g. `1234/s26`

Season codes: `/s26` (spring26), `/f26` (fall26), `/rs26` or `/ps26` (prespring), `/pf26` (prefall)

The `seasonSkuCodes()` function generates these. The products_slow scan checks both `sku` and `custom_sku` fields for the season code. **AS OF THE LAST SESSION, products_slow was finding 0 products for ALL seasons including active ones.** A debug log was added to the first page of products_slow to show what fields the LS API actually returns — this needs to be checked in Vercel logs after a sync runs.

**DO NOT change the product-matching strategy without first checking those logs.** The SKU format `1234/s26` SHOULD match the check for `/s26` — the issue is likely that `sku`/`custom_sku` fields aren't returned by the list API, or are named differently.

### productStats — single source of truth
`productStats[pid] = { ordered, orderedCost, received, receivedCost, retVal, retCost, soldAmt, saleAmt, sold, onSale, returned }`

- `sold` and `onSale` are mutually exclusive (discounted sales go ONLY to onSale, not both)
- Customer returns subtract from whichever bucket the item sold from (discounted → onSale, full price → sold)
- `saleAmt` = actual discounted sale dollars (used in color key, NOT retail price × qty)
- `soldAmt` = net sale dollars (can be negative for net-return products)

### Cron / Scan Loop
- `vercel.json` cron fires daily at 8am: `GET /api/cron/scan`
- UI "Sync from LS" button POSTs to `/api/cron/scan` in a loop
- First call: `?force=1&restart=1` — restarts all seasons fresh
- Subsequent calls: `?force=1` — advances in-progress seasons, SKIPS seasons completed within 1 hour
- Concurrency: 3 seasons at a time (avoids LS rate limits)
- 429/503 from LS: exponential backoff, up to 4 retries (2s, 4s, 8s, 16s)
- cron/scan and cron/delta maxDuration: 300s; step.js: 60s

### Delta Sync
There is a separate delta/sales-only sync (`/api/cron/delta`) that runs throughout the day for incremental sales updates. DO NOT break this when changing the product scan logic.

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

## UI Behavior
- Season navigation: changing seasons keeps the user on the same drilldown view (dept or vendor). Falls back to dept list if vendor doesn't exist in new season, falls back to summary if dept doesn't exist.
- Color key uses actual `saleAmt` for on-sale items (not retail price × qty).
- Sold column: full-price sales only. On Sale column: discounted sales only.

## What's Currently Broken / In Progress
1. **products_slow finding 0 products** — debug log added, need to check Vercel logs after a sync to see actual LS API field names on product objects.
2. **Judi Powers spring26 returns** — not investigated yet.

## What NOT To Do
- Do not remove the 6h KV TTL (was 1h before, caused state loss on long scans)
- Do not use `force=1` to bypass the 1-hour rescan interval on completed seasons (use `restart=1` on first call only)
- Do not scan all 83k products for 2027 seasons and error — complete gracefully with empty data
- Do not put discounted items in both Sold and On Sale columns
- Do not use retail price in the color key for on-sale items — use actual saleAmt
